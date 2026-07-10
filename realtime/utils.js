const request = require("superagent");

function get_url(socket, path) {
	if (!path) {
		path = "";
	}
	// In containerized deployments the websocket service cannot resolve the
	// browser-facing Origin (e.g. http://localhost:8080) back to the backend.
	// Allow overriding the auth-callback base via FRAPPE_BACKEND_URL.
	const override = process.env.FRAPPE_BACKEND_URL;
	if (override) {
		return override.replace(/\/+$/, "") + path;
	}
	return socket.request.headers.origin + path;
}

// Authenticates a partial request created using superagent
function frappe_request(path, socket) {
	let partial_req = request.get(get_url(socket, path));
	// When using FRAPPE_BACKEND_URL we bypass nginx which normally injects
	// X-Frappe-Site-Name; set it ourselves so the backend resolves the site.
	if (process.env.FRAPPE_BACKEND_URL) {
		partial_req = partial_req.set(
			"X-Frappe-Site-Name",
			process.env.FRAPPE_SITE_NAME_HEADER || socket.site_name || "frontend"
		);
	}
	if (socket.authorization_header) {
		return partial_req.set("Authorization", socket.authorization_header);
	} else if (socket.sid) {
		return partial_req.query({ sid: socket.sid });
	}
}

module.exports = {
	get_url,
	frappe_request,
};
