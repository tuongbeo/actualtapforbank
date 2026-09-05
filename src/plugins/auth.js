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

  fastify.addHook("preHandler", async (request, reply) => {
    if (request.method !== "GET") return;
    if (!request.url.startsWith("/admin")) return;
    if (request.url.startsWith("/admin/login") || request.url.startsWith("/admin/callback")) return;

    if (!request.session.userSub) {
      const returnTo = encodeURIComponent(request.url);
      reply.redirect(`/admin/login?returnTo=${returnTo}`);
      return;
    }

    const tenant = resolveTenantByKeycloakSub(tenantsByKeycloakSub, request.session.userSub);
    if (!tenant) {
      reply.code(403).send({
        error: "No tenant associated with this account",
        message: `Add "keycloakSub": "${request.session.userSub}" to a tenant's entry in config/tenants.json, then restart.`,
      });
      return;
    }
    request.tenant = tenant;
  });

  fastify.get("/admin/login", async (request, reply) => {
    const codeVerifier = generators.codeVerifier();
    const state = generators.state();
    request.session.codeVerifier = codeVerifier;
    request.session.oauthState = state;
    request.session.returnTo = request.query.returnTo || "/admin/";

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
    request.session.userSub = claims.sub;
    request.session.userLabel = claims.preferred_username || claims.email || claims.sub;
    delete request.session.codeVerifier;
    delete request.session.oauthState;

    const returnTo = request.session.returnTo || "/admin/";
    delete request.session.returnTo;
    reply.redirect(returnTo);
  });

  fastify.post("/admin/logout", async (request, reply) => {
    const endSessionUrl = oidcClient.endSessionUrl
      ? oidcClient.endSessionUrl({ post_logout_redirect_uri: `${APP_BASE_URL}/admin/login` })
      : "/admin/login";
    await request.session.destroy();
    reply.redirect(endSessionUrl);
  });
});

module.exports.createOidcClient = createOidcClient;
