const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const fastify = require("fastify");
const fastifyCookie = require("@fastify/cookie");
const fastifyCors = require("@fastify/cors");

const { buildTenantLookup, resolveTenant } = require("../src/lib/tenantAuth");
const { createDedupCache } = require("../src/lib/dedupCache");
const { loadTenants } = require("../src/lib/tenantRegistry");
const { spawnAll } = require("../src/worker/tenantWorkerPool");
const { createTenantProvisioner } = require("../src/lib/tenantProvisioning");
const { deriveBasePath } = require("../src/lib/adminBasePath");

const FAKE_WORKER_PATH = path.join(__dirname, "fixtures/fakeTenantWorker.js");

const SESSION_SECRET = "a".repeat(32);
const APP_BASE_URL = "http://actualtap.example.com"; // http on purpose: this test doesn't exercise
  // the trustProxy/HTTPS-cookie mechanism (Finding 1) -- see the separate unit-style check for
  // that -- so secure:false keeps @fastify/session's cookie handling straightforward under inject().

const TEMPLATE = {
  name: "full-chain-test",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["FULLCHAIN-MARKER"] },
  fields: {
    sourceAccountNumber: { label: "Account:", stopLabel: "$END$" },
    amount: { label: "Amount:", type: "amount", stopLabel: "$END2$" },
  },
  requiredFields: ["sourceAccountNumber", "amount"],
};

const SAMPLE_TEXT = "FULLCHAIN-MARKER Account: 123456 $END$ Amount: 25.00 $END2$";

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
      return {
        claims: () => ({ sub, preferred_username: "alice", email: "alice@example.com" }),
      };
    },
    endSessionUrl: null,
  };
}

// Builds the app the way src/server.js's registerModules() actually does: same Fastify
// factory options (ajv, routerOptions.ignoreTrailingSlash), the same plugin registration
// order, a real buildTenantLookup() over a real templatesStore backed by a temp-dir
// templates.json, and a fake oidcClient (same pattern as test/admin-auth.test.js). This is
// the one test in the suite that exercises the real chain together end to end, rather than
// each task's own hand-built minimal server -- see Finding 7 of the final review.
async function buildApp({ oidcClient = fakeOidcClient(), appBaseUrl = APP_BASE_URL } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-full-chain-"));
  const templatesPath = path.join(dir, "templates.json");
  fs.writeFileSync(templatesPath, "[]");

  const app = fastify({
    logger: false,
    ajv: { customOptions: { allowUnionTypes: true } },
    routerOptions: { ignoreTrailingSlash: true },
    trustProxy: true,
  });

  app.decorate("config", {
    ACTUAL_URL: "http://actual.example.com",
    KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
    KEYCLOAK_CLIENT_ID: "actualtap-admin",
    KEYCLOAK_CLIENT_SECRET: "secret",
    SESSION_SECRET,
    APP_BASE_URL: appBaseUrl,
  });

  const addedTransactions = [];
  const mockWorkerClient = {
    getAccounts: async () => [{ id: "acc-1", name: "Checking" }],
    addTransactions: async (accountId, transactions) => {
      addedTransactions.push({ accountId, transactions });
      return "ok";
    },
    sync: async () => {},
  };
  app.decorate("addedTransactions", addedTransactions);

  const tenants = [
    {
      id: "alice",
      apiKey: "alice-api-key",
      templatesPath,
      templates: [],
      accountMapJson: '{"123456":"Checking"}',
      accountMapPath: path.join(dir, "tenants", "alice", "account-map.json"),
      keycloakSub: "sub-alice",
    },
  ];
  const workerClients = new Map([["alice", mockWorkerClient]]);
  const { tenantsByApiKey, tenantsByKeycloakSub } = buildTenantLookup(tenants, workerClients);

  // Mirrors server.js's global tenant-by-API-key preHandler hook, including its /admin and
  // /health exclusions.
  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?") || request.url.startsWith("/admin")) {
      return;
    }
    const apiKey = request.headers["x-api-key"];
    const tenant = resolveTenant(tenantsByApiKey, apiKey);
    if (!tenant) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.tenant = tenant;
  });

  // Admin UI stack, in the same order and with the same options as server.js (Findings 1-6),
  // including the path-prefix-aware cookie path and auth basePath derived from APP_BASE_URL.
  const basePath = deriveBasePath(appBaseUrl);
  await app.register(fastifyCookie);
  await app.register(require("../src/plugins/adminSession"), {
    secret: SESSION_SECRET,
    secure: appBaseUrl.startsWith("https://"),
    basePath,
  });
  await app.register(require("../src/plugins/auth"), { oidcClient, tenantsByKeycloakSub, basePath });
  await app.register(require("../src/plugins/staticAdmin"));
  await app.register(require("../src/routes/adminTemplates"));

  await app.register(fastifyCors, { methods: ["POST"] });
  await app.register(require("../src/routes/bankTransfer"), { dedupCache: createDedupCache() });

  return { app, templatesPath };
}

