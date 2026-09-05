const fp = require("fastify-plugin");
const { Issuer, generators } = require("openid-client");
const { resolveTenantByKeycloakSub } = require("../lib/tenantAuth");

const createOidcClient = async ({ issuerUrl, clientId, clientSecret, redirectUri }) => {
  const issuer = await Issuer.discover(issuerUrl);
  const client = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: [redirectUri],
    response_types: ["code"],
  });

  return {
    authorizationUrl: (params) => client.authorizationUrl(params),
    callback: (params, checks) => client.callback(redirectUri, params, checks),
    endSessionUrl: issuer.metadata.end_session_endpoint
      ? (params) => client.endSessionUrl(params)
      : null,
  };
};

module.exports = fp(async (fastify, opts) => {
  const { KEYCLOAK_ISSUER_URL, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, APP_BASE_URL } = fastify.config;
  const redirectUri = `${APP_BASE_URL}/admin/callback`;

  const oidcClient =
    opts.oidcClient ||
    (await createOidcClient({
      issuerUrl: KEYCLOAK_ISSUER_URL,
      clientId: KEYCLOAK_CLIENT_ID,
      clientSecret: KEYCLOAK_CLIENT_SECRET,
      redirectUri,
    }));

  const { tenantsByKeycloakSub } = opts;

  // The URL path prefix this app is deployed under (e.g. "/actual-transfer-hub"), derived by
  // the caller from APP_BASE_URL. Defaults to "" (root deployment), which also keeps any test
  // harness that doesn't pass it working exactly as before.
  //
  // Direction matters: the documented reverse-proxy setup STRIPS the prefix before forwarding,
  // so request.url server-side is always unprefixed ("/admin/...") and all routing/matching
  // below stays unprefixed. The prefix is added ONLY to URLs handed back to the browser
  // (redirect Location headers, and the returnTo the browser will later be sent to), because
  // the browser resolves those against the external origin where the prefix still exists --
  // nginx then strips it again on the way back in.
  const basePath = opts.basePath || "";

  // Only accept a same-origin relative path (e.g. "/admin/foo"); reject anything that could
  // send the browser off-site after login: protocol-relative ("//evil.example.com/"), an
  // absolute URL ("https://evil.example.com/" -- contains "://"), or a non-string/empty value.
  // The fallback is browser-facing, so it carries the deployment prefix.
  const sanitizeReturnTo = (value) => {
    if (
      typeof value === "string" &&
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("://") &&
      !value.includes("\\") && // a backslash lets WHATWG URL parsing (what browsers use to
      // resolve a Location header) treat "/\host" as "//host", bypassing the "//" check above
      !/[\x00-\x1f\x7f]/.test(value) // reject control characters (e.g. CR/LF header injection attempts)
    ) {
      return value;
    }
    return `${basePath}/admin/`;
  };

  const UNPREFIXED_NO_TENANT_REQUIRED_PATHS = [
    "/admin",
    "/admin/",
    "/admin/index.html",
    "/admin/api/me",
    "/admin/api/register",
  ];

  // Both forms are listed: the unprefixed ones are what this app actually sees behind the
  // documented (prefix-stripping) reverse proxy, while the prefixed ones keep the allowlist
  // correct for a proxy that forwards the prefix intact.
  const NO_TENANT_REQUIRED_PATHS = new Set([
    ...UNPREFIXED_NO_TENANT_REQUIRED_PATHS,
    ...(basePath ? UNPREFIXED_NO_TENANT_REQUIRED_PATHS.map((p) => `${basePath}${p}`) : []),
  ]);

  // Matches "/admin..." and, if deployed under a prefix, "<basePath>/admin..." too, so the
  // guard never silently disengages (leaving /admin/* wide open) if a proxy forwards the
  // prefix rather than stripping it.
  const isAdminPath = (url, suffix = "") =>
    url.startsWith(`/admin${suffix}`) || (basePath !== "" && url.startsWith(`${basePath}/admin${suffix}`));

  fastify.addHook("preHandler", async (request, reply) => {
    if (!isAdminPath(request.url)) return;
    if (isAdminPath(request.url, "/login") || isAdminPath(request.url, "/callback")) return;

    if (!request.session.userSub) {
      if (request.method !== "GET") {
        // Only redirect GET requests to login, per spec -- but a non-GET request must still
        // never reach a route handler unauthenticated (an unauthenticated, unguarded route
        // like /admin/api/preview would otherwise be fully reachable by anyone).
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      // request.url is the path as this app sees it (unprefixed behind the documented
      // prefix-stripping proxy). Both the Location and the returnTo inside it are resolved by
      // the BROWSER against the external origin, so both need the deployment prefix -- unless
      // the request already arrived carrying it (a non-stripping proxy), in which case adding
      // it again would double it.
      const externalUrl = basePath && !request.url.startsWith(`${basePath}/`) ? `${basePath}${request.url}` : request.url;
      const returnTo = encodeURIComponent(externalUrl);
      reply.redirect(`${basePath}/admin/login?returnTo=${returnTo}`);
      return;
    }

    const tenant = resolveTenantByKeycloakSub(tenantsByKeycloakSub, request.session.userSub);
    if (tenant) {
      request.tenant = tenant;
      return;
    }

    // No tenant yet: only the registration view/API and the static entry page are reachable --
    // everything else (templates, account-map, preview) requires an already-provisioned tenant.
    if (NO_TENANT_REQUIRED_PATHS.has(request.url.split("?")[0])) {
      return;
    }

    reply.code(403).send({
      error: "No tenant associated with this account",
      message: `Visit ${basePath}/admin/ to connect your own Actual Budget account.`,
    });
  });

  fastify.get("/admin/login", async (request, reply) => {
    const codeVerifier = generators.codeVerifier();
    const state = generators.state();
    request.session.codeVerifier = codeVerifier;
    request.session.oauthState = state;
    request.session.returnTo = sanitizeReturnTo(request.query.returnTo);

    const url = oidcClient.authorizationUrl({
      scope: "openid profile email",
      code_challenge: generators.codeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
    });
    reply.redirect(url);
  });

  fastify.get("/admin/callback", async (request, reply) => {
    const { code, state } = request.query;

    if (!state || state !== request.session.oauthState) {
      reply.code(400).send({ error: "Invalid state" });
      return;
    }

    let tokenSet;
    try {
      tokenSet = await oidcClient.callback(
        { code, state },
        { code_verifier: request.session.codeVerifier, state: request.session.oauthState }
      );
    } catch (err) {
      reply.code(401).send({ error: "Authentication failed", message: err.message });
      return;
    }

    const claims = tokenSet.claims();
    // Captured before regenerate() below replaces request.session with a fresh (empty)
    // instance, which would otherwise wipe this along with the PKCE fields.
    const returnTo = sanitizeReturnTo(request.session.returnTo);

    // Regenerate the session (fresh session ID) before writing authenticated state onto it,
    // rather than reusing the pre-auth session that /admin/login created -- prevents session
    // fixation. Fields are set on request.session AFTER regenerate(), since regenerate()
    // replaces request.session with a new (empty) Session instance (which also takes care of
    // codeVerifier/oauthState/returnTo -- they're simply never copied onto the new session).
    await request.session.regenerate();

    request.session.userSub = claims.sub;
    request.session.userLabel = claims.preferred_username || claims.email || claims.sub;

    reply.redirect(returnTo);
  });

  fastify.post("/admin/logout", async (request, reply) => {
    const endSessionUrl = oidcClient.endSessionUrl
      ? oidcClient.endSessionUrl({ post_logout_redirect_uri: `${APP_BASE_URL}/admin/login` })
      : `${basePath}/admin/login`;
    await request.session.destroy();
    reply.redirect(endSessionUrl);
  });
});

module.exports.createOidcClient = createOidcClient;
