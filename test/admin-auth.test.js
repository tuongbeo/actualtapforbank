const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const fastifyCookie = require("@fastify/cookie");
const fastifySession = require("@fastify/session");
const authPlugin = require("../src/plugins/auth");

const SESSION_SECRET = "a".repeat(32);
const APP_BASE_URL = "https://actualtap.example.com";

function fakeOidcClient({ sub = "sub-alice" } = {}) {
  const calls = { authorizationUrl: [], callback: [] };
  return {
    calls,
    authorizationUrl(params) {
      calls.authorizationUrl.push(params);
      return "https://keycloak.example.com/auth?mock=1";
    },
    async callback(params, checks) {
      calls.callback.push({ params, checks });
      if (params.code === "bad-code") throw new Error("invalid_grant");
      return {
        claims: () => ({ sub, preferred_username: "alice", email: "alice@example.com" }),
      };
    },
    endSessionUrl: null,
  };
}

async function buildApp({
  oidcClient = fakeOidcClient(),
  tenantsByKeycloakSub = new Map([["sub-alice", { id: "alice", templatesStore: {} }]]),
  appBaseUrl = APP_BASE_URL,
  basePath,
} = {}) {
  const app = fastify({ logger: false });
  app.decorate("config", {
    KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
    KEYCLOAK_CLIENT_ID: "actualtap-admin",
    KEYCLOAK_CLIENT_SECRET: "secret",
    APP_BASE_URL: appBaseUrl,
  });
  await app.register(fastifyCookie);
  await app.register(fastifySession, { secret: SESSION_SECRET, cookie: { secure: false } });
  await app.register(authPlugin, { oidcClient, tenantsByKeycloakSub, basePath });
  app.get("/admin/", async () => ({ ok: true, tenant: true }));
  app.post("/admin/test-post", async (request) => ({ tenant: !!request.tenant }));
  app.get("/admin/api/me", async (request) => ({ tenant: !!request.tenant }));
  app.post("/admin/api/register", async (request) => ({ tenant: !!request.tenant }));
  return app;
}

describe("GET /admin/login", () => {
  it("redirects to the authorization URL and stashes PKCE verifier + state in the session", async () => {
    const oidcClient = fakeOidcClient();
    const app = await buildApp({ oidcClient });
    const response = await app.inject({ method: "GET", url: "/admin/login" });
    assert.strictEqual(response.statusCode, 302);
    assert.strictEqual(response.headers.location, "https://keycloak.example.com/auth?mock=1");
    assert.strictEqual(oidcClient.calls.authorizationUrl.length, 1);
    const params = oidcClient.calls.authorizationUrl[0];
    assert.strictEqual(params.code_challenge_method, "S256");
    assert.ok(params.code_challenge);
    assert.ok(params.state);
    await app.close();
  });
});

describe("GET /admin/callback", () => {
  it("on success, sets a session and redirects to returnTo", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const app = await buildApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login?returnTo=/admin/foo" });
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });

    assert.strictEqual(callbackResponse.statusCode, 302);
    assert.strictEqual(callbackResponse.headers.location, "/admin/foo");
    assert.strictEqual(oidcClient.calls.callback.length, 1);
    assert.strictEqual(oidcClient.calls.callback[0].params.code, "good-code");
    await app.close();
  });

  it("rejects a mismatched state without calling the token endpoint", async () => {
    const oidcClient = fakeOidcClient();
    const app = await buildApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const response = await app.inject({
      method: "GET",
      url: "/admin/callback?code=good-code&state=wrong-state",
      headers: { cookie },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(oidcClient.calls.callback.length, 0);
    await app.close();
  });

  it("returns 401 when the token exchange itself fails", async () => {
    const oidcClient = fakeOidcClient();
    const app = await buildApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const response = await app.inject({
      method: "GET",
      url: `/admin/callback?code=bad-code&state=${state}`,
      headers: { cookie },
    });

    assert.strictEqual(response.statusCode, 401);
    await app.close();
  });
});

describe("admin guard preHandler", () => {
  it("redirects an unauthenticated GET /admin/* request to /admin/login", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/admin/" });
    assert.strictEqual(response.statusCode, 302);
    assert.ok(response.headers.location.startsWith("/admin/login"));
    await app.close();
  });

  it("sets request.tenant and allows the request through after a successful login", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const tenantsByKeycloakSub = new Map([["sub-alice", { id: "alice", templatesStore: {} }]]);
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const response = await app.inject({ method: "GET", url: "/admin/", headers: { cookie } });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { ok: true, tenant: true });
    await app.close();
  });

  it("lets an authenticated session with no tenant reach GET /admin/ (registration view)", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-nobody" });
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub: new Map() });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const response = await app.inject({ method: "GET", url: "/admin/", headers: { cookie } });
    assert.strictEqual(response.statusCode, 200);
    await app.close();
  });

  it("lets an authenticated session with no tenant reach GET /admin/api/me and POST /admin/api/register", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-nobody" });
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub: new Map() });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const meResponse = await app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    assert.strictEqual(meResponse.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(meResponse.body), { tenant: false });

    const registerResponse = await app.inject({ method: "POST", url: "/admin/api/register", headers: { cookie } });
    assert.strictEqual(registerResponse.statusCode, 200);
    await app.close();
  });

  it("still 403s a non-allowlisted path (e.g. POST /admin/test-post) when there's no tenant", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-nobody" });
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub: new Map() });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const response = await app.inject({ method: "POST", url: "/admin/test-post", headers: { cookie } });
    assert.strictEqual(response.statusCode, 403);
    await app.close();
  });

  it("sets request.tenant for an authenticated non-GET request (e.g. POST)", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const tenantsByKeycloakSub = new Map([["sub-alice", { id: "alice", templatesStore: {} }]]);
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const response = await app.inject({ method: "POST", url: "/admin/test-post", headers: { cookie } });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { tenant: true });
    await app.close();
  });

  it("does not redirect an unauthenticated non-GET request to /admin/login", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/admin/test-post" });
    assert.notStrictEqual(response.statusCode, 302);
    await app.close();
  });
});