// A second, separate app builder for the zero-tenant-boot + self-registration scenario --
// deliberately independent of buildApp() above. Mirrors server.js's real Task 10 wiring:
// loadTenants() from a real tenants.json, spawnAll()/spawnOne() against the real
// fakeTenantWorker.js fixture, and the real tenantProvisioner wired into adminRegister.
async function buildFreshApp({ oidcClient = fakeOidcClient({ sub: "sub-new-user" }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-full-chain-fresh-"));
  const tenantsConfigPath = path.join(dir, "tenants.json");
  fs.writeFileSync(tenantsConfigPath, "[]");

  const app = fastify({
    logger: false,
    ajv: { customOptions: { allowUnionTypes: true } },
    routerOptions: { ignoreTrailingSlash: true },
    trustProxy: true,
  });

  app.decorate("config", {
    ACTUAL_URL: "http://actual.example.com",
    TENANTS_CONFIG_PATH: tenantsConfigPath,
    KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
    KEYCLOAK_CLIENT_ID: "actualtap-admin",
    KEYCLOAK_CLIENT_SECRET: "secret",
    SESSION_SECRET,
    APP_BASE_URL,
  });

  const tenants = loadTenants(tenantsConfigPath); // [] -- nobody registered yet
  const { clients: workerClients, children } = await spawnAll([], FAKE_WORKER_PATH);
  const { tenantsById, tenantsByApiKey, tenantsByKeycloakSub } = buildTenantLookup(tenants, workerClients);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?") || request.url.startsWith("/admin")) {
      return;
    }
    const apiKey = request.headers["x-api-key"];
    const tenant = resolveTenant(tenantsByApiKey, apiKey);
    if (!tenant) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.tenant = tenant;
  });

  await app.register(fastifyCookie);
  await app.register(require("../src/plugins/adminSession"), {
    secret: SESSION_SECRET,
    secure: APP_BASE_URL.startsWith("https://"),
    basePath: deriveBasePath(APP_BASE_URL),
  });
  await app.register(require("../src/plugins/auth"), { oidcClient, tenantsByKeycloakSub });
  await app.register(require("../src/plugins/staticAdmin"));
  await app.register(require("../src/routes/adminTemplates"));
  await app.register(require("../src/routes/adminAccountMap"));

  const { registerTenant } = createTenantProvisioner({
    tenantsConfigPath,
    actualUrl: "http://actual.example.com",
    workerPath: FAKE_WORKER_PATH,
    tenantsById,
    tenantsByApiKey,
    tenantsByKeycloakSub,
    onWorkerSpawned: (child) => children.push(child),
  });
  await app.register(require("../src/routes/adminRegister"), { registerTenant });

  await app.register(fastifyCors, { methods: ["POST"] });
  await app.register(require("../src/routes/bankTransfer"), { dedupCache: createDedupCache() });

  return { app, children };
}

