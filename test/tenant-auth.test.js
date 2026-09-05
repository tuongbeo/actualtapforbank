const { describe, it } = require("node:test");
const assert = require("node:assert");
const { buildTenantLookup, resolveTenant } = require("../src/lib/tenantAuth");

const TENANTS = [
  { id: "alice", apiKey: "alice-key", templates: [{ name: "t-alice" }], accountMapJson: '{"1":"Alice Acc"}', keycloakSub: "sub-alice" },
  { id: "bob", apiKey: "bob-key", templates: [{ name: "t-bob" }], accountMapJson: '{"2":"Bob Acc"}', keycloakSub: "sub-bob" },
];

describe("buildTenantLookup / resolveTenant", () => {
  it("resolves a valid API key to the matching tenant's own data", () => {
    const workerClients = new Map([
      ["alice", { getAccounts: async () => "alice-worker" }],
      ["bob", { getAccounts: async () => "bob-worker" }],
    ]);
    const { tenantsByApiKey } = buildTenantLookup(TENANTS, workerClients);

    const alice = resolveTenant(tenantsByApiKey, "alice-key");
    assert.strictEqual(alice.id, "alice");
    assert.strictEqual(alice.workerClient, workerClients.get("alice"));
    assert.strictEqual(alice.templates[0].name, "t-alice");
    assert.strictEqual(alice.accountMapJson, '{"1":"Alice Acc"}');
    assert.strictEqual(alice.keycloakSub, "sub-alice");
  });

  it("returns null for an unknown or missing API key", () => {
    const { tenantsByApiKey } = buildTenantLookup(TENANTS, new Map());
    assert.strictEqual(resolveTenant(tenantsByApiKey, "not-a-real-key"), null);
    assert.strictEqual(resolveTenant(tenantsByApiKey, undefined), null);
  });

  it("never cross-resolves one tenant's API key to another tenant's data", () => {
    const workerClients = new Map([
      ["alice", { tag: "alice-worker" }],
      ["bob", { tag: "bob-worker" }],
    ]);
    const { tenantsByApiKey } = buildTenantLookup(TENANTS, workerClients);

    const viaAliceKey = resolveTenant(tenantsByApiKey, "alice-key");
    const viaBobKey = resolveTenant(tenantsByApiKey, "bob-key");
    assert.strictEqual(viaAliceKey.workerClient.tag, "alice-worker");
    assert.strictEqual(viaBobKey.workerClient.tag, "bob-worker");
    assert.notStrictEqual(viaAliceKey.id, viaBobKey.id);
  });
});
