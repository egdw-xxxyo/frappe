// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// MIT License. See license.txt

frappe.ui.form.Share = class Share {
	constructor(opts) {
		$.extend(this, opts);
		this.shares = this.parent.find(".shares");
	}
	refresh() {
		this.render_sidebar();
	}
	render_sidebar() {
		const shared = this.shared || this.frm.get_docinfo().shared;
		// group shares carry no user, so they have no avatar to show
		const shared_users = shared
			.filter(Boolean)
			.map((s) => s.user)
			.filter(Boolean);

		if (this.frm.is_new()) {
			this.parent.find(".share-doc-btn").hide();
		}

		this.parent
			.find(".share-doc-btn")
			.off("click")
			.on("click", () => {
				this.frm.share_doc();
			});

		this.shares.empty();

		if (!shared_users.length) {
			this.shares.hide();
			return;
		}

		this.shares.show();
		let avatar_group = frappe.avatar_group(shared_users, 5, { align: "left", overlap: true });
		avatar_group.on("click", () => {
			this.frm.share_doc();
		});
		// REDESIGN-TODO: handle "shared with everyone"
		this.shares.append(avatar_group);
	}
	show() {
		var me = this;
		var d = new frappe.ui.Dialog({
			title: __("Share {0} with", [this.frm.doc.name]),
		});

		this.dialog = d;
		this.dirty = false;

		$(d.body).html('<p class="text-muted">' + __("Loading...") + "</p>");

		frappe.call({
			method: "frappe.share.get_users",
			args: {
				doctype: this.frm.doctype,
				name: this.frm.doc.name,
			},
			callback: function (r) {
				me.render_shared(r.message || []);
			},
		});

		d.onhide = function () {
			// reload comments
			if (me.dirty) me.frm.sidebar.reload_docinfo();
		};

		d.show();
	}
	render_shared(shared) {
		if (shared) this.shared = shared;
		var d = this.dialog;
		$(d.body).empty();

		var everyone = {};
		$.each(this.shared, function (i, s) {
			// pullout everyone record from shared list
			if (s && s.everyone) {
				everyone = s;
			}
		});

		$(
			frappe.render_template("set_sharing", {
				frm: this.frm,
				shared: this.shared,
				everyone: everyone,
			})
		).appendTo(d.body);

		if (frappe.model.can_share(null, this.frm)) {
			this.make_user_input();
			this.make_group_input();
			this.add_share_button();
			this.add_group_share_button();
			this.set_edit_share_events();
		} else {
			// if cannot share, disable sharing settings.
			$(d.body).find(".edit-share").prop("disabled", true);
		}
	}
	make_user_input() {
		// make add-user input
		this.dialog.share_with = frappe.ui.form.make_control({
			parent: $(this.dialog.body).find(".input-wrapper-add-share"),
			df: {
				fieldtype: "Link",
				label: __("Share With"),
				fieldname: "share_with",
				options: "User",
				filters: {
					user_type: "System User",
					name: ["!=", frappe.session.user],
				},
			},
			only_input: true,
			render_input: true,
		});
	}
	make_group_input() {
		// make add-group input
		this.dialog.share_with_group = frappe.ui.form.make_control({
			parent: $(this.dialog.body).find(".input-wrapper-add-group-share"),
			df: {
				fieldtype: "Link",
				label: __("Share With Group"),
				fieldname: "share_with_group",
				options: "Employee Group",
			},
			only_input: true,
			render_input: true,
		});
	}
	add_group_share_button() {
		var me = this,
			d = this.dialog;
		$(d.body)
			.find(".btn-add-group-share")
			.on("click", function () {
				var group = d.share_with_group.get_value();
				if (!group) {
					return;
				}
				frappe.call({
					method: "frappe.share.add",
					args: {
						doctype: me.frm.doctype,
						name: me.frm.doc.name,
						share_with_group: group,
						read: $(d.body).find(".add-group-share-read").prop("checked") ? 1 : 0,
						write: $(d.body).find(".add-group-share-write").prop("checked") ? 1 : 0,
						submit: $(d.body).find(".add-group-share-submit").prop("checked") ? 1 : 0,
						share: $(d.body).find(".add-group-share-share").prop("checked") ? 1 : 0,
					},
					btn: this,
					callback: function (r) {
						$.each(me.shared, function (i, s) {
							if (s && s.share_with_group === r.message.share_with_group) {
								// re-adding / remove the old share rule.
								delete me.shared[i];
							}
						});
						me.dirty = true;
						me.shared.push(r.message);
						me.render_shared();
						me.frm.shared.refresh();
					},
				});
			});
	}
	add_share_button() {
		var me = this,
			d = this.dialog;
		$(d.body)
			.find(".btn-add-share")
			.on("click", function () {
				var user = d.share_with.get_value();
				if (!user) {
					return;
				}
				frappe.call({
					method: "frappe.share.add",
					args: {
						doctype: me.frm.doctype,
						name: me.frm.doc.name,
						user: user,
						read: $(d.body).find(".add-share-read").prop("checked") ? 1 : 0,
						write: $(d.body).find(".add-share-write").prop("checked") ? 1 : 0,
						submit: $(d.body).find(".add-share-submit").prop("checked") ? 1 : 0,
						share: $(d.body).find(".add-share-share").prop("checked") ? 1 : 0,
						notify: 1,
					},
					btn: this,
					callback: function (r) {
						$.each(me.shared, function (i, s) {
							if (s && s.user === r.message.user) {
								// re-adding / remove the old share rule.
								delete me.shared[i];
							}
						});
						me.dirty = true;
						me.shared.push(r.message);
						me.render_shared();
						me.frm.shared.refresh();
					},
				});
			});
	}
	set_edit_share_events() {
		var me = this,
			d = this.dialog;
		$(d.body)
			.find(".edit-share")
			.on("click", function () {
				var user = $(this).parents(".shared-user:first").attr("data-user") || "",
					group = $(this).parents(".shared-user:first").attr("data-group") || "",
					value = $(this).prop("checked") ? 1 : 0,
					property = $(this).attr("name"),
					everyone = cint($(this).parents(".shared-user:first").attr("data-everyone"));

				frappe.call({
					method: "frappe.share.set_permission",
					args: {
						doctype: me.frm.doctype,
						name: me.frm.doc.name,
						user: user,
						share_with_group: group,
						permission_to: property,
						value: value,
						everyone: everyone,
					},
					callback: function (r) {
						var found = null;
						$.each(me.shared, function (i, s) {
							// update shared object
							if (
								s &&
								((group && s.share_with_group === group) ||
									(!group && s.user === user) ||
									(everyone && s.everyone === 1))
							) {
								if (!r.message) {
									delete me.shared[i];
								} else {
									me.shared[i] = $.extend(s, r.message);
								}
								found = true;
								return false;
							}
						});

						if (!found) {
							me.shared.push(r.message);
						}

						me.dirty = true;
						me.render_shared();
						me.frm.shared.refresh();
					},
				});
			});
	}
};
