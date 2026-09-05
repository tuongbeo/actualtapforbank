// src/lib/tenantProvisioning.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnOne } = require("../worker/tenantWorkerPool");
const { createTemplatesStore } = require("../templates/store");
const { createAccountMapStore } = require("./accountMapStore");

const atomicWriteJson = (filePath, data) => {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
};

// One tenant registration at a time: registerTenant() always resolves/rejects to its own
// caller with the real outcome, but the internal queue swallows each attempt's own
// success/failure before chaining the next one, so one caller's rejection never blocks
// (or gets attributed to) the next caller.
const createTenantProvisioner = ({
  tenantsConfigPath,
  actualUrl,
  workerPath,
  tenantsById,
  tenantsByApiKey,
  tenantsByKeycloakSub,
  onWorkerSpawned,
}) => {
  let queue = Promise.resolve();

  const run = async ({ keycloakSub, actualSyncId, actualPassword, actualEncryptionPassword, ...testOnlyFields }) => {
    if (tenantsByKeycloakSub.has(keycloakSub)) {
      return { ok: false, code: 409, error: "Tenant already exists" };
    }

    const id = keycloakSub;
    const tenantDir = path.join(path.dirname(tenantsConfigPath), "tenants", id);
    const accountMapPath = path.join(tenantDir, "account-map.json");
    const templatesPath = path.join(tenantDir, "templates.json");

    let spawned;
    try {
      spawned = await spawnOne(
        {
          // ...testOnlyFields forwards test-only simulation flags (e.g. failInit,
          // exitCleanBeforeReady) that only test/fixtures/fakeTenantWorker.js reads --
          // the real tenantWorker.js destructures just the fields below and ignores
          // anything else, so this is a no-op against production workers.
          ...testOnlyFields,
          id,
          actualUrl,
          syncId: actualSyncId,
          password: actualPassword,
          encryptionPassword: actualEncryptionPassword || "",
        },
        workerPath,
        {},
        { onSpawn: onWorkerSpawned }
      );
    } catch (err) {
      return { ok: false, code: 422, error: "Could not connect to Actual Budget", message: err.message };
    }

    try {
      fs.mkdirSync(tenantDir, { recursive: true });
      fs.writeFileSync(accountMapPath, "{}");
      fs.writeFileSync(templatesPath, "[]");

      const rawTenants = JSON.parse(fs.readFileSync(tenantsConfigPath, "utf8"));
      const apiKey = crypto.randomBytes(32).toString("hex");
      rawTenants.push({
        id,
        apiKey,
        actualSyncId,
        actualPassword,
        actualEncryptionPassword: actualEncryptionPassword || "",
        keycloakSub,
      });
      atomicWriteJson(tenantsConfigPath, rawTenants);

      const tenant = {
        id,
        workerClient: spawned.client,
        templatesStore: createTemplatesStore(templatesPath, []),
        accountMapStore: createAccountMapStore(accountMapPath, "{}"),
        keycloakSub,
      };
      tenantsById.set(id, tenant);
      tenantsByApiKey.set(apiKey, tenant);
      tenantsByKeycloakSub.set(keycloakSub, tenant);

      return { ok: true, id, apiKey };
    } catch (err) {
      spawned.child.kill();
      // Roll back any per-tenant files this attempt may have already written
      // (mkdirSync/account-map.json/templates.json can succeed individually before
      // a later step -- e.g. a corrupt tenants.json or a failed atomic rename --
      // throws) so a failed registration truly leaves no trace on disk.
      try {
        fs.rmSync(tenantDir, { recursive: true, force: true });
      } catch {
        // best-effort: if the filesystem itself is failing there's nothing more to do
      }
      return { ok: false, code: 500, error: "Failed to persist new tenant", message: err.message };
    }
  };

  const registerTenant = (input) => {
    const result = queue.then(() => run(input));
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return { registerTenant };
};

module.exports = { createTenantProvisioner };
