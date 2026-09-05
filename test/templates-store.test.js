const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTemplatesStore } = require("../src/templates/store");

const VALID_TEMPLATE = {
  name: "a",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["Foo"] },
  fields: { x: { label: "Foo:", stopLabel: "$END$" } },
  requiredFields: ["x"],
};

function tempConfigPath(initialContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "templates-store-"));
  const configPath = path.join(dir, "templates.json");
  fs.writeFileSync(configPath, JSON.stringify(initialContent));
  return configPath;
}

describe("createTemplatesStore", () => {
  it("getTemplates() returns the initial array passed in", () => {
    const configPath = tempConfigPath([VALID_TEMPLATE]);
    const store = createTemplatesStore(configPath, [VALID_TEMPLATE]);
    assert.deepStrictEqual(store.getTemplates(), [VALID_TEMPLATE]);
  });

  it("replaceAll() writes the file and updates in-memory state on a valid array", () => {
    const configPath = tempConfigPath([]);
    const store = createTemplatesStore(configPath, []);
    const second = { ...VALID_TEMPLATE, name: "b" };

    store.replaceAll([VALID_TEMPLATE, second]);

    assert.deepStrictEqual(store.getTemplates(), [VALID_TEMPLATE, second]);
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepStrictEqual(onDisk, [VALID_TEMPLATE, second]);
  });

  it("replaceAll() rejects an invalid array without writing the file or mutating state", () => {
    const configPath = tempConfigPath([VALID_TEMPLATE]);
    const store = createTemplatesStore(configPath, [VALID_TEMPLATE]);
    const beforeMtime = fs.statSync(configPath).mtimeMs;
    const beforeContent = fs.readFileSync(configPath, "utf8");

    const invalid = [{ name: "bad" }]; // missing sourceType/direction/match/fields/requiredFields

    assert.throws(() => store.replaceAll(invalid));
    assert.deepStrictEqual(store.getTemplates(), [VALID_TEMPLATE]);
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), beforeContent);
    assert.strictEqual(fs.statSync(configPath).mtimeMs, beforeMtime);
  });

  it("replaceAll() catches a duplicate name across the whole resulting array", () => {
    const configPath = tempConfigPath([VALID_TEMPLATE]);
    const store = createTemplatesStore(configPath, [VALID_TEMPLATE]);
    const duplicate = { ...VALID_TEMPLATE }; // same name "a"

    assert.throws(() => store.replaceAll([VALID_TEMPLATE, duplicate]), /name/i);
    assert.deepStrictEqual(store.getTemplates(), [VALID_TEMPLATE]);
  });

  it("replaceAll() creates the parent directory when it doesn't exist yet (a tenant with no prior templates.json)", () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "templates-store-nofile-"));
    const nestedConfigPath = path.join(parentDir, "tenants", "brand-new-tenant", "templates.json");
    const store = createTemplatesStore(nestedConfigPath, []); // the "tenants/brand-new-tenant/" dir doesn't exist yet

    store.replaceAll([VALID_TEMPLATE]);

    assert.deepStrictEqual(store.getTemplates(), [VALID_TEMPLATE]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(nestedConfigPath, "utf8")), [VALID_TEMPLATE]);
  });
});
