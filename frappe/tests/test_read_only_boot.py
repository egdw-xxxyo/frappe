import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils.change_log import get_change_log


class TestReadOnlyBoot(IntegrationTestCase):
	def setUp(self):
		frappe.db.set_value("User", "Administrator", "last_known_versions", None, update_modified=False)
		frappe.flags.read_only = True

	def tearDown(self):
		frappe.flags.read_only = False

	def test_change_log_does_not_write_in_read_only_mode(self):
		self.assertEqual(get_change_log("Administrator"), [])
		self.assertIsNone(frappe.db.get_value("User", "Administrator", "last_known_versions"))
