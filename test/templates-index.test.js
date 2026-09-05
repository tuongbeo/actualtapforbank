const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { loadTemplates, normalize, identify, extract, AmbiguousMatchError } = require("../src/templates");

describe("loadTemplates", () => {
  it("returns an empty array when the config file doesn't exist", () => {
    const result = loadTemplates(path.join(__dirname, "fixtures/templates/does-not-exist.json"));
    assert.deepStrictEqual(result, []);
  });

  it("loads and validates a well-formed config file", () => {
    const result = loadTemplates(path.join(__dirname, "fixtures/templates/valid-templates.json"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "test-valid");
  });

  it("throws when the config file fails validation", () => {
    assert.throws(
      () => loadTemplates(path.join(__dirname, "fixtures/templates/invalid-templates.json")),
      /"name" is required/
    );
  });
});

describe("normalize", () => {
  it("collapses newlines and repeated whitespace into single spaces", () => {
    assert.strictEqual(normalize("Số tham chiếu:\n\n  6247BIDVE2NEKZD1  "), "Số tham chiếu: 6247BIDVE2NEKZD1");
  });
});

describe("re-exports", () => {
  it("re-exports identify, extract, and AmbiguousMatchError", () => {
    assert.strictEqual(typeof identify, "function");
    assert.strictEqual(typeof extract, "function");
    assert.strictEqual(typeof AmbiguousMatchError, "function");
  });
});
