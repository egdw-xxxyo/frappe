import KanbanSettings from "./kanban_settings";

frappe.provide("frappe.views");

frappe.views.KanbanView = class KanbanView extends frappe.views.ListView {
	static full_page = true;
	static no_sidebar = true;

	static load_last_view() {
		const route = frappe.get_route();
		if (route.length === 3) {
			const doctype = route[1];
			const scope_value = frappe.views.KanbanView.get_current_scope_value(doctype);
			const last_board = frappe.views.KanbanView.get_last_board(doctype, scope_value);
			if (!last_board) {
				return new frappe.views.KanbanView({ doctype: doctype });
			}

			route.push(last_board);
			frappe.set_route(route);
			return true;
		}
		return false;
	}

	get view_name() {
		return "Kanban";
	}

	show() {
		const scope_value = frappe.views.KanbanView.get_current_scope_value(this.doctype);

		frappe.views.KanbanView.get_kanbans(this.doctype).then((kanbans) => {
			frappe.route_options = {};
			if (!kanbans.length) {
				return frappe.views.KanbanView.show_kanban_dialog(this.doctype, scope_value);
			} else if (kanbans.length && frappe.get_route().length !== 4) {
				return frappe.views.KanbanView.route_to_board(this.doctype, kanbans, scope_value);
			} else {
				this.kanbans = kanbans;

				return frappe.run_serially([
					() => this.show_skeleton(),
					() => this.fetch_meta(),
					() => this.hide_skeleton(),
					() => this.check_permissions(),
					() => this.init(),
					() => this.before_refresh(),
					() => this.refresh(),
				]);
			}
		});
	}

	init() {
		return super.init().then(() => {
			let menu_length = this.page.menu.find(".dropdown-item").length;
			if (menu_length === 1) {
				// Only 'Refresh' (hidden) is present (always), dropdown is visibly empty
				this.page.hide_menu();
			}
		});
	}

	setup_defaults() {
		return super.setup_defaults().then(() => {
			let get_board_name = () => {
				return this.kanbans.length && this.kanbans[0].name;
			};

			this.board_name = frappe.get_route()[3] || get_board_name() || null;
			this.page_title = __(this.board_name);
			this.card_meta = this.get_card_meta();
			this.page_length = 0;

			return frappe.run_serially([
				() => this.set_board_perms_and_push_menu_items(),
				() => this.get_board(),
			]);
		});
	}

	set_board_perms_and_push_menu_items() {
		// needs server-side call as client-side document instance is absent before kanban render
		return frappe.call({
			method: "frappe.client.get_doc_permissions",
			args: {
				doctype: "Kanban Board",
				docname: this.board_name,
			},
			callback: (result) => {
				this.board_perms = result.message.permissions || {};
				this.push_menu_items();
			},
		});
	}

	push_menu_items() {
		if (this.board_perms.write) {
			this.menu_items.push({
				label: __("Save filters"),
				action: () => {
					this.save_kanban_board_filters();
				},
			});
		}

		if (this.board_perms.delete) {
			this.menu_items.push({
				label: __("Delete Kanban Board"),
				action: () => {
					frappe.confirm(__("Are you sure you want to proceed?"), () => {
						frappe.db.delete_doc("Kanban Board", this.board_name).then(() => {
							frappe.show_alert(`Kanban Board ${this.board_name} deleted.`);
							frappe.set_route("List", this.doctype, "List");
						});
					});
				},
			});
		}
	}

	setup_result_container_area() {
		// pass
	}

	setup_result_area() {
		this.$result = $(`<div class="result">`);
		this.$frappe_list.append(this.$result);
	}

	setup_paging_area() {
		// pass
	}

	set_result_height() {
		// pass
	}

	toggle_result_area() {
		this.$result.toggle(this.data.length > 0);
	}

	get_board() {
		return frappe.db.get_doc("Kanban Board", this.board_name).then((board) => {
			this.board = board;
			this.board.filters_array = JSON.parse(this.board.filters || "[]");
			this.board.fields = JSON.parse(this.board.fields || "[]");
			this.filters = this.board.filters_array;
		});
	}

	setup_page() {
		this.hide_page_form = true;
		this.hide_card_layout = true;
		this.hide_sort_selector = true;
		super.setup_page();
	}

	setup_view() {
		if (this.board.columns.filter((col) => col.status !== "Archived").length > 4) {
			this.page.container.addClass("full-width");
		}
		this.setup_realtime_updates();
		this.setup_like();
	}

	set_fields() {
		// Fetch only required + Kanban Board configured fields (optimization: avoid fetching all doctype fields)
		this.fields = [];
		// Core: identity and column
		this._add_field("name");
		this._add_field("creation");
		this._add_field(this.board.field_name, this.board.reference_doctype);
		this._add_field(this.card_meta.title_field);
		// Card UI: assignments, tags, like, comment count
		this._add_field("_assign");
		this._add_field("_user_tags");
		this._add_field("_liked_by");
		this._add_field("_comments");
		this._add_field("owner");
		// Kanban Board document's configured fields (card body content)
		if (this.board.fields && Array.isArray(this.board.fields)) {
			this.board.fields.forEach((field_spec) => {
				const fieldname =
					typeof field_spec === "string" ? field_spec : field_spec?.fieldname;
				if (fieldname) this._add_field(fieldname);
			});
		}
		// Optional: image and color if doctype has them
		if (this.meta.image_field) this._add_field(this.meta.image_field);
		if (frappe.meta.has_field(this.doctype, "color")) this._add_field("color");
	}

	before_render() {
		frappe.model.user_settings.save(this.doctype, "last_view", this.view_name);

		this.save_view_user_settings({
			last_kanban_board: this.board_name,
			last_kanban_board_scope: frappe.views.KanbanView.get_board_scope_value(
				this.doctype,
				this.board
			),
		});
	}

	render_list() {}

	on_filter_change() {
		if (!this.board_perms.write) return; // avoid misleading ux

		if (JSON.stringify(this.board.filters_array) !== JSON.stringify(this.filter_area.get())) {
			this.page.set_indicator(__("Not Saved"), "orange");
		} else {
			this.page.clear_indicator();
		}
	}

	save_kanban_board_filters() {
		const filters = this.filter_area.get();

		frappe.db.set_value("Kanban Board", this.board_name, "filters", filters).then((r) => {
			if (r.exc) {
				frappe.show_alert({
					indicator: "red",
					message: __("There was an error saving filters"),
				});
				return;
			}
			frappe.show_alert({
				indicator: "green",
				message: __("Filters saved"),
			});

			this.board.filters_array = filters;
			this.on_filter_change();
		});
	}

	get_fields() {
		// board.field_name already added in set_fields(); just return built field list
		return super.get_fields();
	}

	render() {
		const board_name = this.board_name;
		if (!this.kanban) {
			this.kanban = new frappe.views.KanbanBoard({
				doctype: this.doctype,
				board: this.board,
				board_name: board_name,
				cards: this.data,
				card_meta: this.card_meta,
				wrapper: this.$result,
				cur_list: this,
				user_settings: this.view_user_settings,
			});
		} else if (board_name === this.kanban.board_name) {
			this.$result.empty();
			this.kanban.update(this.data);
		}
	}

	get_card_meta() {
		var meta = frappe.get_meta(this.doctype);
		// preserve route options erased by new doc
		let route_options = { ...frappe.route_options };
		var doc = frappe.model.get_new_doc(this.doctype);
		frappe.route_options = route_options;
		var title_field = null;
		var quick_entry = false;

		if (this.meta.title_field) {
			title_field = frappe.meta.get_field(this.doctype, this.meta.title_field);
		}

		this.meta.fields.forEach((df) => {
			const is_valid_field =
				["Data", "Text", "Small Text", "Text Editor"].includes(df.fieldtype) && !df.hidden;

			if (is_valid_field && !title_field) {
				// can be mapped to textarea
				title_field = df;
			}
		});

		// quick entry
		var mandatory = meta.fields.filter((df) => df.reqd && !doc[df.fieldname]);

		if (
			mandatory.some((df) => frappe.model.table_fields.includes(df.fieldtype)) ||
			mandatory.length > 1
		) {
			quick_entry = true;
		}

		if (!title_field) {
			title_field = frappe.meta.get_field(this.doctype, "name");
		}

		return {
			quick_entry: quick_entry,
			title_field: title_field,
		};
	}

	get_view_settings() {
		return {
			label: __("Kanban Settings", null, "Button in kanban view menu"),
			action: () => this.show_kanban_settings(),
			standard: true,
		};
	}

	show_kanban_settings() {
		frappe.model.with_doctype(this.doctype, () => {
			new KanbanSettings({
				kanbanview: this,
				doctype: this.doctype,
				settings: this.board,
				meta: frappe.get_meta(this.doctype),
			});
		});
	}

	get required_libs() {
		return "kanban_board.bundle.js";
	}
};

