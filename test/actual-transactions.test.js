const { describe, it } = require("node:test");
const assert = require("node:assert");
const { addTransaction, syncBudget } = require("../src/lib/actualTransactions");

function fakeFastify({ addResult = "ok", syncBehaviour = "success" } = {}) {
  return {
    actual: {
      addTransactions: async () => addResult,
      sync: async () => {
        if (syncBehaviour === "fail") throw new Error("PostError: unauthorized");
      },
    },
    log: { info: () => {}, error: () => {} },
  };
}

describe("addTransaction", () => {
  it('resolves without error when Actual returns "ok"', async () => {
    const fastify = fakeFastify();
    await assert.doesNotReject(() => addTransaction(fastify, "acc-1", { id: "t1" }));
  });

  it("throws when Actual returns an error result", async () => {
    const fastify = fakeFastify({ addResult: { errors: ["boom"] } });
    await assert.rejects(() => addTransaction(fastify, "acc-1", { id: "t1" }), /boom/);
  });
});

describe("syncBudget", () => {
  it("returns { ok: true } when sync succeeds", async () => {
    const fastify = fakeFastify({ syncBehaviour: "success" });
    const result = await syncBudget(fastify);
    assert.strictEqual(result.ok, true);
  });

  it("returns { ok: false, error } when sync fails", async () => {
    const fastify = fakeFastify({ syncBehaviour: "fail" });
    const result = await syncBudget(fastify);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error instanceof Error);
  });
});