// Final-review Finding 1: under a path-prefix deployment (APP_BASE_URL with a path component,
// with the reverse proxy stripping the prefix before forwarding), every URL the server hands
// back to the BROWSER must carry the prefix -- otherwise the browser resolves it against the
// bare origin and lands outside the deployment (404).
describe("path-prefix deployment (basePath)", () => {
  const PREFIX = "/actual-transfer-hub";
  const PREFIXED_BASE_URL = `https://cash.example.com${PREFIX}`;
  const { deriveBasePath } = require("../src/lib/adminBasePath");

  const buildPrefixedApp = (overrides = {}) =>
    buildApp({
      appBaseUrl: PREFIXED_BASE_URL,
      basePath: deriveBasePath(PREFIXED_BASE_URL),
      ...overrides,
    });

  it("redirects an unauthenticated GET to a prefixed login URL, with a prefixed returnTo", async () => {
    const app = await buildPrefixedApp();
    const response = await app.inject({ method: "GET", url: "/admin/" });

    assert.strictEqual(response.statusCode, 302);
    const location = response.headers.location;
    assert.ok(
      location.startsWith(`${PREFIX}/admin/login`),
      `expected a prefixed login redirect, got: ${location}`
    );
    // The returnTo the browser will eventually be sent to must be prefixed too.
    const returnTo = decodeURIComponent(location.split("returnTo=")[1]);
    assert.strictEqual(returnTo, `${PREFIX}/admin/`);
    await app.close();
  });

  it("defaults the post-callback redirect to the prefixed admin root", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const app = await buildPrefixedApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });

    assert.strictEqual(callbackResponse.statusCode, 302);
    assert.strictEqual(callbackResponse.headers.location, `${PREFIX}/admin/`);
    await app.close();
  });

  it("falls back to the prefixed admin root when returnTo is an off-site open redirect", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const app = await buildPrefixedApp({ oidcClient });

    const loginResponse = await app.inject({
      method: "GET",
      url: "/admin/login?returnTo=" + encodeURIComponent("https://evil.example.com/"),
    });
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    assert.strictEqual(callbackResponse.headers.location, `${PREFIX}/admin/`);
    await app.close();
  });

  it("redirects logout to the prefixed login URL when there is no end-session endpoint", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const app = await buildPrefixedApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const response = await app.inject({ method: "POST", url: "/admin/logout", headers: { cookie } });
    assert.strictEqual(response.statusCode, 302);
    assert.strictEqual(response.headers.location, `${PREFIX}/admin/login`);
    await app.close();
  });

  it("still guards a request that arrives WITH the prefix intact (non-stripping proxy)", async () => {
    const app = await buildPrefixedApp();
    const response = await app.inject({ method: "GET", url: `${PREFIX}/admin/api/templates` });
    // Must not fall through the guard unauthenticated; a redirect to login is the GET behaviour.
    assert.strictEqual(response.statusCode, 302);
    assert.ok(response.headers.location.startsWith(`${PREFIX}/admin/login`));
    // ...and the returnTo must not have been double-prefixed.
    const returnTo = decodeURIComponent(response.headers.location.split("returnTo=")[1]);
    assert.strictEqual(returnTo, `${PREFIX}/admin/api/templates`);
    await app.close();
  });

  it("keeps root-deployment URLs unprefixed when no basePath is given (backward compatible)", async () => {
    const app = await buildApp(); // no basePath option at all
    const response = await app.inject({ method: "GET", url: "/admin/" });
    assert.strictEqual(response.headers.location, `/admin/login?returnTo=${encodeURIComponent("/admin/")}`);
    await app.close();
  });
});

describe("POST /admin/logout", () => {
  it("destroys the session and redirects to /admin/login when no end-session endpoint exists", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const tenantsByKeycloakSub = new Map([["sub-alice", { id: "alice", templatesStore: {} }]]);
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const response = await app.inject({ method: "POST", url: "/admin/logout", headers: { cookie } });
    assert.strictEqual(response.statusCode, 302);
    assert.strictEqual(response.headers.location, "/admin/login");
    await app.close();
  });

  // As of the guard's fix for the /admin/api/preview unauthenticated-DoS finding, an
  // unauthenticated non-GET /admin/* request (logout included) is now rejected with 401 by the
  // guard before any route handler runs, instead of silently reaching the logout handler.
  it("returns 401 for an unauthenticated request instead of reaching the handler", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/admin/logout" });
    assert.strictEqual(response.statusCode, 401);
    await app.close();
  });
});
