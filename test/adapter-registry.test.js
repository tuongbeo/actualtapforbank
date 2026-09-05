const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { normalize, identify } = require("../src/adapters");
const bidv = require("../src/adapters/bidv");

const RAW_FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8");

describe("adapters/index", () => {
  describe("normalize", () => {
    it("collapses newlines and repeated whitespace into single spaces", () => {
      assert.strictEqual(normalize("Số tham chiếu:\n\n  6247BIDVE2NEKZD1  "), "Số tham chiếu: 6247BIDVE2NEKZD1");
    });
  });

  describe("identify", () => {
    it("returns the BIDV adapter for a BIDV email", () => {
      const adapter = identify(normalize(RAW_FIXTURE));
      assert.strictEqual(adapter, bidv);
    });

    it("returns null when no adapter matches", () => {
      const adapter = identify(normalize("Your OTP code is 123456"));
      assert.strictEqual(adapter, null);
    });
  });
});
