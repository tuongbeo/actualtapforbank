// test/tenant-provisioning.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTenantProvisioner } = require("../src/lib/tenantProvisioning");

const FAKE_WORKER_PATH = path.join(__dirname, "fixtures/fakeTenantWorker.js");

function setup(initialTenants = [], options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-provisioning-"));
  const tenantsConfigPath = path.join(dir, "tenants.json");
  fs.writeFileSync(tenantsConfigPath, JSON.stringify(initialTenants));
  const tenantsById = new Map();
  const tenantsByApiKey = new Map();
  const tenantsByKeycloakSub = new Map();
  const spawnedChildren = [];
  const logged = [];
  const { registerTenant } = createTenantProvisioner({
    tenantsConfigPath,
    actualUrl: "https://actual.example.com",
    workerPath: FAKE_WORKER_PATH,
    tenantsById,
    tenantsByApiKey,
    tenantsByKeycloakSub,
    onWorkerSpawned: (child) => spawnedChildren.push(child),
    logger: { error: (msg) => logged.push(msg) },
    ...options,
  });
  return {
    registerTenant,
    tenantsConfigPath,
    tenantsById,
    tenantsByApiKey,
    tenantsByKeycloakSub,
    spawnedChildren,
    logged,
  };
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
    assert.strictEqual(JSON.parse(fs.readFileSync(ctx.tenantsConfigPath, "utf8")).length, 0);
    assert.strictEqual(ctx.tenantsByKeycloakSub.has("sub-new"), false);
  });

  // Final-review Finding 2: the connector's own error enumerates every budget sync ID on the
  // shared Actual server ("Budget ... not found. Available: ..."), so a failed registration
  // must never echo it back -- any authenticated user could otherwise harvest other tenants'
  // sync IDs and re-register against them.
  it("never echoes the underlying worker error back to the caller, but does log it", async () => {
    const ctx = setup();

    const result = await ctx.registerTenant({
      keycloakSub: "sub-new",
      actualSyncId: "sync-1",
      actualPassword: "pw",
      failInit: true, // fakeTenantWorker.js replies with "simulated init failure"
    });

    assert.strictEqual(result.message, "Could not connect to Actual Budget. Check your sync ID and password.");
    const serialized = JSON.stringify(result);
    assert.ok(!/simulated init failure/.test(serialized), `leaked worker detail: ${serialized}`);
    assert.ok(!/failed to initialize/.test(serialized), `leaked worker detail: ${serialized}`);
    // ...but an operator can still see what really happened.
    assert.ok(
      ctx.logged.some((line) => /simulated init failure/.test(line)),
      `expected the real error to be logged, got: ${JSON.stringify(ctx.logged)}`
    );
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

  // Final-review Finding 3: the keycloakSub becomes a tenant id, a filesystem path segment,
  // and the target of a best-effort rm -rf on rollback, so it must be validated first.
  it("rejects a keycloakSub that is not a safe path segment, with no side effects", async () => {
    for (const badSub of ["../escape", "sub/with/slash", "..", ".", "", "sub with space", "a".repeat(129)]) {
      const ctx = setup();

      const result = await ctx.registerTenant({
        keycloakSub: badSub,
        actualSyncId: "sync-1",
        actualPassword: "pw",
      });

      assert.deepStrictEqual(
        result,
        { ok: false, code: 400, error: "Invalid account identifier" },
        `expected ${JSON.stringify(badSub)} to be rejected`
      );
      // No worker spawned, nothing written, nothing registered.
      assert.strictEqual(ctx.spawnedChildren.length, 0);
      assert.strictEqual(JSON.parse(fs.readFileSync(ctx.tenantsConfigPath, "utf8")).length, 0);
      assert.strictEqual(fs.existsSync(path.join(path.dirname(ctx.tenantsConfigPath), "tenants")), false);
      assert.strictEqual(ctx.tenantsByKeycloakSub.size, 0);
    }
  });

  it("refuses to register when the tenant directory already exists, and leaves it untouched", async () => {
    const ctx = setup();
    const tenantDir = path.join(path.dirname(ctx.tenantsConfigPath), "tenants", "sub-leftover");
    fs.mkdirSync(tenantDir, { recursive: true });
    fs.writeFileSync(path.join(tenantDir, "templates.json"), '["pre-existing"]');

    const result = await ctx.registerTenant({
      keycloakSub: "sub-leftover",
      actualSyncId: "sync-1",
      actualPassword: "pw",
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 409);
    assert.strictEqual(result.error, "Tenant directory already exists");
    // The pre-existing directory must still be there, contents intact (it must never become
    // the target of this attempt's rollback rm -rf).
    assert.strictEqual(fs.readFileSync(path.join(tenantDir, "templates.json"), "utf8"), '["pre-existing"]');
    assert.strictEqual(ctx.spawnedChildren.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(ctx.tenantsConfigPath, "utf8")).length, 0);
  });

  it("rejects a sub that collides with an on-disk tenant even when the live map is out of sync", async () => {
    // tenants.json already has this id/keycloakSub, but the in-memory map does not (e.g. it
    // was hand-added, or written by another process since boot). Pushing anyway would produce
    // a tenants.json that refuses to load at next boot (duplicate ids).
    const ctx = setup([
      { id: "sub-dup", apiKey: "k", actualSyncId: "s", actualPassword: "p", keycloakSub: "sub-dup" },
    ]);

    const result = await ctx.registerTenant({
      keycloakSub: "sub-dup",
      actualSyncId: "sync-1",
      actualPassword: "pw",
    });

    assert.deepStrictEqual(result, { ok: false, code: 409, error: "Tenant already exists" });
    const onDisk = JSON.parse(fs.readFileSync(ctx.tenantsConfigPath, "utf8"));
    assert.strictEqual(onDisk.length, 1);
    assert.strictEqual(fs.existsSync(path.join(path.dirname(ctx.tenantsConfigPath), "tenants", "sub-dup")), false);
    // The worker spawned for the attempt must not be left running.
    assert.strictEqual(ctx.spawnedChildren.length, 1);
    assert.ok(ctx.spawnedChildren[0].killed || ctx.spawnedChildren[0].exitCode !== null);
  });

  // Final-review Finding 4: registrations are serialised through one in-process queue, so a
  // connection attempt that never settles would deadlock every future registration.
  it("times out a worker that never reports ready, kills it, and unblocks the queue", async () => {
    const ctx = setup([], { timeoutMs: 200 });

    const started = Date.now();
    const result = await ctx.registerTenant({
      keycloakSub: "sub-hangs",
      actualSyncId: "sync-1",
      actualPassword: "pw",
      hangForever: true, // fakeTenantWorker.js: never sends ready, never exits
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 422);
    assert.strictEqual(result.message, "Could not connect to Actual Budget. Check your sync ID and password.");
    assert.ok(Date.now() - started < 5000, "should have given up at the configured timeout");

    // The child must be killed, not leaked.
    assert.strictEqual(ctx.spawnedChildren.length, 1);
    const hungChild = ctx.spawnedChildren[0];
    await new Promise((resolve) => {
      if (hungChild.exitCode !== null || hungChild.signalCode !== null) return resolve();
      hungChild.once("exit", resolve);
    });
    assert.ok(hungChild.exitCode !== null || hungChild.signalCode !== null, "hung worker was left running");

    // ...and the next caller's registration still goes through (the queue is not deadlocked).
    const next = await ctx.registerTenant({
      keycloakSub: "sub-after-hang",
      actualSyncId: "sync-2",
      actualPassword: "pw",
    });
    assert.strictEqual(next.ok, true);

    for (const child of ctx.spawnedChildren) child.kill();
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
