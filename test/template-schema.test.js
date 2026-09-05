const { describe, it } = require("node:test");
const assert = require("node:assert");
const { validateTemplates } = require("../src/templates/schema");

const validTemplate = () => ({
  name: "test-template",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["Foo"] },
  fields: {
    code: { label: "Code:", stopLabel: "Amount:" },
  },
  requiredFields: ["code"],
});

describe("validateTemplates", () => {
  it("accepts a well-formed template array", () => {
    assert.doesNotThrow(() => validateTemplates([validTemplate()]));
  });

  it("throws when the top level isn't an array", () => {
    assert.throws(() => validateTemplates({}), /must be an array/);
  });

  it("throws when name is missing", () => {
    const template = validTemplate();
    delete template.name;
    assert.throws(() => validateTemplates([template]), /"name" is required/);
  });

  it("throws when sourceType is not email or push", () => {
    const template = { ...validTemplate(), sourceType: "sms" };
    assert.throws(() => validateTemplates([template]), /"sourceType" must be "email" or "push"/);
  });

  it("throws when direction is not expense or income", () => {
    const template = { ...validTemplate(), direction: "transfer" };
    assert.throws(() => validateTemplates([template]), /"direction" must be "expense" or "income"/);
  });

  it("throws when match.contains is empty", () => {
    const template = { ...validTemplate(), match: { contains: [] } };
    assert.throws(() => validateTemplates([template]), /"match.contains" is required/);
  });

  it("throws when a field declares neither regex nor label", () => {
    const template = validTemplate();
    template.fields.code = {};
    assert.throws(() => validateTemplates([template]), /must declare exactly one of "regex" or "label"/);
  });

  it("throws when a field declares both regex and label", () => {
    const template = validTemplate();
    template.fields.code = { label: "Code:", regex: "Code:\\s*(?<value>.+)" };
    assert.throws(() => validateTemplates([template]), /must declare exactly one of "regex" or "label"/);
  });

  it("throws when a regex field has no named group value", () => {
    const template = validTemplate();
    template.fields.code = { regex: "Code:\\s*(.+)" };
    assert.throws(() => validateTemplates([template]), /named capture group "value"/);
  });

  it("throws when a regex field also declares stopLabel", () => {
    const template = validTemplate();
    template.fields.code = { regex: "Code:\\s*(?<value>.+)", stopLabel: "End:" };
    assert.throws(() => validateTemplates([template]), /"stopLabel" is not allowed alongside "regex"/);
  });

  it("throws when a label-based field has no stopLabel", () => {
    const template = validTemplate();
    template.fields.code = { label: "Code:" };
    assert.throws(() => validateTemplates([template]), /"stopLabel" is required/);
  });

  it("accepts an array label (a label chain)", () => {
    const template = validTemplate();
    template.fields.code = { label: ["Code:", "Ref:"], stopLabel: "Amount:" };
    assert.doesNotThrow(() => validateTemplates([template]));
  });

  it("throws when type is 'date' without a format", () => {
    const template = validTemplate();
    template.fields.code = { label: "Code:", stopLabel: "Amount:", type: "date" };
    assert.throws(() => validateTemplates([template]), /"format" is required/);
  });

  it("throws when a date format is missing a required token", () => {
    const template = validTemplate();
    template.fields.code = { label: "Code:", stopLabel: "Amount:", type: "date", format: "HH:mm:ss" };
    assert.throws(() => validateTemplates([template]), /must include YYYY/);
  });

  it("throws when requiredFields references an unknown field", () => {
    const template = { ...validTemplate(), requiredFields: ["code", "missing"] };
    assert.throws(() => validateTemplates([template]), /references unknown field "missing"/);
  });

  it("throws when descriptionSuffix references an unknown field", () => {
    const template = { ...validTemplate(), descriptionSuffix: "Ref: {missing}" };
    assert.throws(() => validateTemplates([template]), /"descriptionSuffix" references unknown field "missing"/);
  });

  it("throws when two templates share the same name", () => {
    assert.throws(
      () => validateTemplates([validTemplate(), validTemplate()]),
      /Duplicate template name/
    );
  });

  it("throws when a regex has a spoofed named-group substring but no actual named group", () => {
    const template = validTemplate();
    template.fields.code = { regex: "(?:foo)?<value>(bar)" };
    assert.throws(() => validateTemplates([template]), /named capture group "value"/);
  });

  it("throws when templates array contains null", () => {
    assert.throws(() => validateTemplates([null]), /non-null object/);
  });

  it("throws when a field is null", () => {
    const template = validTemplate();
    template.fields.code = null;
    assert.throws(() => validateTemplates([template]), /non-null object/);
  });
});
