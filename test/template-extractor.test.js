const { describe, it } = require("node:test");
const assert = require("node:assert");
const { extract } = require("../src/templates/extractor");

const baseTemplate = () => ({
  name: "test-template",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["Code:"] },
  fields: {
    code: { label: ["Code:", "Ref:"], stopLabel: "Amount:" },
    amount: { label: "Amount:", type: "amount", stopLabel: "Date:" },
    txnDate: { label: "Date:", type: "date", format: "DD-MM-YYYY", stopLabel: "Name:" },
    name: { regex: "Name:\\s*(?<value>[A-Za-z ]+)$" },
  },
  requiredFields: ["code", "amount", "txnDate", "name"],
  descriptionSuffix: "Ref: {code}",
});

const TEXT = "Code: Ref: ABC123 Amount: 1234.56 Date: 05-09-2026 Name: John Doe";

describe("extract", () => {
  it("extracts a label chain, an amount field, a date field, and a regex-override field", () => {
    const result = extract(TEXT, baseTemplate());
    assert.strictEqual(result.code, "ABC123");
    assert.strictEqual(result.amount, 1234.56);
    assert.strictEqual(result.txnDate, "2026-09-05");
    assert.strictEqual(result.name, "John Doe");
  });

  it("copies template.direction onto the parsed result", () => {
    const result = extract(TEXT, baseTemplate());
    assert.strictEqual(result.direction, "expense");
  });

  it("builds description from descriptionSuffix when no description field is declared", () => {
    const result = extract(TEXT, baseTemplate());
    assert.strictEqual(result.description, "Ref: ABC123");
  });

  it("appends descriptionSuffix to an existing description field with a middot separator", () => {
    const template = baseTemplate();
    // Real boundary: "Date:" value is terminated by the "Name:" stopLabel in TEXT.
    template.fields.description = { label: "Date:", stopLabel: "Name:" };
    const result = extract(TEXT, template);
    assert.strictEqual(result.description, "05-09-2026 · Ref: ABC123");
  });

  it("omits an optional label field whose stopLabel is absent instead of capturing to end of string", () => {
    const template = baseTemplate();
    template.fields.trailing = { label: "Name:", stopLabel: "NeverAppears:" };
    const result = extract(TEXT, template);
    assert.strictEqual("trailing" in result, false);
  });

  it("throws for a required label field whose stopLabel is absent instead of capturing to end of string", () => {
    const template = baseTemplate();
    template.fields.trailing = { label: "Name:", stopLabel: "NeverAppears:" };
    template.requiredFields.push("trailing");
    assert.throws(() => extract(TEXT, template), /Could not find "trailing"/);
  });

  it("treats an empty capture between a label and its stopLabel as not found", () => {
    const template = {
      name: "empty-capture",
      sourceType: "email",
      direction: "expense",
      match: { contains: ["Note:"] },
      fields: { note: { label: "Note:", stopLabel: "End:" } },
      requiredFields: [],
    };
    const result = extract("Note: End: done", template);
    assert.strictEqual("note" in result, false);
  });

  it("throws when a required field's capture is empty between its label and stopLabel", () => {
    const template = {
      name: "empty-capture-required",
      sourceType: "email",
      direction: "expense",
      match: { contains: ["Note:"] },
      fields: { note: { label: "Note:", stopLabel: "End:" } },
      requiredFields: ["note"],
    };
    assert.throws(() => extract("Note: End: done", template), /Could not find "note"/);
  });

  it("omits an optional field that can't be found instead of throwing", () => {
    const template = baseTemplate();
    template.fields.optional = { label: "Missing:", stopLabel: "$END$" };
    const result = extract(TEXT, template);
    assert.strictEqual("optional" in result, false);
  });

  it("throws when a required field can't be found", () => {
    const template = baseTemplate();
    template.fields.missingRequired = { label: "Nope:", stopLabel: "$END$" };
    template.requiredFields.push("missingRequired");
    assert.throws(() => extract(TEXT, template), /Could not find "missingRequired"/);
  });
});
