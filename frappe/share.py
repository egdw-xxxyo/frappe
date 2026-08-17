# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE

from typing import TYPE_CHECKING

import frappe
from frappe import _
from frappe.desk.doctype.notification_log.notification_log import (
	enqueue_create_notification,
	get_title,
	get_title_html,
)
from frappe.desk.form.document_follow import follow_document
from frappe.utils import cint

if TYPE_CHECKING:
	from frappe.model.document import Document


#: Upper bound on how many document names a single inheritance hop may expand to.
#: `db_query` inlines shared names into SQL as `name in ('A', 'B', ...)`, so an
#: unbounded expansion would produce a pathological query.
SHARE_INHERITANCE_LIMIT = 5000

#: Redis hash holding `user -> [group, ...]` for group shares.
USER_GROUPS_CACHE_KEY = "docshare_user_groups"


@frappe.whitelist()
def add(
	doctype,
	name,
	user=None,
	read=1,
	write=0,
	submit=0,
	share=0,
	everyone=0,
	notify=0,
	share_with_group=None,
):
	"""Expose function without flags to the client-side"""
	return add_docshare(
		doctype,
		name,
		user=user,
		read=read,
		write=write,
		submit=submit,
		share=share,
		everyone=everyone,
		notify=notify,
		share_with_group=share_with_group,
	)


def add_docshare(
	doctype,
	name,
	user=None,
	read=1,
	write=0,
	submit=0,
	share=0,
	everyone=0,
	flags=None,
	notify=0,
	share_with_group=None,
):
	"""Share the given document with a user or with an employee group."""
	if not user and not everyone and not share_with_group:
		user = frappe.session.user

	share_perms = {
		# always add read, since you are adding!
		"read": 1,
		"write": cint(write),
		"submit": cint(submit),
		"share": cint(share),
	}

	if not (flags or {}).get("ignore_share_permission"):
		check_share_permission(doctype, name, share_perms)

	if share_name := get_share_name(doctype, name, user, everyone, share_with_group=share_with_group):
		doc = frappe.get_doc("DocShare", share_name)
	else:
		doc = frappe.new_doc("DocShare")
		doc.update(
			{
				"user": user,
				"share_with_group": share_with_group,
				"share_doctype": doctype,
				"share_name": name,
				"everyone": cint(everyone),
			}
		)

	if flags:
		doc.flags.update(flags)

	doc.update(share_perms)
	doc.save(ignore_permissions=True)
	notify_assignment(user, doctype, name, everyone, notify=notify)

	if (
		user
		and (user != name or doctype != "User")
		and frappe.get_cached_value("User", user, "follow_shared_documents")
	):
		follow_document(doctype, name, user)

	return doc


def remove(doctype, name, user, flags=None, share_with_group=None):
	share_filters = {"share_name": name, "share_doctype": doctype}
	if share_with_group:
		share_filters["share_with_group"] = share_with_group
	else:
		share_filters["user"] = user

	share_name = frappe.db.get_value("DocShare", share_filters)

	if share_name:
		frappe.delete_doc("DocShare", share_name, flags=flags)


@frappe.whitelist()
def set_permission(doctype, name, user, permission_to, value=1, everyone=0, share_with_group=None):
	"""Expose function without flags to the client-side"""
	return set_docshare_permission(
		doctype,
		name,
		user,
		permission_to,
		value=value,
		everyone=everyone,
		share_with_group=share_with_group,
	)


def set_docshare_permission(
	doctype, name, user, permission_to, value=1, everyone=0, flags=None, share_with_group=None
):
	"""Set share permission."""
	if not (flags or {}).get("ignore_share_permission"):
		permissions = {permission_to: value} if cint(value) else None
		check_share_permission(doctype, name, permissions)

	share_name = get_share_name(doctype, name, user, everyone, share_with_group=share_with_group)
	value = int(value)

	if not share_name:
		if value:
			share = add_docshare(
				doctype,
				name,
				user,
				everyone=everyone,
				share_with_group=share_with_group,
				**{permission_to: 1},
				flags=flags,
			)
		else:
			# no share found, nothing to remove
			share = None

	else:
		share = frappe.get_doc("DocShare", share_name)
		if flags:
			share.flags.update(flags)
		share.flags.ignore_permissions = True
		share.set(permission_to, value)

		if not value:
			# un-set higher-order permissions too
			if permission_to == "read":
				share.read = share.write = share.submit = share.share = 0

		share.save()

		if not (share.read or share.write or share.submit or share.share):
			share.delete()
			share = None

	return share


@frappe.whitelist()
def get_users(doctype: str, name: str) -> list:
	"""Get list of users with which this document is shared"""
	doc = frappe.get_doc(doctype, name)
	return _get_users(doc)


