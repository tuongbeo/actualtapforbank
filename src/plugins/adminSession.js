// src/plugins/adminSession.js
//
// Registers @fastify/session for the admin UI, path-prefix aware.
//
// Why this needs its own plugin: under the documented path-prefix deployment (README --
// APP_BASE_URL=https://example.com/actual-transfer-hub, with nginx STRIPPING the prefix before
// forwarding) two different paths are in play and they must not be confused:
//
//   * app-internal:   what this process sees -- always "/admin/..." (the proxy stripped it)
//   * browser-facing: what the browser sees  -- "<basePath>/admin/..."
//
// @fastify/session uses its `cookie.path` option for BOTH: it skips session handling entirely
// for any request whose (internal) URL does not sit under that path, AND it emits that same
// value as the Set-Cookie `Path` attribute. Setting it to the browser-facing
// "<basePath>/admin" therefore silently disables sessions for every real request (internal
// "/admin/login" is not under "/actual-transfer-hub/admin"), which breaks login with an
// "Invalid state" 400; setting it to the internal "/admin" instead makes the browser refuse to
// send the cookie back (its own URLs all live under the prefix).
//
// So: the plugin is configured with the INTERNAL path (sessions work), and the outgoing
// Set-Cookie header is rewritten once, at the edge, to the BROWSER-FACING path.
const fp = require("fastify-plugin");

const SESSION_COOKIE_NAME = "sessionId";
const INTERNAL_COOKIE_PATH = "/admin";

module.exports = fp(async (fastify, opts) => {
  const { secret, basePath = "", secure = false, store } = opts;

  await fastify.register(require("@fastify/session"), {
    secret,
    ...(store ? { store } : {}),
    cookieName: SESSION_COOKIE_NAME,
    // saveUninitialized: false + a cookie path scoped to the admin UI scope session handling to
    // the admin UI only. @fastify/session's hooks otherwise run for EVERY request (this plugin
    // is registered globally), so without this every /health, /transaction, /bank-transfer
    // request would leak an unbounded, no-TTL in-memory session and set an unrelated
    // Set-Cookie header.
    saveUninitialized: false,
    cookie: {
      secure,
      path: INTERNAL_COOKIE_PATH,
      sameSite: "lax",
    },
  });

  if (!basePath) return; // root deployment: internal and browser-facing paths are identical

  const externalPath = `${basePath}${INTERNAL_COOKIE_PATH}`;
  // Matches the Path attribute @fastify/cookie serialises ("; Path=/admin"), and only when it
  // is exactly the internal admin path -- never a longer path that merely starts with it.
  const INTERNAL_PATH_ATTR = new RegExp(`;\\s*Path=${INTERNAL_COOKIE_PATH}(?=;|$)`, "i");

  fastify.addHook("onSend", async (request, reply) => {
    const header = reply.getHeader("set-cookie");
    if (!header) return;

    const cookies = Array.isArray(header) ? header : [header];
    let rewrote = false;
    const next = cookies.map((cookie) => {
      if (typeof cookie !== "string" || !cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) return cookie;
      if (!INTERNAL_PATH_ATTR.test(cookie)) return cookie;
      rewrote = true;
      return cookie.replace(INTERNAL_PATH_ATTR, `; Path=${externalPath}`);
    });

    if (rewrote) reply.header("set-cookie", next);
  });
});

module.exports.SESSION_COOKIE_NAME = SESSION_COOKIE_NAME;
module.exports.INTERNAL_COOKIE_PATH = INTERNAL_COOKIE_PATH;
