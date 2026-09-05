const { describe, it } = require("node:test");
const assert = require("node:assert");
const { parseAmount } = require("../src/lib/parseAmount");

describe("parseAmount", () => {
  it("parses a plain integer string", () => {
    assert.strictEqual(parseAmount("10000"), 10000);
  });

  it("strips a currency symbol and trailing unit text", () => {
    assert.strictEqual(parseAmount("£12.34"), 12.34);
    assert.strictEqual(parseAmount("10,000 VND"), 10000);
  });

  it("treats a comma as a thousands separator when 3 digits follow it", () => {
    assert.strictEqual(parseAmount("10,000"), 10000);
  });

  it("treats a comma as a decimal separator when it isn't followed by exactly 3 digits", () => {
    assert.strictEqual(parseAmount("12,34"), 12.34);
  });

  it("treats the later of comma/dot as the decimal separator when both are present", () => {
    assert.strictEqual(parseAmount("1.234,56"), 1234.56);
    assert.strictEqual(parseAmount("1,234.56"), 1234.56);
  });
});
