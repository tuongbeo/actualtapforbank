const { describe, it } = require("node:test");
const assert = require("node:assert");
const { getAccountByName } = require("../src/lib/actualAccounts");

describe("getAccountByName", () => {
  it("returns the account id for a case-insensitive name match", async () => {
    const fastify = { actual: { getAccounts: async () => [{ id: "acc-1", name: "Checking" }] } };
    const result = await getAccountByName(fastify, "checking");
    assert.strictEqual(result.accountId, "acc-1");
  });

  it("returns undefined accountId and the full account list when no match is found", async () => {
    const fastify = { actual: { getAccounts: async () => [{ id: "acc-1", name: "Checking" }] } };
    const result = await getAccountByName(fastify, "Savings");
    assert.strictEqual(result.accountId, undefined);
    assert.deepStrictEqual(result.accounts, [{ id: "acc-1", name: "Checking" }]);
  });
});
