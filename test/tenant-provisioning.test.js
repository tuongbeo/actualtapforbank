// test/tenant-provisioning.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTenantProvisioner } = require("../src/lib/tenantProvisioning");

const FAKE_WORKER_PATH = path.join(__dirname, "fixtures/fakeTenantWorker.js");

function setup(initialTenants = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-provisioning-"));
  const tenantsConfigPath = path.join(dir, "tenants.json");
  fs.writeFileSync(tenantsConfigPath, JSON.stringify(initialTenants));
  const tenantsById = new Map();
  const tenantsByApiKey = new Map();
  const tenantsByKeycloakSub = new Map();
  const spawnedChildren = [];
  const { registerTenant } = createTenantProvisioner({
    tenantsConfigPath,
    actualUrl: "https://actual.example.com",
    workerPath: FAKE_WORKER_PATH,
    tenantsById,
    tenantsByApiKey,
    tenantsByKeycloakSub,
    onWorkerSpawned: (child) => spawnedChildren.push(child),
  });
  return { registerTenant, tenantsConfigPath, tenantsById, tenantsByApiKey, tenantsByKeycloakSub, spawnedChildren };
}

describe("registerTenant", () => {
  it("rejects a keycloakSub that already has a tenant, with no side effects", async () => {
    const ctx = setup();
    ctx.tenantsByKeycloakSub.set("sub-existing", { id: "sub-existing" });

    const result = await ctx.registerTenant({
      keycloakSub: "sub-existing",
      actualSyncId: "sync-1",
      actualPassword: "pw",
    });

    assert.deepStrictEqual(result, { ok: false, code: 409, error: "Tenant already exists" });
    assert.strictEqual(JSON.parse(fs.readFileSync(ctx.tenantsConfigPath, "utf8")).length, 0);
  });

  it("rejects bad Actual credentials with no file written, no live-map entry, and no leaked worker", async () => {
    const ctx = setup();

    const result = await ctx.registerTenant({
      keycloakSub: "sub-new",
      actualSyncId: "sync-1",
      actualPassword: "pw",
      failInit: true, // fakeTenantWorker.js reads this field from the sent tenant object
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 422);
    assert.strictEqual(result.error, "Could not connect to Actual Budget");
    assert.match(result.message, /failed to initialize/);
    assert.strictEqual(JSON.parse(fs.readFileSync(ctx.tenantsConfigPath, "utf8")).length, 0);
    assert.strictEqual(ctx.tenantsByKeycloakSub.has("sub-new"), false);
  });

  it("on success: writes tenants.json + per-tenant files, updates all three live maps, returns a fresh apiKey", async () => {
    const ctx = setup();

    const result = await ctx.registerTenant({
      keycloakSub: "sub-new",
      actualSyncId: "sync-1",
      actualPassword: "pw",
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.id, "sub-new");
    assert.strictEqual(typeof result.apiKey, "string");
    assert.ok(result.apiKey.length >= 32);

    const onDisk = JSON.parse(fs.readFileSync(ctx.tenantsConfigPath, "utf8"));
    assert.strictEqual(onDisk.length, 1);
    assert.strictEqual(onDisk[0].id, "sub-new");
    assert.strictEqual(onDisk[0].apiKey, result.apiKey);
    assert.strictEqual(onDisk[0].keycloakSub, "sub-new");

    const tenantDir = path.join(path.dirname(ctx.tenantsConfigPath), "tenants", "sub-new");
    assert.strictEqual(fs.readFileSync(path.join(tenantDir, "account-map.json"), "utf8"), "{}");
    assert.strictEqual(fs.readFileSync(path.join(tenantDir, "templates.json"), "utf8"), "[]");

    assert.ok(ctx.tenantsById.has("sub-new"));
    assert.strictEqual(ctx.tenantsByApiKey.get(result.apiKey).id, "sub-new");
    assert.strictEqual(ctx.tenantsByKeycloakSub.get("sub-new").id, "sub-new");
    assert.strictEqual(ctx.spawnedChildren.length, 1);

    ctx.spawnedChildren[0].kill();
  });

  it("serializes two near-simultaneous registrations so tenants.json is never corrupted", async () => {
    const ctx = setup();

    const [r1, r2] = await Promise.all([
      ctx.registerTenant({ keycloakSub: "sub-a", actualSyncId: "sync-a", actualPassword: "pw" }),
      ctx.registerTenant({ keycloakSub: "sub-b", actualSyncId: "sync-b", actualPassword: "pw" }),
    ]);

    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    const onDisk = JSON.parse(fs.readFileSync(ctx.tenantsConfigPath, "utf8"));
    assert.strictEqual(onDisk.length, 2);
    assert.notStrictEqual(onDisk[0].apiKey, onDisk[1].apiKey);

    for (const child of ctx.spawnedChildren) child.kill();
  });
});
