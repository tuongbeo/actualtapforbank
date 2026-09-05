const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const fastify = require("fastify");
const { createTemplatesStore } = require("../src/templates/store");
const { createDedupCache } = require("../src/lib/dedupCache");

const TEMPLATE = {
  name: "hot-reload-test",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["HOTRELOAD-MARKER"] },
  fields: {
    sourceAccountNumber: { label: "Account:", stopLabel: "$END$" },
    amount: { label: "Amount:", type: "amount", stopLabel: "$END2$" },
  },
  requiredFields: ["sourceAccountNumber", "amount"],
};

const SAMPLE_TEXT = "HOTRELOAD-MARKER Account: 123456 $END$ Amount: 10.00 $END2$";

async function buildApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hot-reload-"));
  const templatesPath = path.join(dir, "templates.json");
  fs.writeFileSync(templatesPath, "[]");
  const templatesStore = createTemplatesStore(templatesPath, []);

  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });
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

  app.addHook("preHandler", async (request) => {
    request.tenant = {
      id: "alice",
      workerClient: mockWorkerClient,
      templatesStore,
      accountMapStore: { getMapJson: () => '{"123456":"Checking"}' },
    };
  });

  // Both plugins are registered against the SAME templatesStore instance, exactly as
  // src/server.js does in production (adminTemplates and vietqrTransaction are both
  // registered directly on the top-level `fastify` instance, sharing request.tenant).
  // This is what makes the test prove live/shared state rather than two independent copies.
  await app.register(require("../src/routes/bankTransfer"), { dedupCache: createDedupCache() });
  await app.register(require("../src/routes/adminTemplates"));

  return app;
}

describe("Admin UI hot-reload (no restart required)", () => {
  it("a template created via the admin API is immediately usable by /vietqr-transaction", async () => {
    const app = await buildApp();

    const before = await app.inject({ method: "POST", url: "/bank-transfer", payload: { rawText: SAMPLE_TEXT } });
    assert.strictEqual(before.statusCode, 400);
    assert.strictEqual(JSON.parse(before.body).error, "Unrecognized bank format");

    const createResponse = await app.inject({ method: "POST", url: "/admin/api/templates", payload: TEMPLATE });
    assert.strictEqual(createResponse.statusCode, 200);

    const after = await app.inject({ method: "POST", url: "/bank-transfer", payload: { rawText: SAMPLE_TEXT } });
    assert.strictEqual(after.statusCode, 200);
    assert.strictEqual(app.addedTransactions.length, 1);

    await app.close();
  });

  it("a template deleted via the admin API stops matching on the very next request", async () => {
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/admin/api/templates", payload: TEMPLATE });

    const before = await app.inject({ method: "POST", url: "/bank-transfer", payload: { rawText: SAMPLE_TEXT } });
    assert.strictEqual(before.statusCode, 200);

    await app.inject({ method: "DELETE", url: `/admin/api/templates/${TEMPLATE.name}` });

    const after = await app.inject({ method: "POST", url: "/bank-transfer", payload: { rawText: SAMPLE_TEXT } });
    assert.strictEqual(after.statusCode, 400);

    await app.close();
  });
});