frappe.views.KanbanView.get_kanbans = function (doctype) {
	let kanbans = [];

	return get_kanban_boards().then((kanban_boards) => {
		if (kanban_boards) {
			kanban_boards.forEach((board) => {
				let route = `/desk/${frappe.router.slug(board.reference_doctype)}/view/kanban/${
					board.name
				}`;
				kanbans.push({ name: board.name, route: route, filters: board.filters });
			});
		}

		return kanbans;
	});

	function get_kanban_boards() {
		return frappe
			.call("frappe.desk.doctype.kanban_board.kanban_board.get_kanban_boards", { doctype })
			.then((r) => r.message);
	}
};

frappe.views.KanbanView.get_board_scope_field = function (doctype) {
	return doctype === "Task" ? "project" : null;
};

frappe.views.KanbanView.get_filter_value = function (filters, fieldname) {
	if (!fieldname) return null;

	let parsed = filters;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed || "[]");
		} catch (error) {
			return null;
		}
	}

	if (!parsed) return null;
	if (!Array.isArray(parsed)) return parsed[fieldname] ?? null;

	const row = parsed.find(
		(filter) => Array.isArray(filter) && filter.at(-3) === fieldname && filter.at(-2) === "="
	);
	return row ? row.at(-1) : null;
};

frappe.views.KanbanView.get_board_scope_value = function (doctype, board) {
	return (
		frappe.views.KanbanView.get_filter_value(
			board.filters,
			frappe.views.KanbanView.get_board_scope_field(doctype)
		) || ""
	);
};

