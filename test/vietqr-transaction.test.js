const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const fastify = require("fastify");
const { createDedupCache } = require("../src/lib/dedupCache");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8");
const TEMPLATES = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/templates.json"), "utf8"));

async function buildMockServer({
  accountMapJson = '{"8820966012":"BIDV Cash"}',
  accounts = [{ id: "acc-1", name: "BIDV Cash" }],
  syncBehaviour = "success",
  templates = TEMPLATES,
  tenantId = "test-tenant",
  dedupCache = createDedupCache(),
} = {}) {
  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });

  app.decorate("config", { API_KEY: "test-key" });

  const addedTransactions = [];
  const mockWorkerClient = {
    getAccounts: async () => accounts,
    addTransactions: async (accountId, transactions) => {
      addedTransactions.push({ accountId, transactions });
      return "ok";
    },
    sync: async () => {
      if (syncBehaviour === "fail") {
        throw new Error("PostError: unauthorized");
      }
    },
  };
  app.decorate("addedTransactions", addedTransactions);
  app.decorate("mockWorkerClient", mockWorkerClient);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) return;
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== app.config.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.tenant = {
      id: tenantId,
      workerClient: mockWorkerClient,
      templatesStore: { getTemplates: () => templates },
      accountMapJson,
    };
  });

  await app.register(require("../src/routes/vietqrTransaction"), { dedupCache });

  return app;
}

describe("POST /vietqr-transaction", () => {
  it("creates an expense transaction from a matching BIDV email", async () => {
    const app = await buildMockServer();
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });

    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.amount, -1000000);
    assert.strictEqual(body.payee_name, "PHAM MANH TUONG");
    assert.strictEqual(body.date, "2026-09-04");
    assert.strictEqual(body.imported_id, "6247BIDVE2NEKZD1");
    assert.ok(body.notes.includes("6247BIDVE2NEKZD1"));
    assert.strictEqual(app.addedTransactions.length, 1);
    assert.strictEqual(app.addedTransactions[0].accountId, "acc-1");
    await app.close();
  });

  it("returns 400 when no template matches", async () => {
    const app = await buildMockServer();
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: "Your OTP code is 123456" },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Unrecognized bank format");
    await app.close();
  });

  it("returns 400 for a BIDV email lacking the debit-account label (e.g. an income variant)", async () => {
    const app = await buildMockServer();
    const incomeText = FIXTURE.replace("Tài khoản nguồn:", "Tài khoản đích:");
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: incomeText },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Unrecognized bank format");
    await app.close();
  });

  it("returns 500 when more than one template matches the same rawText", async () => {
    const duplicateTemplates = [
      {
        name: "dup-a",
        sourceType: "email",
        direction: "expense",
        match: { contains: ["FOO"] },
        fields: { x: { label: "FOO:", stopLabel: "$END$" } },
        requiredFields: ["x"],
      },
      {
        name: "dup-b",
        sourceType: "email",
        direction: "expense",
        match: { contains: ["FOO"] },
        fields: { x: { label: "FOO:", stopLabel: "$END$" } },
        requiredFields: ["x"],
      },
    ];
    const app = await buildMockServer({ templates: duplicateTemplates });
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: "FOO: bar" },
    });

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(JSON.parse(response.body).error, "Ambiguous template match");
    await app.close();
  });

  it("returns 400 when the source account is not in this tenant's account map", async () => {
    const app = await buildMockServer({ accountMapJson: "{}" });
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Unknown source account");
    await app.close();
  });

  it("does not create a duplicate transaction for the same reference code within TTL", async () => {
    const app = await buildMockServer();
    const first = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(first.statusCode, 200);

    const second = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(JSON.parse(second.body).duplicate, true);
    assert.strictEqual(app.addedTransactions.length, 1);
    await app.close();
  });

  it("does NOT treat two different tenants' identical reference codes as duplicates of each other", async () => {
    const sharedDedupCache = createDedupCache();
    const appAlice = await buildMockServer({ tenantId: "alice", dedupCache: sharedDedupCache });
    const appBob = await buildMockServer({ tenantId: "bob", dedupCache: sharedDedupCache });

    const aliceResponse = await appAlice.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(aliceResponse.statusCode, 200);
    assert.strictEqual(JSON.parse(aliceResponse.body).duplicate, undefined);

    const bobResponse = await appBob.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(bobResponse.statusCode, 200);
    assert.strictEqual(
      JSON.parse(bobResponse.body).duplicate,
      undefined,
      "bob's transaction (same reference code as alice's) must not be treated as a duplicate"
    );

    assert.strictEqual(appAlice.addedTransactions.length, 1);
    assert.strictEqual(appBob.addedTransactions.length, 1);
    await appAlice.close();
    await appBob.close();
  });

  it("returns 500 when sync fails after the transaction is added", async () => {
    const app = await buildMockServer({ syncBehaviour: "fail" });
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(JSON.parse(response.body).error, "Sync failed");
    await app.close();
  });

  it("does not poison the dedup cache when the account is not found in Actual", async () => {
    const app = await buildMockServer({ accounts: [] });
    const first = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(first.statusCode, 400);
    assert.strictEqual(JSON.parse(first.body).error, "Invalid account");

    const second = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(second.statusCode, 400);
    assert.strictEqual(JSON.parse(second.body).error, "Invalid account");
    await app.close();
  });

  it("does not poison the dedup cache when addTransaction fails", async () => {
    const app = await buildMockServer();
    app.mockWorkerClient.addTransactions = async () => {
      throw new Error("Actual is down");
    };

    const first = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(first.statusCode, 500);
    assert.strictEqual(app.addedTransactions.length, 0);

    app.mockWorkerClient.addTransactions = async (accountId, transactions) => {
      app.addedTransactions.push({ accountId, transactions });
      return "ok";
    };

    const second = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(JSON.parse(second.body).duplicate, undefined);
    assert.strictEqual(app.addedTransactions.length, 1);
    await app.close();
  });
});