def _get_users(doc: "Document") -> list:
	from frappe.permissions import has_permission

	if not has_permission(doc.doctype, "read", doc, raise_exception=False):
		return []

	return frappe.get_all(
		"DocShare",
		fields=[
			"name",
			"user",
			"share_with_group",
			"read",
			"write",
			"submit",
			"share",
			"everyone",
			"owner",
			"creation",
		],
		filters=dict(share_doctype=doc.doctype, share_name=str(doc.name)),
	)


def get_user_groups(user=None) -> list[str]:
	"""Return the employee groups the given user belongs to.

	The membership table already carries `user_id`, so no Employee -> User resolution is
	needed. Cached per user because this is hit on every list query that involves shares;
	the cache is cleared from the Employee Group controller.
	"""
	if not user:
		user = frappe.session.user

	if user in ("Guest", "Administrator"):
		return []

	def _fetch():
		if not frappe.db.table_exists("Employee Group Table"):
			# frappe running without erpnext installed
			return []

		return frappe.get_all(
			"Employee Group Table",
			filters={"parenttype": "Employee Group", "user_id": user},
			pluck="parent",
			distinct=True,
		)

	return frappe.cache.hget(USER_GROUPS_CACHE_KEY, user, _fetch) or []


def clear_user_groups_cache(user=None):
	"""Drop the cached group membership, for one user or for everybody."""
	if user:
		frappe.cache.hdel(USER_GROUPS_CACHE_KEY, user)
	else:
		frappe.cache.delete_key(USER_GROUPS_CACHE_KEY)


def get_shared(doctype, user=None, rights=None, *, filters=None, limit=None, _seen=None):
	"""Get list of shared document names for given user and DocType.

	Covers three ways a document can reach a user: shared with the user directly, shared
	with `everyone`, or shared with an employee group the user belongs to. On top of that,
	access is inherited from a parent document when the `share_access_inheritance` hook
	declares a link (e.g. a Task is reachable through its Project).

	:param doctype: DocType of which shared names are queried.
	:param user: User for which shared names are queried.
	:param rights: List of rights for which the document is shared. List of `read`, `write`, `share`"""

	if not user:
		user = frappe.session.user

	if not rights:
		rights = ["read"]

	names = get_directly_shared(doctype, user, rights, filters=filters, limit=limit)

	# `limit` is used by callers as an existence check, so skip the extra work once satisfied
	if limit and len(names) >= cint(limit):
		return names

	if inherited := get_inherited_shared(doctype, user, rights, filters=filters, _seen=_seen):
		seen = set(names)
		names += [name for name in inherited if name not in seen]

		if limit:
			names = names[: cint(limit)]

	return names


def get_directly_shared(doctype, user, rights, *, filters=None, limit=None) -> list[str]:
	"""Names of documents carrying a DocShare row for this user, everyone, or one of the user's groups."""
	share_filters = [[right, "=", 1] for right in rights]
	share_filters += [["share_doctype", "=", doctype]]
	if filters:
		share_filters += filters

	or_filters = [["user", "=", user]]
	if user != "Guest":
		or_filters += [["everyone", "=", 1]]

		if groups := get_user_groups(user):
			or_filters += [["share_with_group", "in", groups]]

	shared_docs = frappe.get_all(
		"DocShare",
		fields=["share_name"],
		filters=share_filters,
		or_filters=or_filters,
		order_by=None,
		limit_page_length=limit,
	)

	return [doc.share_name for doc in shared_docs]


def get_inheritance_rules(doctype) -> list[dict]:
	"""Rules declaring that `doctype` inherits access from a parent document.

	Declared by apps via the `share_access_inheritance` hook, e.g.::

	    share_access_inheritance = [
	        {"doctype": "Task", "fieldname": "project", "parent_doctype": "Project"},
	    ]
	"""
	rules = frappe.get_hooks("share_access_inheritance") or []
	return [rule for rule in rules if rule.get("doctype") == doctype]


def get_inherited_shared(doctype, user, rights, *, filters=None, _seen=None) -> list[str]:
	"""Names reachable because a parent document is shared with the user."""
	rules = get_inheritance_rules(doctype)
	if not rules:
		return []

	_seen = (_seen or set()) | {doctype}
	wanted = get_requested_share_name(filters)
	names = set()

	for rule in rules:
		parent_doctype = rule.get("parent_doctype")
		fieldname = rule.get("fieldname")

		if not parent_doctype or not fieldname:
			continue

		if not frappe.db.has_column(doctype, fieldname):
			continue

		if parent_doctype == doctype:
			names |= expand_self_referential(doctype, fieldname, user, rights, wanted)
			continue

		# a cycle across doctypes would otherwise recurse forever
		if parent_doctype in _seen:
			continue

		parent_names = get_shared(parent_doctype, user, rights, _seen=_seen)
		if not parent_names:
			continue

		names |= fetch_children(doctype, fieldname, parent_names, wanted)

	return list(names)


