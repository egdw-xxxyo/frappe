const { get_conf } = require("../node_utils");
const conf = get_conf();

function get_url(socket, path) {
	if (!path) {
		path = "";
	}
	// In containerized deployments the websocket service cannot resolve the
	// browser-facing Origin back to the backend: nginx rewrites it to the site
	// name (e.g. http://frontend), which resolves to port 80 while the frontend
	// listens on 8080, so the auth callback never reaches the backend and every
	// socket is rejected as Unauthorized. Allow overriding the callback base via
	// FRAPPE_BACKEND_URL (set on the websocket service in docker-compose.yml).
	const override = process.env.FRAPPE_BACKEND_URL;
	if (override) {
		return override.replace(/\/+$/, "") + path;
	}
	let url = socket.request.headers.origin;
	if (conf.developer_mode) {
		let [protocol, host, port] = url.split(":");
		port = conf.webserver_port;
		url = `${protocol}:${host}:${port}`;
	}
	return url + path;
}

module.exports = {
	get_url,
};
