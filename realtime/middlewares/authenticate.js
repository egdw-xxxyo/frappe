const cookie = require("cookie");
const { get_conf, get_redis_subscriber } = require("../../node_utils");
const { get_url } = require("../utils");
const conf = get_conf();
const redisClient = get_redis_subscriber("redis_queue");

async function getSecretFromRedis() {
	if (!redisClient.isOpen) await redisClient.connect();
	const val = await redisClient.get("socketio_auth_secret");
	return val;
}

function authenticate_with_frappe(socket, next) {
	let namespace = socket.nsp.name;
	namespace = namespace.slice(1, namespace.length); // remove leading `/`

	if (namespace != get_site_name(socket)) {
		// Without the return the middleware keeps running and calls next() again at the
		// end, which accepts the socket into a namespace nothing is ever published to
		// (the server emits into `/<sitename>`, see realtime/index.js). The client then
		// looks connected and silently receives no events.
		next(new Error("Invalid namespace"));
		return;
	}

	// nginx in the container deployment rewrites Origin to a fixed
	// `<proto>://${FRAPPE_SITE_NAME_HEADER}` while forwarding the browser's own Host,
	// so the two never match when the site is reached by IP or by any hostname other
	// than the site name — every socket is then rejected as "Invalid origin". The
	// comparison guards against cross-origin sockets in browser-facing setups; behind
	// that proxy it compares two values nginx itself produced, so skip it there.
	if (
		!process.env.FRAPPE_BACKEND_URL &&
		get_hostname(socket.request.headers.host) != get_hostname(socket.request.headers.origin)
	) {
		next(new Error("Invalid origin"));
		return;
	}

	if (!socket.request.headers.cookie && !socket.request.headers.authorization) {
		next(
			new Error(
				"Missing cookie and authorization header. Either one needed for authentication."
			)
		);
		return;
	}

	let cookies = cookie.parse(socket.request.headers.cookie || "");
	let authorization_header = socket.request.headers.authorization;

	if (!cookies.sid && !authorization_header) {
		next(new Error("No authentication method used. Use cookie or authorization header."));
		return;
	}
	socket.sid = cookies.sid;
	socket.authorization_header = authorization_header;

	socket.frappe_request = async (path, args = {}, opts = {}) => {
		let query_args = new URLSearchParams(args);
		if (query_args.toString()) {
			path = path + "?" + query_args.toString();
		}

		let headers = {};
		if (socket.authorization_header) {
			headers["Authorization"] = socket.authorization_header;
		} else if (socket.sid) {
			headers["Cookie"] = `sid=${socket.sid}`;
		}
		const secret = await getSecretFromRedis();
		if (secret) {
			headers["X-Frappe-Socket-Secret"] = secret;
		}
		if (process.env.FRAPPE_BACKEND_URL) {
			// Talking to the backend directly bypasses nginx, which is what normally
			// injects this header, so the backend would not know which site to resolve.
			headers["X-Frappe-Site-Name"] =
				process.env.FRAPPE_SITE_NAME_HEADER || get_site_name(socket);
		}
		return fetch(get_url(socket, path), {
			...opts,
			headers,
		});
	};

	socket
		.frappe_request("/api/method/frappe.realtime.get_user_info")
		.then((res) => res.json())
		.then(async ({ message }) => {
			if (socket.user !== "Guest" && !message.installed_apps) {
				const retry_res = await socket.frappe_request(
					"/api/method/frappe.realtime.get_user_info"
				);
				const retry_data = await retry_res.json();
				message = retry_data.message;
			}

			if (!message || !message.user) {
				// get_user_info returns {} when the socket secret does not match. Letting
				// that through connects a socket with no user and no app handlers, i.e. a
				// client that joins no room and silently receives nothing.
				next(new Error("Unauthorized: no user info returned"));
				return;
			}
			socket.user = message.user;
			socket.user_type = message.user_type;
			socket.installed_apps = message.installed_apps || [];
			next();
		})
		.catch((e) => {
			next(new Error(`Unauthorized: ${e}`));
		});
}

function get_site_name(socket) {
	if (socket.site_name) {
		return socket.site_name;
	} else if (socket.request.headers["x-frappe-site-name"]) {
		socket.site_name = get_hostname(socket.request.headers["x-frappe-site-name"]);
	} else if (
		conf.default_site &&
		["localhost", "127.0.0.1"].indexOf(get_hostname(socket.request.headers.host)) !== -1
	) {
		socket.site_name = conf.default_site;
	} else if (socket.request.headers.origin) {
		socket.site_name = get_hostname(socket.request.headers.origin);
	} else {
		socket.site_name = get_hostname(socket.request.headers.host);
	}
	return socket.site_name;
}

function get_hostname(url) {
	if (!url) return undefined;
	if (url.indexOf("://") > -1) {
		url = url.split("/")[2];
	}
	return url.match(/:/g) ? url.slice(0, url.indexOf(":")) : url;
}

module.exports = authenticate_with_frappe;