def expand_self_referential(doctype, fieldname, user, rights, wanted, max_depth=10) -> set:
	"""Walk a self-referential link (e.g. `Task.parent_task`) down from the shared documents."""
	frontier = set(get_directly_shared(doctype, user, rights))
	found = set()

	for _depth in range(max_depth):
		if not frontier:
			break

		children = fetch_children(doctype, fieldname, list(frontier), None)
		children -= found | frontier

		if not children:
			break

		found |= children
		frontier = children

	if wanted:
		found &= {wanted}

	return found


def fetch_children(doctype, fieldname, parent_names, wanted) -> set:
	"""Names of `doctype` documents whose `fieldname` points at one of `parent_names`."""
	if len(parent_names) > SHARE_INHERITANCE_LIMIT:
		frappe.log_error(
			title="Share inheritance truncated",
			message=(
				f"{doctype}.{fieldname} expanded to {len(parent_names)} parents, "
				f"truncated to {SHARE_INHERITANCE_LIMIT}. Some documents may be hidden."
			),
		)
		parent_names = parent_names[:SHARE_INHERITANCE_LIMIT]

	child_filters = {fieldname: ("in", parent_names)}
	if wanted:
		child_filters["name"] = wanted

	return set(
		frappe.get_all(
			doctype,
			filters=child_filters,
			pluck="name",
			order_by=None,
			limit_page_length=SHARE_INHERITANCE_LIMIT,
		)
	)


def get_requested_share_name(filters):
	"""Pull the `share_name = X` filter out, the only filter callers of `get_shared` ever pass.

	Inherited names do not come from `tabDocShare` rows, so DocShare filters cannot be
	applied to them by the database; this one is re-applied by hand instead.
	"""
	for f in filters or []:
		if len(f) == 3 and f[0] == "share_name" and f[1] == "=":
			return f[2]

	return None


def get_shared_doctypes(user=None):
	"""Return list of doctypes in which documents are shared for the given user."""
	if not user:
		user = frappe.session.user

	table = frappe.qb.DocType("DocShare")
	condition = (table.user == user) | (table.everyone == 1)

	if groups := get_user_groups(user):
		condition = condition | table.share_with_group.isin(groups)

	query = frappe.qb.from_(table).where(condition).select(table.share_doctype).distinct()

	return query.run(pluck=True)


def get_share_name(doctype, name, user, everyone, share_with_group=None):
	if cint(everyone):
		share_filters = {"everyone": 1, "share_name": name, "share_doctype": doctype}
	elif share_with_group:
		share_filters = {
			"share_with_group": share_with_group,
			"share_name": name,
			"share_doctype": doctype,
		}
	else:
		share_filters = {"user": user, "share_name": name, "share_doctype": doctype}

	return frappe.db.get_value("DocShare", share_filters)


def check_share_permission(doctype, name, permissions=None):
	"""Check if the user can share with other users and has the permissions they are trying to grant.

	:param doctype: DocType being shared
	:param name: Document name being shared
	:param permissions: Permissions that the user wants to share
	"""
	if not frappe.has_permission(doctype, ptype="share", doc=name):
		frappe.throw(
			_("No permission to {0} {1} {2}").format("share", _(doctype), name), frappe.PermissionError
		)

	# If permissions specified, validate that the user has those permissions
	if not permissions:
		return

	# Validate user has the permissions they're trying to grant
	restricted_permissions = ["read", "write", "submit"]

	doc = frappe.get_doc(doctype, name)

	for ptype in restricted_permissions:
		if cint(permissions.get(ptype)) and not frappe.has_permission(doctype, ptype, doc=doc):
			frappe.throw(
				_("You cannot share `{0}` on {1} `{2}` as you do not have `{0}` permission on `{1}`").format(
					_(ptype), _(doctype), name
				),
				frappe.PermissionError,
			)


def notify_assignment(shared_by, doctype, doc_name, everyone, notify=0):
	if not (shared_by and doctype and doc_name) or everyone or not notify:
		return

	from frappe.utils import get_fullname

	title = get_title(doctype, doc_name)

	reference_user = get_fullname(frappe.session.user)
	notification_message = _("{0} shared a document {1} {2} with you").format(
		frappe.bold(reference_user), frappe.bold(_(doctype)), get_title_html(title)
	)

	notification_doc = {
		"type": "Share",
		"document_type": doctype,
		"subject": notification_message,
		"document_name": doc_name,
		"from_user": frappe.session.user,
	}

	enqueue_create_notification(shared_by, notification_doc)
