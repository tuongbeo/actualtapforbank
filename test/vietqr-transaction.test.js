const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const fastify = require("fastify");
const { createDedupCache } = require("../src/lib/dedupCache");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8");

async function buildMockServer({
  accountMap = '{"8820966012":"BIDV Cash"}',
  accounts = [{ id: "acc-1", name: "BIDV Cash" }],
  syncBehaviour = "success",
} = {}) {
  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });

  app.decorate("config", { API_KEY: "test-key", ACCOUNT_MAP: accountMap });

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) return;
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== app.config.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  const addedTransactions = [];
  app.decorate("actual", {
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
  });
  app.decorate("addedTransactions", addedTransactions);

  await app.register(require("../src/routes/vietqrTransaction"), { dedupCache: createDedupCache() });

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
    assert.ok(body.notes.includes("6247BIDVE2NEKZD1"));
    assert.strictEqual(app.addedTransactions.length, 1);
    assert.strictEqual(app.addedTransactions[0].accountId, "acc-1");
    await app.close();
  });

  it("returns 400 when no adapter matches", async () => {
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

  it("returns 422 for a BIDV email missing Tài khoản nguồn (unsupported income format)", async () => {
    const app = await buildMockServer();
    const incomeText = FIXTURE.replace("Tài khoản nguồn:", "Tài khoản đích:");
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: incomeText },
    });

    assert.strictEqual(response.statusCode, 422);
    assert.strictEqual(JSON.parse(response.body).error, "Failed to parse transaction");
    await app.close();
  });

  it("returns 400 when the source account is not in ACCOUNT_MAP", async () => {
    const app = await buildMockServer({ accountMap: "{}" });
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
});
