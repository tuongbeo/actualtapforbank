// src/lib/adminBasePath.js
//
// Derives the URL path prefix this app is deployed under from APP_BASE_URL.
//
// The app itself always routes on unprefixed paths ("/admin/...") because the documented
// reverse-proxy setup (see README) strips the prefix before forwarding. The prefix therefore
// only matters for URLs that end up in the BROWSER -- redirect Location headers, the session
// cookie's Path attribute, and the admin UI's own fetch() targets -- since the browser resolves
// those against the external origin, where the prefix is still present.
//
//   "https://example.com"                    -> ""                     (root deployment)
//   "https://example.com/actual-transfer-hub" -> "/actual-transfer-hub"
//   "https://example.com/actual-transfer-hub/" -> "/actual-transfer-hub" (trailing slash stripped)
const deriveBasePath = (appBaseUrl) => new URL(appBaseUrl).pathname.replace(/\/$/, "");

module.exports = { deriveBasePath };
