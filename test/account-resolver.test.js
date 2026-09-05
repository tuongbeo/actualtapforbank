const { describe, it } = require("node:test");
const assert = require("node:assert");
const { resolveAccountName } = require("../src/lib/accountResolver");

describe("resolveAccountName", () => {
  it("returns the mapped account name for a known source account number", () => {
    const result = resolveAccountName("8820966012", '{"8820966012":"BIDV Cash"}');
    assert.strictEqual(result, "BIDV Cash");
  });

  it("returns null for an unmapped source account number", () => {
    const result = resolveAccountName("0000000000", '{"8820966012":"BIDV Cash"}');
    assert.strictEqual(result, null);
  });

  it("treats a missing ACCOUNT_MAP as an empty map", () => {
    const result = resolveAccountName("8820966012", undefined);
    assert.strictEqual(result, null);
  });

  it("throws a clear error when ACCOUNT_MAP is not valid JSON", () => {
    assert.throws(() => resolveAccountName("8820966012", "{not json"), /ACCOUNT_MAP is not valid JSON/);
  });
});
