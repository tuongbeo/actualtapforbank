const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const bidv = require("../src/adapters/bidv");

// The adapter expects normalized (single-spaced) text — inline the same
// collapse logic Task 5 will centralize in src/adapters/index.js, so this
// test doesn't depend on that task's existence.
const normalize = (text) => text.replace(/\s+/g, " ").trim();

const FIXTURE = normalize(fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8"));

describe("BIDV adapter", () => {
  describe("match", () => {
    it("matches a genuine BIDV transaction email", () => {
      assert.strictEqual(bidv.match(FIXTURE), true);
    });

    it("does not match unrelated text", () => {
      assert.strictEqual(bidv.match("Your OTP code is 123456"), false);
    });

    it("does not match a BIDV email missing the reference number label", () => {
      const text = FIXTURE.replace("Số tham chiếu:", "");
      assert.strictEqual(bidv.match(text), false);
    });
  });

  describe("parse", () => {
    it("extracts all fields from a real BIDV expense email", () => {
      const result = bidv.parse(FIXTURE);
      assert.deepStrictEqual(result, {
        direction: "expense",
        amount: 10000,
        transactionDate: "2026-09-04",
        referenceCode: "6247BIDVE2NEKZD1",
        sourceAccountNumber: "8820966012",
        counterpartyName: "PHAM MANH TUONG",
        description: "PHAM MANH TUONG Chuyen tien · Ref: 6247BIDVE2NEKZD1",
      });
    });

    it("throws when Tài khoản nguồn is missing (unsupported income format)", () => {
      const text = FIXTURE.replace("Tài khoản nguồn:", "Tài khoản đích:");
      assert.throws(() => bidv.parse(text), /not supported yet/);
    });

    it("parses a company beneficiary name containing digits", () => {
      // FIXTURE is already normalized (newlines collapsed to single spaces), so the
      // replace target must match the normalized form, not the raw fixture's newlines.
      const text = FIXTURE.replace(
        "PHAM MANH TUONG Số tài khoản/Số thẻ thụ hưởng:",
        "CTY TNHH 3M VIET NAM Số tài khoản/Số thẻ thụ hưởng:"
      );
      assert.notStrictEqual(text, FIXTURE, "replace() did not match the fixture text as expected");
      const result = bidv.parse(normalize(text));
      assert.strictEqual(result.counterpartyName, "CTY TNHH 3M VIET NAM");
    });
  });
});