frappe.views.KanbanView.get_current_scope_value = function (doctype, list_view) {
	const scope_field = frappe.views.KanbanView.get_board_scope_field(doctype);
	const view = list_view || (window.cur_list?.doctype === doctype ? window.cur_list : null);
	if (!scope_field || !view?.filter_area) return "";

	return frappe.views.KanbanView.get_filter_value(view.filter_area.get(), scope_field) || "";
};

frappe.views.KanbanView.get_last_board = function (doctype, scope_value) {
	const settings = frappe.get_user_settings(doctype)["Kanban"] || {};
	if ((settings.last_kanban_board_scope || "") !== (scope_value || "")) return null;

	return settings.last_kanban_board || null;
};

frappe.views.KanbanView.select_board = function (doctype, kanbans, scope_value) {
	const scope = scope_value || "";
	const in_scope = kanbans.filter(
		(board) => frappe.views.KanbanView.get_board_scope_value(doctype, board) === scope
	);
	if (!in_scope.length) return null;

	const last_board = frappe.views.KanbanView.get_last_board(doctype, scope);
	if (in_scope.some((board) => board.name === last_board)) return last_board;

	return in_scope.map((board) => board.name).sort()[0];
};

frappe.views.KanbanView.route_to_board = function (doctype, kanbans, scope_value) {
	const board_name = frappe.views.KanbanView.select_board(doctype, kanbans, scope_value);
	if (board_name) {
		return frappe.set_route("List", doctype, "Kanban", board_name);
	}

	if (scope_value) {
		return frappe.views.KanbanView.show_kanban_dialog(doctype, scope_value);
	}

	return frappe.views.KanbanView.show_board_picker(doctype, kanbans);
};

