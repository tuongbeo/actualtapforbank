// test/admin-register.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const adminRegisterPlugin = require("../src/routes/adminRegister");

async function buildApp({ tenant = null, sessionUserSub = "sub-1", registerTenantImpl } = {}) {
  const app = fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.session = { userSub: sessionUserSub };
    if (tenant) request.tenant = tenant;
  });
  await app.register(adminRegisterPlugin, { registerTenant: registerTenantImpl || (async () => ({ ok: true, id: "sub-1", apiKey: "abc" })) });
  return app;
}

describe("GET /admin/api/me", () => {
  it("reports registered:false when request.tenant is unset", async () => {
    const app = await buildApp({ tenant: null });
    const response = await app.inject({ method: "GET", url: "/admin/api/me" });
    assert.deepStrictEqual(JSON.parse(response.body), { registered: false });
    await app.close();
  });

  it("reports registered:true when request.tenant is set", async () => {
    const app = await buildApp({ tenant: { id: "sub-1" } });
    const response = await app.inject({ method: "GET", url: "/admin/api/me" });
    assert.deepStrictEqual(JSON.parse(response.body), { registered: true });
    await app.close();
  });
});

describe("POST /admin/api/register", () => {
  it("400s when actualSyncId or actualPassword is missing", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/admin/api/register", payload: { actualSyncId: "x" } });
    assert.strictEqual(response.statusCode, 400);
    await app.close();
  });

  it("409s immediately if request.tenant is already set (already registered)", async () => {
    const app = await buildApp({ tenant: { id: "sub-1" } });
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/register",
      payload: { actualSyncId: "x", actualPassword: "y" },
    });
    assert.strictEqual(response.statusCode, 409);
    await app.close();
  });

  it("passes the session's userSub as keycloakSub and returns 201 + apiKey on success", async () => {
    let capturedInput;
    const app = await buildApp({
      sessionUserSub: "sub-alice",
      registerTenantImpl: async (input) => {
        capturedInput = input;
        return { ok: true, id: "sub-alice", apiKey: "generated-key" };
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/register",
      payload: { actualSyncId: "sync-1", actualPassword: "pw", actualEncryptionPassword: "enc" },
    });
    assert.strictEqual(response.statusCode, 201);
    assert.deepStrictEqual(JSON.parse(response.body), { id: "sub-alice", apiKey: "generated-key" });
    assert.strictEqual(capturedInput.keycloakSub, "sub-alice");
    assert.strictEqual(capturedInput.actualSyncId, "sync-1");
    await app.close();
  });

  it("maps a failed registration's { ok: false, code, error, message } to the HTTP response", async () => {
    const app = await buildApp({
      registerTenantImpl: async () => ({ ok: false, code: 422, error: "Could not connect to Actual Budget", message: "bad password" }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/register",
      payload: { actualSyncId: "sync-1", actualPassword: "wrong" },
    });
    assert.strictEqual(response.statusCode, 422);
    assert.deepStrictEqual(JSON.parse(response.body), {
      error: "Could not connect to Actual Budget",
      message: "bad password",
    });
    await app.close();
  });
});
