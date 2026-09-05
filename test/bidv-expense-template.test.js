const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { normalize, identify, extract } = require("../src/templates");

const TEMPLATES = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/templates.json"), "utf8"));
const FIXTURE = normalize(fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8"));

describe("bidv-expense template (config/templates.json)", () => {
  it("matches the real BIDV expense email fixture", () => {
    const template = identify(FIXTURE, TEMPLATES);
    assert.strictEqual(template?.name, "bidv-expense");
  });

  it("extracts all fields from the real fixture", () => {
    const template = identify(FIXTURE, TEMPLATES);
    const result = extract(FIXTURE, template);
    assert.deepStrictEqual(result, {
      referenceCode: "6247BIDVE2NEKZD1",
      sourceAccountNumber: "8820966012",
      amount: 10000,
      transactionDate: "2026-09-04",
      counterpartyName: "PHAM MANH TUONG",
      description: "PHAM MANH TUONG Chuyen tien · Ref: 6247BIDVE2NEKZD1",
      direction: "expense",
    });
  });

  it("does not match unrelated text", () => {
    assert.strictEqual(identify(normalize("Your OTP code is 123456"), TEMPLATES), null);
  });

  it("does not match a BIDV email lacking the debit-account label (e.g. an income variant)", () => {
    const incomeText = FIXTURE.replace("Tài khoản nguồn:", "Tài khoản đích:");
    assert.strictEqual(identify(incomeText, TEMPLATES), null);
  });
});