describe("Full admin chain (login -> callback -> / -> CRUD -> live effect on /bank-transfer)", () => {
  it("drives the whole real chain end to end", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const { app, templatesPath } = await buildApp({ oidcClient });

    // 1. GET /admin/login -> stash PKCE state in session, redirect to the (fake) authorization URL.
    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    assert.strictEqual(loginResponse.statusCode, 302);
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    assert.ok(state);

    // 2. GET /admin/callback -> exchanges the code, regenerates the session, redirects to
    // the default returnTo ("/admin/").
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    assert.strictEqual(callbackResponse.statusCode, 302);
    assert.strictEqual(callbackResponse.headers.location, "/admin/");
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    // 3. GET /admin/ -> must return the real HTML page, NOT a 404 (Finding 3: the
    // ignoreTrailingSlash + @fastify/static interaction that 404'd the documented entry point
    // and the default post-login redirect target).
    const indexResponse = await app.inject({ method: "GET", url: "/admin/", headers: { cookie } });
    assert.strictEqual(indexResponse.statusCode, 200);
    assert.ok(indexResponse.headers["content-type"].includes("text/html"));
    assert.ok(indexResponse.body.length > 0);

    // Also confirm the no-trailing-slash form resolves too, same fix.
    const indexNoSlashResponse = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    assert.strictEqual(indexNoSlashResponse.statusCode, 200);

    // 4. POST /admin/api/templates -> a new template, through the authenticated session.
    const createResponse = await app.inject({
      method: "POST",
      url: "/admin/api/templates",
      headers: { cookie },
      payload: TEMPLATE,
    });
    assert.strictEqual(createResponse.statusCode, 200);

    // The write went through the real templatesStore to the real file on disk.
    const onDisk = JSON.parse(fs.readFileSync(templatesPath, "utf8"));
    assert.deepStrictEqual(onDisk, [TEMPLATE]);

    // 5. POST /bank-transfer with the tenant's API key and matching rawText -> proves the
    // SAME templatesStore instance is shared end to end between the admin API and the
    // data-plane route (no restart / no separate store).
    const bankTransferResponse = await app.inject({
      method: "POST",
      url: "/bank-transfer",
      headers: { "x-api-key": "alice-api-key", "content-type": "application/json" },
      payload: { rawText: SAMPLE_TEXT },
    });
    assert.strictEqual(bankTransferResponse.statusCode, 200);
    const body = JSON.parse(bankTransferResponse.body);
    assert.strictEqual(body.amount, -2500); // "expense" direction -> signed negative
    assert.strictEqual(app.addedTransactions.length, 1);

    await app.close();
  });

  it("GET /admin/login|/admin/ with no session redirects to login (guard still active in the real chain)", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/admin/" });
    assert.strictEqual(response.statusCode, 302);
    assert.ok(response.headers.location.startsWith("/admin/login"));
    await app.close();
  });

  it("unauthenticated non-GET /admin/api/preview returns 401 (Finding 2: DoS guard closes at the root)", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/preview",
      payload: { rawText: "x", template: TEMPLATE },
    });
    assert.strictEqual(response.statusCode, 401);
    await app.close();
  });

  it("a session cookie issued for /admin is not sent by browsers to data-plane routes (Finding 4: cookie path scoping)", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const { app } = await buildApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    const setCookieHeader = loginResponse.headers["set-cookie"];
    assert.ok(setCookieHeader, "expected /admin/login to set a session cookie");
    const setCookie = Array.isArray(setCookieHeader) ? setCookieHeader.join("; ") : setCookieHeader;
    assert.ok(/Path=\/admin/i.test(setCookie), `expected cookie to be scoped to /admin, got: ${setCookie}`);

    await app.close();
  });

  // Spec §12: "An APP_BASE_URL with a path component produces a session cookie whose
  // Set-Cookie Path attribute includes that prefix" -- and, per final-review Finding 1, the
  // login redirect the browser is given must carry the prefix too.
  it("an APP_BASE_URL with a path component prefixes both the cookie Path and the login redirect", async () => {
    const PREFIX = "/actual-transfer-hub";
    const { app } = await buildApp({ appBaseUrl: `http://cash.example.com${PREFIX}` });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    const setCookieHeader = loginResponse.headers["set-cookie"];
    assert.ok(setCookieHeader, "expected /admin/login to set a session cookie");
    const setCookie = Array.isArray(setCookieHeader) ? setCookieHeader.join("; ") : setCookieHeader;
    assert.ok(
      new RegExp(`Path=${PREFIX}/admin`, "i").test(setCookie),
      `expected the cookie Path to include the deployment prefix, got: ${setCookie}`
    );

    const guardedResponse = await app.inject({ method: "GET", url: "/admin/" });
    assert.strictEqual(guardedResponse.statusCode, 302);
    assert.ok(
      guardedResponse.headers.location.startsWith(`${PREFIX}/admin/login`),
      `expected a prefixed login redirect, got: ${guardedResponse.headers.location}`
    );

    await app.close();
  });

  // The prefixed cookie Path is only half the story: the session itself must still work on the
  // app-internal (prefix-stripped) URLs this process actually receives. Getting this wrong
  // silently disables sessions and every login ends in a 400 "Invalid state".
  it("a prefixed deployment still completes a full login round-trip on stripped internal URLs", async () => {
    const PREFIX = "/actual-transfer-hub";
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const { app } = await buildApp({ oidcClient, appBaseUrl: `http://cash.example.com${PREFIX}` });

    // The proxy strips the prefix, so every URL below is the unprefixed one the app sees.
    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    assert.strictEqual(loginResponse.statusCode, 302);
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    assert.ok(cookie.length > 0, "expected a pre-auth session cookie");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    // A 400 here means the PKCE state never survived in a session (the failure mode when the
    // session cookie path is scoped to the browser-facing prefix instead of the internal path).
    assert.strictEqual(callbackResponse.statusCode, 302, `callback failed: ${callbackResponse.body}`);
    assert.strictEqual(callbackResponse.headers.location, `${PREFIX}/admin/`);
    const postAuthSetCookie = callbackResponse.headers["set-cookie"];
    const postAuthCookieHeader = Array.isArray(postAuthSetCookie) ? postAuthSetCookie.join("; ") : postAuthSetCookie;
    assert.ok(
      new RegExp(`Path=${PREFIX}/admin`, "i").test(postAuthCookieHeader),
      `post-login cookie must stay prefixed, got: ${postAuthCookieHeader}`
    );
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const indexResponse = await app.inject({ method: "GET", url: "/admin/", headers: { cookie } });
    assert.strictEqual(indexResponse.statusCode, 200);

    await app.close();
  });

  it("open-redirect returnTo is rejected and falls back to /admin/ (Finding 6)", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const { app } = await buildApp({ oidcClient });

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
    assert.strictEqual(callbackResponse.statusCode, 302);
    assert.strictEqual(callbackResponse.headers.location, "/admin/");

    await app.close();
  });

  it("backslash-based open-redirect returnTo is rejected (WHATWG URL parsing treats /\\host as //host)", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const { app } = await buildApp({ oidcClient });

    for (const payload of ["/\\evil.example.com", "/\\/evil.example.com"]) {
      const loginResponse = await app.inject({
        method: "GET",
        url: "/admin/login?returnTo=" + encodeURIComponent(payload),
      });
      const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const state = oidcClient.calls.authorizationUrl[oidcClient.calls.authorizationUrl.length - 1].state;

      const callbackResponse = await app.inject({
        method: "GET",
        url: `/admin/callback?code=good-code&state=${state}`,
        headers: { cookie },
      });
      assert.strictEqual(callbackResponse.statusCode, 302);
      assert.strictEqual(
        callbackResponse.headers.location,
        "/admin/",
        `payload ${JSON.stringify(payload)} should fall back to /admin/, got ${callbackResponse.headers.location}`
      );
      // Confirm the WHATWG URL parser (what a real browser uses to resolve a Location
      // header) would indeed have treated the rejected payload as off-site, proving this
      // case is a real bypass attempt and not a vacuous check.
      assert.notStrictEqual(new URL(payload, "https://actualtap.example.com").host, "actualtap.example.com");
    }

    await app.close();
  });

  it("returnTo containing control characters (e.g. CRLF) is rejected", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const { app } = await buildApp({ oidcClient });

    const loginResponse = await app.inject({
      method: "GET",
      url: "/admin/login?returnTo=" + encodeURIComponent("/x\r\nSet-Cookie: a=b"),
    });
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[oidcClient.calls.authorizationUrl.length - 1].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    assert.strictEqual(callbackResponse.statusCode, 302);
    assert.strictEqual(callbackResponse.headers.location, "/admin/");

    await app.close();
  });

  it("session ID changes after login (Finding 5: regenerate() defeats session fixation)", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const { app } = await buildApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    const preAuthCookie = loginResponse.cookies.find((c) => c.name === "sessionId" || c.name === "session");
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    const postAuthCookie = callbackResponse.cookies.find((c) => c.name === (preAuthCookie ? preAuthCookie.name : c.name));
    assert.ok(callbackResponse.cookies.length > 0, "expected a new Set-Cookie after successful login");
    if (preAuthCookie && postAuthCookie) {
      assert.notStrictEqual(postAuthCookie.value, preAuthCookie.value, "session ID must change after login");
    }

    await app.close();
  });
});

describe("Zero-tenant boot + self-service registration", () => {
  it("lets a fresh deployment's first user self-register and immediately use /bank-transfer", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-new-user" });
    const { app, children } = await buildFreshApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const meBefore = await app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    assert.deepStrictEqual(JSON.parse(meBefore.body), { registered: false });

    const registerResponse = await app.inject({
      method: "POST",
      url: "/admin/api/register",
      headers: { cookie },
      payload: { actualSyncId: "sync-new", actualPassword: "pw" },
    });
    assert.strictEqual(registerResponse.statusCode, 201);
    const { apiKey } = JSON.parse(registerResponse.body);

    const meAfter = await app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    assert.deepStrictEqual(JSON.parse(meAfter.body), { registered: true });

    // Immediately usable on the data plane, same running server, no restart
    const bankTransferResponse = await app.inject({
      method: "POST",
      url: "/bank-transfer",
      headers: { "x-api-key": apiKey },
      payload: { rawText: "no template will match this -- proves auth succeeded, not that parsing did" },
    });
    assert.notStrictEqual(bankTransferResponse.statusCode, 401);

    for (const child of children) child.kill();
    await app.close();
  });
});
