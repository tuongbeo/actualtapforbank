const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { loadTenants } = require("../src/lib/tenantRegistry");

const FIXTURE_VALID = path.join(__dirname, "fixtures/tenants/valid/tenants.json");
const FIXTURE_INVALID = path.join(__dirname, "fixtures/tenants/invalid/tenants.json");

describe("loadTenants", () => {
  it("loads a valid tenants.json with its per-tenant account-map and templates", () => {
    const tenants = loadTenants(FIXTURE_VALID);
    assert.strictEqual(tenants.length, 1);
    const [alice] = tenants;
    assert.strictEqual(alice.id, "alice");
    assert.strictEqual(alice.apiKey, "alice-api-key");
    assert.strictEqual(alice.actualSyncId, "8B51B58D-3A0D-4B5B-A41F-DE574306A4F2");
    assert.strictEqual(alice.actualEncryptionPassword, "");
    assert.strictEqual(alice.keycloakSub, null);
    assert.strictEqual(JSON.parse(alice.accountMapJson)["8820966012"], "BIDV Cash");
    assert.strictEqual(alice.templates.length, 1);
    assert.strictEqual(alice.templates[0].name, "test-template");
  });

  it("returns each tenant's resolved templatesPath", () => {
    const tenants = loadTenants(FIXTURE_VALID);
    const [alice] = tenants;
    assert.strictEqual(
      alice.templatesPath,
      path.join(path.dirname(FIXTURE_VALID), "tenants", "alice", "templates.json")
    );
  });

  it("throws listing every problem when required fields are missing", () => {
    assert.throws(() => loadTenants(FIXTURE_INVALID), /"apiKey" is required/);
  });

  it("throws when the tenants file doesn't exist", () => {
    assert.throws(() => loadTenants(path.join(__dirname, "fixtures/tenants/does-not-exist.json")), /not found/);
  });

  it("returns an empty array when tenants.json is []", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-empty-"));
    const emptyPath = path.join(dir, "tenants.json");
    fs.writeFileSync(emptyPath, "[]");
    assert.deepStrictEqual(loadTenants(emptyPath), []);
  });

  it("returns each tenant's resolved accountMapPath", () => {
    const tenants = loadTenants(FIXTURE_VALID);
    const [alice] = tenants;
    assert.strictEqual(
      alice.accountMapPath,
      path.join(path.dirname(FIXTURE_VALID), "tenants", "alice", "account-map.json")
    );
  });

  it("throws on a duplicate tenant id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-dup-"));
    const dupPath = path.join(dir, "tenants.json");
    fs.writeFileSync(
      dupPath,
      JSON.stringify([
        { id: "alice", apiKey: "key-1", actualSyncId: "sync-1", actualPassword: "pw" },
        { id: "alice", apiKey: "key-2", actualSyncId: "sync-2", actualPassword: "pw" },
      ])
    );
    assert.throws(() => loadTenants(dupPath), /duplicate tenant id "alice"/);
  });

  it("defaults accountMapJson to \"{}\" and templates to [] when the per-tenant files don't exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-nofiles-"));
    fs.writeFileSync(
      path.join(dir, "tenants.json"),
      JSON.stringify([{ id: "bob", apiKey: "bob-key", actualSyncId: "sync-1", actualPassword: "pw" }])
    );
    const tenants = loadTenants(path.join(dir, "tenants.json"));
    assert.strictEqual(tenants[0].accountMapJson, "{}");
    assert.deepStrictEqual(tenants[0].templates, []);
  });

  it("throws on a duplicate apiKey across two tenants", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-dup-key-"));
    const dupKeyPath = path.join(dir, "tenants.json");
    fs.writeFileSync(
      dupKeyPath,
      JSON.stringify([
        { id: "alice", apiKey: "shared-key", actualSyncId: "sync-1", actualPassword: "pw1" },
        { id: "bob", apiKey: "shared-key", actualSyncId: "sync-2", actualPassword: "pw2" },
      ])
    );
    assert.throws(() => loadTenants(dupKeyPath), /duplicate apiKey/);
  });

  it("throws when account-map.json is malformed JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-bad-map-"));
    const tenantsDir = path.join(dir, "tenants", "alice");
    fs.mkdirSync(tenantsDir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tenants.json"),
      JSON.stringify([{ id: "alice", apiKey: "key-1", actualSyncId: "sync-1", actualPassword: "pw" }])
    );
    fs.writeFileSync(path.join(tenantsDir, "account-map.json"), "{ invalid json }");
    assert.throws(() => loadTenants(path.join(dir, "tenants.json")), /account-map.json is not valid JSON/);
  });

  it("throws when templates.json fails schema validation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-bad-schema-"));
    const tenantsDir = path.join(dir, "tenants", "alice");
    fs.mkdirSync(tenantsDir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tenants.json"),
      JSON.stringify([{ id: "alice", apiKey: "key-1", actualSyncId: "sync-1", actualPassword: "pw" }])
    );
    // Invalid template: missing required "direction" field
    fs.writeFileSync(
      path.join(tenantsDir, "templates.json"),
      JSON.stringify([
        {
          name: "bad-template",
          sourceType: "email",
          match: { contains: ["test"] },
          fields: { code: { label: "Code:", stopLabel: "$END$" } },
          requiredFields: ["code"],
        },
      ])
    );
    assert.throws(() => loadTenants(path.join(dir, "tenants.json")), /templates.json is invalid/);
  });

  it("throws when top-level tenants.json is malformed JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-bad-json-"));
    const badPath = path.join(dir, "tenants.json");
    fs.writeFileSync(badPath, "{ not valid json ]");
    assert.throws(() => loadTenants(badPath), /not valid JSON/);
  });

  it("throws when array contains a non-object entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-non-obj-"));
    const nonObjPath = path.join(dir, "tenants.json");
    fs.writeFileSync(nonObjPath, JSON.stringify([null]));
    assert.throws(() => loadTenants(nonObjPath), /entry must be an object/);
  });
});
