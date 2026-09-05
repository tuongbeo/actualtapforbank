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

// The one message a failed connection attempt is ever allowed to give the caller. The real
// error is logged server-side instead: the underlying connector reports "Budget <id> not
// found. Available: <every sync ID on the shared Actual server>", so forwarding it would let
// any authenticated user enumerate -- and then re-register against -- every other tenant's
// budget.
const CONNECT_FAILURE_MESSAGE = "Could not connect to Actual Budget. Check your sync ID and password.";

// A tenant id doubles as a filesystem path segment (config/tenants/<id>/) that a failed
// registration later rm -rf's, so it must be a single, safe segment. The keycloakSub comes
// from the IdP; this is defence in depth against a malformed or hostile `sub` claim.
const SAFE_ID = /^[A-Za-z0-9._@:-]{1,128}$/;
const isSafeTenantId = (id) => typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..";

// Upper bound on a single registration's connection attempt. The queue below serialises
// registrations, so without this one hung Actual connection (e.g. a downloadBudget that never
// resolves) would block every future registration from every user forever.
const DEFAULT_SPAWN_TIMEOUT_MS = 60000;

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
  timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
  logger = console,
}) => {
  let queue = Promise.resolve();

  const run = async ({ keycloakSub, actualSyncId, actualPassword, actualEncryptionPassword, ...testOnlyFields }) => {
    if (tenantsByKeycloakSub.has(keycloakSub)) {
      return { ok: false, code: 409, error: "Tenant already exists" };
    }

    const id = keycloakSub;
    if (!isSafeTenantId(id)) {
      logger.error(`[tenantProvisioning] rejected registration: unsafe account identifier ${JSON.stringify(id)}`);
      return { ok: false, code: 400, error: "Invalid account identifier" };
    }

    const tenantDir = path.join(path.dirname(tenantsConfigPath), "tenants", id);
    const accountMapPath = path.join(tenantDir, "account-map.json");
    const templatesPath = path.join(tenantDir, "templates.json");

    // A leftover directory (e.g. an operator removed the tenants.json entry but not the
    // directory) must not be silently written into -- and, crucially, must not become the
    // target of this attempt's rm -rf rollback.
    if (fs.existsSync(tenantDir)) {
      logger.error(`[tenantProvisioning] refusing to reuse existing tenant directory ${tenantDir}`);
      return {
        ok: false,
        code: 409,
        error: "Tenant directory already exists",
        message: "Contact an operator to resolve this.",
      };
    }

    // Captured by onSpawn so the timeout branch below can kill the child it stopped waiting
    // for, instead of leaking the process.
    let spawnedChild = null;
    const onSpawn = (child) => {
      spawnedChild = child;
      if (onWorkerSpawned) onWorkerSpawned(child);
    };

    const spawnPromise = spawnOne(
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
      { onSpawn }
    );
    // If the timeout wins the race nobody is left awaiting this promise, so its eventual
    // rejection (killing the child below makes one certain) must not surface as an unhandled
    // rejection.
    spawnPromise.catch(() => {});

    const TIMED_OUT = Symbol("spawn-timeout");
    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });

    let spawned;
    try {
      const outcome = await Promise.race([spawnPromise, timeoutPromise]);
      if (outcome === TIMED_OUT) {
        logger.error(
          `[tenantProvisioning] connection attempt for tenant "${id}" timed out after ${timeoutMs}ms; killing worker`
        );
        if (spawnedChild) spawnedChild.kill();
        // Cover the race where spawnOne resolves anyway between the timeout firing and the
        // kill landing: that resolution owns a live child nobody is tracking as a tenant.
        spawnPromise.then(
          ({ child }) => child.kill(),
          () => {}
        );
        return { ok: false, code: 422, error: "Could not connect to Actual Budget", message: CONNECT_FAILURE_MESSAGE };
      }
      spawned = outcome;
    } catch (err) {
      // Never forward err.message: it can enumerate every budget on the shared Actual server.
      logger.error(`[tenantProvisioning] connection attempt for tenant "${id}" failed: ${err.message}`);
      return { ok: false, code: 422, error: "Could not connect to Actual Budget", message: CONNECT_FAILURE_MESSAGE };
    } finally {
      clearTimeout(timer);
    }

    try {
      const rawTenants = JSON.parse(fs.readFileSync(tenantsConfigPath, "utf8"));

      // Defence in depth over the tenantsByKeycloakSub check above: the in-memory map can
      // disagree with what is actually on disk (another process, a hand-edited tenants.json),
      // and a duplicate id there produces a tenants.json that refuses to load at next boot.
      if (Array.isArray(rawTenants) && rawTenants.some((t) => t && (t.id === id || t.keycloakSub === keycloakSub))) {
        spawned.child.kill();
        return { ok: false, code: 409, error: "Tenant already exists" };
      }

      fs.mkdirSync(tenantDir, { recursive: true });
      fs.writeFileSync(accountMapPath, "{}");
      fs.writeFileSync(templatesPath, "[]");

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
      // As with the connect failure above, the raw error stays server-side -- it can carry
      // filesystem paths and other deployment internals the caller has no business seeing.
      logger.error(`[tenantProvisioning] failed to persist tenant "${id}": ${err.message}`);
      return {
        ok: false,
        code: 500,
        error: "Failed to persist new tenant",
        message: "Registration could not be completed. Contact an operator.",
      };
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
