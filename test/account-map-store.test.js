// test/account-map-store.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createAccountMapStore, validateAccountMap } = require("../src/lib/accountMapStore");

const tempPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "account-map-")), "account-map.json");

describe("validateAccountMap", () => {
  it("accepts a flat string-to-non-empty-string object", () => {
    assert.doesNotThrow(() => validateAccountMap({ "123": "Checking" }));
    assert.doesNotThrow(() => validateAccountMap({}));
  });

  it("rejects a non-object", () => {
    assert.throws(() => validateAccountMap(null), /must be a JSON object/);
    assert.throws(() => validateAccountMap([1, 2]), /must be a JSON object/);
    assert.throws(() => validateAccountMap("nope"), /must be a JSON object/);
  });

  it("rejects a non-string or empty-string value", () => {
    assert.throws(() => validateAccountMap({ "123": 42 }), /"123".*non-empty string/);
    assert.throws(() => validateAccountMap({ "123": "" }), /"123".*non-empty string/);
  });
});

describe("createAccountMapStore", () => {
  it("getMapJson returns the initial value", () => {
    const store = createAccountMapStore(tempPath(), '{"1":"Checking"}');
    assert.strictEqual(store.getMapJson(), '{"1":"Checking"}');
  });

  it("replaceAll writes the file and updates the in-memory value", () => {
    const configPath = tempPath();
    const store = createAccountMapStore(configPath, "{}");
    store.replaceAll({ "1": "Checking" });
    assert.strictEqual(JSON.parse(store.getMapJson())["1"], "Checking");
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8"))["1"], "Checking");
  });

  it("replaceAll creates the parent directory if it doesn't exist yet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-map-nodirs-"));
    const configPath = path.join(dir, "tenants", "carol", "account-map.json");
    const store = createAccountMapStore(configPath, "{}");
    store.replaceAll({ "9": "Savings" });
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8"))["9"], "Savings");
  });

  it("replaceAll rejects an invalid map without writing the file or mutating in-memory state", () => {
    const configPath = tempPath();
    fs.writeFileSync(configPath, '{"1":"Checking"}');
    const store = createAccountMapStore(configPath, '{"1":"Checking"}');
    assert.throws(() => store.replaceAll({ "1": 42 }));
    assert.strictEqual(store.getMapJson(), '{"1":"Checking"}');
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), '{"1":"Checking"}');
  });
});
