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

async function buildApp({ oidcClient = fakeOidcClient(), tenantsByKeycloakSub = new Map([["sub-alice", { id: "alice", templatesStore: {} }]]) } = {}) {
  const app = fastify({ logger: false });
  app.decorate("config", {
    KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
    KEYCLOAK_CLIENT_ID: "actualtap-admin",
    KEYCLOAK_CLIENT_SECRET: "secret",
    APP_BASE_URL,
  });
  await app.register(fastifyCookie);
  await app.register(fastifySession, { secret: SESSION_SECRET, cookie: { secure: false } });
  await app.register(authPlugin, { oidcClient, tenantsByKeycloakSub });
  app.get("/admin/", async () => ({ ok: true, tenant: true }));
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

  it("returns 403 when the authenticated sub has no matching tenant", async () => {
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
    assert.strictEqual(response.statusCode, 403);
    await app.close();
  });
});

describe("POST /admin/logout", () => {
  it("destroys the session and redirects to /admin/login when no end-session endpoint exists", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/admin/logout" });
    assert.strictEqual(response.statusCode, 302);
    assert.strictEqual(response.headers.location, "/admin/login");
    await app.close();
  });
});
