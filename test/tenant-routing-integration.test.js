const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const { buildTenantLookup, resolveTenant } = require("../src/lib/tenantAuth");

/**
 * Exercises the spec's own explicit acceptance criterion (Testing Plan, §8):
 * "two tenants' requests interleaved (e.g. via Promise.all) each see only
 * their own templatesStore/workerClient". Unlike test/vietqr-transaction.test.js's
 * cross-tenant test (two separate Fastify apps, each with a test-local
 * preHandler that injects request.tenant directly), this builds ONE app with
 * the REAL preHandler hook built from buildTenantLookup/resolveTenant --
 * mirroring exactly what src/server.js's registerModules() does -- routing
 * two different API keys to two different mock worker clients.
 */
function makeMockWorkerClient(tenantId) {
  const addedTransactions = [];
  return {
    addedTransactions,
    getAccounts: async () => [{ id: `acc-${tenantId}`, name: "Checking" }],
    getPayees: async () => [],
    addTransactions: async (accountId, transactions) => {
      addedTransactions.push({ accountId, transactions });
      return "ok";
    },
    deleteTransaction: async () => "ok",
    sync: async () => {},
    actualInternalSend: async () => undefined,
  };
}

async function buildRealAuthApp() {
  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });

  const aliceWorkerClient = makeMockWorkerClient("alice");
  const bobWorkerClient = makeMockWorkerClient("bob");

  const tenants = [
    { id: "alice", apiKey: "alice-key", templates: [], accountMapJson: '{"111":"Alice Checking"}', keycloakSub: null },
    { id: "bob", apiKey: "bob-key", templates: [], accountMapJson: '{"222":"Bob Checking"}', keycloakSub: null },
  ];
  const workerClients = new Map([
    ["alice", aliceWorkerClient],
    ["bob", bobWorkerClient],
  ]);

  // Built exactly the way src/server.js's registerModules() builds it.
  const { tenantsByApiKey } = buildTenantLookup(tenants, workerClients);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) return;
    const apiKey = request.headers["x-api-key"];
    const tenant = resolveTenant(tenantsByApiKey, apiKey);
    if (!tenant) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.tenant = tenant;
  });

  await app.register(require("../src/routes/transaction"));
  await app.register(require("../src/routes/vietqrTransaction"));

  return { app, aliceWorkerClient, bobWorkerClient };
}

describe("Real per-tenant auth routing (single app, interleaved requests)", () => {
  it("routes each tenant's interleaved /transaction requests to only that tenant's own workerClient", async () => {
    const { app, aliceWorkerClient, bobWorkerClient } = await buildRealAuthApp();

    const [aliceResponse, bobResponse] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/transaction",
        headers: { "x-api-key": "alice-key", "content-type": "application/json" },
        payload: { account: "Checking", amount: 10, payee: "Alice's Payee" },
      }),
      app.inject({
        method: "POST",
        url: "/transaction",
        headers: { "x-api-key": "bob-key", "content-type": "application/json" },
        payload: { account: "Checking", amount: 20, payee: "Bob's Payee" },
      }),
    ]);

    assert.strictEqual(aliceResponse.statusCode, 200);
    assert.strictEqual(bobResponse.statusCode, 200);

    // Each mock worker client recorded exactly its own tenant's transaction --
    // never the other tenant's.
    assert.strictEqual(aliceWorkerClient.addedTransactions.length, 1);
    assert.strictEqual(bobWorkerClient.addedTransactions.length, 1);
    assert.strictEqual(aliceWorkerClient.addedTransactions[0].accountId, "acc-alice");
    assert.strictEqual(bobWorkerClient.addedTransactions[0].accountId, "acc-bob");
    assert.strictEqual(aliceWorkerClient.addedTransactions[0].transactions[0].payee_name, "Alice's Payee");
    assert.strictEqual(bobWorkerClient.addedTransactions[0].transactions[0].payee_name, "Bob's Payee");

    await app.close();
  });

  it("rejects an unknown API key with 401 regardless of other tenants' valid keys", async () => {
    const { app } = await buildRealAuthApp();

    const response = await app.inject({
      method: "POST",
      url: "/transaction",
      headers: { "x-api-key": "not-a-real-key", "content-type": "application/json" },
      payload: { account: "Checking", amount: 10 },
    });

    assert.strictEqual(response.statusCode, 401);
    await app.close();
  });
});
