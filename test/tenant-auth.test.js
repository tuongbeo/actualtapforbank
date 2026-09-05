const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { buildTenantLookup, resolveTenant, resolveTenantByKeycloakSub } = require("../src/lib/tenantAuth");

function tempTemplatesPath(initialContent = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-auth-"));
  const templatesPath = path.join(dir, "templates.json");
  fs.writeFileSync(templatesPath, JSON.stringify(initialContent));
  return templatesPath;
}

const validTemplate = (name) => ({
  name,
  sourceType: "email",
  direction: "expense",
  match: { contains: [name] },
  fields: { amount: { regex: "(?<value>\\d+\\.\\d{2})" } },
  requiredFields: [],
});

const buildTenants = () => [
  {
    id: "alice",
    apiKey: "alice-key",
    templates: [validTemplate("t-alice")],
    templatesPath: tempTemplatesPath([validTemplate("t-alice")]),
    accountMapJson: '{"1":"Alice Acc"}',
    keycloakSub: "sub-alice",
  },
  {
    id: "bob",
    apiKey: "bob-key",
    templates: [validTemplate("t-bob")],
    templatesPath: tempTemplatesPath([validTemplate("t-bob")]),
    accountMapJson: '{"2":"Bob Acc"}',
    keycloakSub: null,
  },
];

describe("buildTenantLookup / resolveTenant", () => {
  it("resolves a valid API key to the matching tenant's own data, with a templatesStore (not a raw array)", () => {
    const workerClients = new Map([
      ["alice", { getAccounts: async () => "alice-worker" }],
      ["bob", { getAccounts: async () => "bob-worker" }],
    ]);
    const { tenantsByApiKey } = buildTenantLookup(buildTenants(), workerClients);

    const alice = resolveTenant(tenantsByApiKey, "alice-key");
    assert.strictEqual(alice.id, "alice");
    assert.strictEqual(alice.workerClient, workerClients.get("alice"));
    assert.strictEqual(typeof alice.templatesStore.getTemplates, "function");
    assert.strictEqual(typeof alice.templatesStore.replaceAll, "function");
    assert.deepStrictEqual(alice.templatesStore.getTemplates(), [validTemplate("t-alice")]);
    assert.strictEqual(alice.accountMapJson, '{"1":"Alice Acc"}');
    assert.strictEqual(alice.keycloakSub, "sub-alice");
  });

  it("returns null for an unknown or missing API key", () => {
    const { tenantsByApiKey } = buildTenantLookup(buildTenants(), new Map());
    assert.strictEqual(resolveTenant(tenantsByApiKey, "not-a-real-key"), null);
    assert.strictEqual(resolveTenant(tenantsByApiKey, undefined), null);
  });

  it("never cross-resolves one tenant's API key to another tenant's data", () => {
    const workerClients = new Map([
      ["alice", { tag: "alice-worker" }],
      ["bob", { tag: "bob-worker" }],
    ]);
    const { tenantsByApiKey } = buildTenantLookup(buildTenants(), workerClients);

    const viaAliceKey = resolveTenant(tenantsByApiKey, "alice-key");
    const viaBobKey = resolveTenant(tenantsByApiKey, "bob-key");
    assert.strictEqual(viaAliceKey.workerClient.tag, "alice-worker");
    assert.strictEqual(viaBobKey.workerClient.tag, "bob-worker");
    assert.notStrictEqual(viaAliceKey.id, viaBobKey.id);
  });

  it("each tenant's templatesStore.replaceAll() is independent (writes only that tenant's file)", () => {
    const tenants = buildTenants();
    const { tenantsByApiKey } = buildTenantLookup(tenants, new Map());
    const alice = resolveTenant(tenantsByApiKey, "alice-key");
    const bob = resolveTenant(tenantsByApiKey, "bob-key");

    alice.templatesStore.replaceAll([validTemplate("t-alice-v2")]);

    assert.deepStrictEqual(alice.templatesStore.getTemplates(), [validTemplate("t-alice-v2")]);
    assert.deepStrictEqual(bob.templatesStore.getTemplates(), [validTemplate("t-bob")]);
    const bobOnDisk = JSON.parse(fs.readFileSync(tenants[1].templatesPath, "utf8"));
    assert.deepStrictEqual(bobOnDisk, [validTemplate("t-bob")]);
  });
});

describe("resolveTenantByKeycloakSub", () => {
  it("resolves a configured keycloakSub to its tenant", () => {
    const { tenantsByKeycloakSub } = buildTenantLookup(buildTenants(), new Map());
    const alice = resolveTenantByKeycloakSub(tenantsByKeycloakSub, "sub-alice");
    assert.strictEqual(alice.id, "alice");
  });

  it("returns null for an unknown sub", () => {
    const { tenantsByKeycloakSub } = buildTenantLookup(buildTenants(), new Map());
    assert.strictEqual(resolveTenantByKeycloakSub(tenantsByKeycloakSub, "not-a-real-sub"), null);
  });

  it("does not register tenants whose keycloakSub is null", () => {
    const { tenantsByKeycloakSub } = buildTenantLookup(buildTenants(), new Map());
    assert.strictEqual(resolveTenantByKeycloakSub(tenantsByKeycloakSub, null), null);
    assert.strictEqual(tenantsByKeycloakSub.size, 1); // only alice
  });
});
