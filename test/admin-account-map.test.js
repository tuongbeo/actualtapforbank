// test/admin-account-map.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const adminAccountMapPlugin = require("../src/routes/adminAccountMap");

function fakeAccountMapStore(initial) {
  let mapJson = JSON.stringify(initial);
  return {
    getMapJson: () => mapJson,
    replaceAll: (next) => {
      // Validate like the real accountMapStore
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        throw new Error("Account map must be a JSON object");
      }
      for (const [key, value] of Object.entries(next)) {
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(`Account map entry "${key}" must map to a non-empty string`);
        }
      }
      mapJson = JSON.stringify(next);
    },
  };
}

async function buildApp({ map = { "1": "Checking" }, setTenant = true } = {}) {
  const app = fastify({ logger: false });
  const accountMapStore = fakeAccountMapStore(map);
  if (setTenant) {
    app.addHook("preHandler", async (request) => {
      request.tenant = { id: "alice", accountMapStore };
    });
  }
  await app.register(adminAccountMapPlugin);
  return { app, accountMapStore };
}

describe("GET /admin/api/account-map", () => {
  it("returns the tenant's current account map", async () => {
    const { app } = await buildApp({ map: { "1": "Checking" } });
    const response = await app.inject({ method: "GET", url: "/admin/api/account-map" });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { "1": "Checking" });
    await app.close();
  });

  it("401s when request.tenant is unset", async () => {
    const { app } = await buildApp({ setTenant: false });
    const response = await app.inject({ method: "GET", url: "/admin/api/account-map" });
    assert.strictEqual(response.statusCode, 401);
    await app.close();
  });
});

describe("PUT /admin/api/account-map", () => {
  it("replaces the map", async () => {
    const { app, accountMapStore } = await buildApp({ map: {} });
    const response = await app.inject({
      method: "PUT",
      url: "/admin/api/account-map",
      payload: { "9": "Savings" },
    });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(accountMapStore.getMapJson()), { "9": "Savings" });
    await app.close();
  });

  it("400s on an invalid shape", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/admin/api/account-map",
      payload: { "9": 42 },
    });
    assert.strictEqual(response.statusCode, 400);
    await app.close();
  });
});