frappe.views.KanbanView.show_board_picker = function (doctype, kanbans) {
	const dialog = new frappe.ui.Dialog({
		title: __("Select Kanban Board"),
		fields: [
			{
				fieldtype: "Select",
				fieldname: "board_name",
				label: __("Kanban Board"),
				options: kanbans.map((board) => board.name),
				default: kanbans[0].name,
				reqd: 1,
			},
		],
		primary_action_label: __("Open"),
		primary_action: (values) => {
			dialog.hide();
			frappe.set_route("List", doctype, "Kanban", values.board_name);
		},
		secondary_action_label: __("Create New Kanban Board"),
		secondary_action: () => {
			dialog.hide();
			frappe.views.KanbanView.show_kanban_dialog(doctype);
		},
	});

	dialog.show();
};

frappe.views.KanbanView.show_kanban_dialog = function (doctype, scope_value) {
	let dialog = new_kanban_dialog();
	dialog.show();

	function make_kanban_board(board_name, field_name, project) {
		return frappe.call({
			method: "frappe.desk.doctype.kanban_board.kanban_board.quick_kanban_board",
			args: {
				doctype,
				board_name,
				field_name,
				project,
			},
			callback: function (r) {
				var kb = r.message;
				if (kb.filters) {
					frappe.provide("frappe.kanban_filters");
					frappe.kanban_filters[kb.kanban_board_name] = kb.filters;
				}
				frappe.set_route("List", doctype, "Kanban", kb.kanban_board_name);
			},
		});
	}

	function new_kanban_dialog() {
		/* Kanban dialog can show either "Save" or "Customize Form" option depending if any Select fields exist in the DocType for Kanban creation
		 */

		const select_fields = frappe.get_meta(doctype).fields.filter((df) => {
			return df.fieldtype === "Select" && df.fieldname !== "kanban_column";
		});
		const dialog_fields = get_fields_for_dialog(select_fields);
		const to_save = select_fields.length > 0;
		const primary_action_label = to_save ? __("Save") : __("Customize Form");
		const dialog_title = to_save ? __("New Kanban Board") : __("No Select Field Found");

		let primary_action = () => {
			if (to_save) {
				const values = dialog.get_values();
				make_kanban_board(values.board_name, values.field_name, values.project).then(
					() => dialog.hide(),
					(err) => frappe.msgprint(err)
				);
			} else {
				frappe.set_route("Form", "Customize Form", { doc_type: doctype });
			}
		};

		return new frappe.ui.Dialog({
			title: dialog_title,
			fields: dialog_fields,
			primary_action_label,
			primary_action,
		});
	}

	function get_fields_for_dialog(select_fields) {
		if (!select_fields.length) {
			return [
				{
					fieldtype: "HTML",
					options: `
					<div>
						<p class="text-medium">
						${__(
							'No fields found that can be used as a Kanban Column. Use the Customize Form to add a Custom Field of type "Select".'
						)}
						</p>
					</div>
				`,
				},
			];
		}

		let fields = [
			{
				fieldtype: "Data",
				fieldname: "board_name",
				label: __("Kanban Board Name"),
				reqd: 1,
				description: ["Note", "ToDo"].includes(doctype)
					? __("This Kanban Board will be private")
					: "",
			},
			{
				fieldtype: "Select",
				fieldname: "field_name",
				label: __("Columns based on"),
				options: select_fields.map((df) => ({ label: df.label, value: df.fieldname })),
				default: select_fields[0],
				reqd: 1,
			},
		];

		if (doctype === "Task") {
			fields.push({
				fieldtype: "Link",
				fieldname: "project",
				label: __("Project"),
				options: "Project",
				default: scope_value || "",
			});
		}

		return fields;
	}
};
