const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createMessageHandler } = require("../src/worker/workerProtocol");

const fakeActualClient = (overrides = {}) => ({
  getAccounts: async () => [{ id: "acc-1", name: "Checking" }],
  getPayees: async () => [{ id: "payee-1", name: "Test" }],
  addTransactions: async (accountId, transactions) => "ok",
  sync: async () => {},
  actualInternalSend: async (method, params) => ({ method, params }),
  ...overrides,
});

describe("createMessageHandler", () => {
  it("routes getAccounts and returns the result with the matching requestId", async () => {
    const handle = createMessageHandler(fakeActualClient());
    const reply = await handle({ requestId: "r1", method: "getAccounts", args: [] });
    assert.deepStrictEqual(reply, { requestId: "r1", result: [{ id: "acc-1", name: "Checking" }] });
  });

  it("routes addTransactions with its args in order", async () => {
    const received = [];
    const client = fakeActualClient({
      addTransactions: async (accountId, transactions) => {
        received.push(accountId, transactions);
        return "ok";
      },
    });
    const handle = createMessageHandler(client);
    const reply = await handle({ requestId: "r2", method: "addTransactions", args: ["acc-1", [{ id: "t1" }]] });
    assert.deepStrictEqual(reply, { requestId: "r2", result: "ok" });
    assert.deepStrictEqual(received, ["acc-1", [{ id: "t1" }]]);
  });

  it("routes actualInternalSend with its args in order", async () => {
    const handle = createMessageHandler(fakeActualClient());
    const reply = await handle({ requestId: "r3", method: "actualInternalSend", args: ["api/payees-get-nearby", { latitude: 1 }] });
    assert.deepStrictEqual(reply, { requestId: "r3", result: { method: "api/payees-get-nearby", params: { latitude: 1 } } });
  });

  it("returns an error reply (not a throw) for an unknown method", async () => {
    const handle = createMessageHandler(fakeActualClient());
    const reply = await handle({ requestId: "r4", method: "notAMethod", args: [] });
    assert.strictEqual(reply.requestId, "r4");
    assert.ok(reply.error.message.includes("notAMethod"));
  });

  it("returns an error reply (not a throw) when the underlying client rejects", async () => {
    const client = fakeActualClient({ sync: async () => { throw new Error("boom"); } });
    const handle = createMessageHandler(client);
    const reply = await handle({ requestId: "r5", method: "sync", args: [] });
    assert.deepStrictEqual(reply, { requestId: "r5", error: { message: "boom" } });
  });
});
