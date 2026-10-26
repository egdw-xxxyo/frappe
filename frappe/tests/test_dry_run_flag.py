import frappe
from frappe.deferred_insert import deferred_insert
from frappe.tests import IntegrationTestCase
from frappe.utils.background_jobs import enqueue
from frappe.utils.global_search import update_global_search


class Recorder:
	def __init__(self):
		self.skipped = []

	def skip(self, kind, detail):
		self.skipped.append((kind, str(detail)))

	def refuse(self, kind):
		raise frappe.ValidationError(kind)


class TestDryRunFlag(IntegrationTestCase):
	def setUp(self):
		self.recorder = Recorder()
		frappe.flags.dry_run = self.recorder

	def tearDown(self):
		frappe.flags.dry_run = None

	def test_side_effects_are_skipped(self):
		enqueue("frappe.ping")
		frappe.publish_realtime("dry_run_probe")
		update_global_search(frappe.get_doc("User", "Administrator"))
		deferred_insert("Route History", [{"route": "dry-run-probe"}])
		self.assertEqual(
			[kind for kind, _detail in self.recorder.skipped],
			["enqueue", "realtime", "global_search", "deferred_insert"],
		)

	def test_enqueue_now_still_runs(self):
		self.assertEqual(enqueue("frappe.ping", now=True), "pong")
		self.assertEqual(self.recorder.skipped, [])

	def test_ddl_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			frappe.db.sql_ddl("select 1")
