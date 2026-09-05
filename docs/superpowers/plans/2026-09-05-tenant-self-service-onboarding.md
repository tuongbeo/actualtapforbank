# Tenant Self-Service Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Keycloak-authenticated user provision their own ActualTap tenant (Actual Budget connection + account-map + templates) through the admin UI, without an operator hand-editing `config/tenants.json` and restarting the server — and let the server boot with zero tenants configured.

**Architecture:** A new `tenantProvisioning.js` module test-connects a candidate tenant's Actual credentials via a single dynamically-spawned worker (`spawnOne`, extracted from the existing `spawnAll`), then — only on success — persists a new `config/tenants.json` entry and per-tenant config files, and inserts the new tenant directly into the same live `Map` instances (`tenantsById`/`tenantsByApiKey`/`tenantsByKeycloakSub`) every request-handling hook already reads by reference. `auth.js`'s guard hook is extended to let an authenticated-but-unregistered user reach a small registration API instead of a hard `403`. Account-map gains a hot-reloadable store + CRUD API mirroring the existing templates store/CRUD. `/vietqr-transaction` is renamed to `/bank-transfer`.

**Tech Stack:** Fastify 5, Node's built-in `node:test`, `node:child_process.fork`, `node:crypto`, `node:fs`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-tenant-self-service-onboarding-design.md` (this plan implements it in full — all 13 of its sections).

This plan builds directly on the code shipped by the multi-tenant and admin-UI branches (not on `main`, which currently has that work reverted pending this and related follow-up work) — every file path and interface below is taken from the real, current source, not from the original specs' assumptions.

## Global Constraints

- No new npm dependencies — `crypto`/`fs`/`path`/`os` are Node builtins already used elsewhere in this codebase.
- A self-registered tenant's `id` is its Keycloak `sub` verbatim (already unique per user; no separate identifier is generated).
- `apiKey` for a self-registered tenant is generated server-side: `crypto.randomBytes(32).toString("hex")`.
- `config/tenants.json` containing `[]` must be accepted at boot (a missing or unparseable file remains a fail-fast error — only the *empty-but-valid* case changes).
- `/vietqr-transaction` is renamed to `/bank-transfer` with **no compatibility alias** — confirmed as a clean breaking change.
- The session cookie's `Path` must be `` `${basePath}/admin` `` where `basePath` is `new URL(APP_BASE_URL).pathname` with any trailing slash stripped (empty string for a root-domain deployment) — never a hardcoded `/admin`.
- No self-service tenant *deletion* in this plan.
- Every mutating store (`accountMapStore.replaceAll`, `tenantProvisioning`'s persistence) validates/test-connects **before** touching disk or in-memory state — a failure leaves everything exactly as it was.

---

### Task 1: `tenantRegistry.js` — accept an empty tenants array; return `accountMapPath`

**Files:**
- Modify: `src/lib/tenantRegistry.js`
- Test: `test/tenant-registry.test.js`

**Interfaces:**
- Produces: `loadTenants(tenantsConfigPath)` now returns `[]` (not a throw) for a `tenants.json` containing `[]`; each returned tenant object also carries `accountMapPath` (mirrors the existing `templatesPath`).

- [ ] **Step 1: Update the failing/changing tests first**

Replace the existing "throws when the array is empty" test in `test/tenant-registry.test.js` with one asserting the new behavior, and add a test for `accountMapPath`:

```js
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
```

Remove the old `it("throws when the array is empty", ...)` block entirely (it asserted the opposite of the new required behavior).

- [ ] **Step 2: Run the suite to see the new tests fail**

Run: `node --test test/tenant-registry.test.js`
Expected: the two new/changed tests FAIL (empty array still throws; `accountMapPath` is `undefined`).

- [ ] **Step 3: Implement**

In `src/lib/tenantRegistry.js`, change the top-level array check:

```js
  if (!Array.isArray(rawTenants) || rawTenants.length === 0) {
    throw new Error("Tenants config must be a non-empty array");
  }
```

to:

```js
  if (!Array.isArray(rawTenants)) {
    throw new Error("Tenants config must be an array");
  }
```

Add `accountMapPath` to the object returned for each tenant (it is already computed as a local variable a few lines above, just not included in the returned object):

```js
    return {
      id: raw.id,
      actualSyncId: raw.actualSyncId,
      actualPassword: raw.actualPassword,
      actualEncryptionPassword: raw.actualEncryptionPassword || "",
      apiKey: raw.apiKey,
      keycloakSub: raw.keycloakSub || null,
      accountMapJson,
      accountMapPath,
      templates,
      templatesPath,
    };
```

- [ ] **Step 4: Run the suite to see it pass**

Run: `node --test test/tenant-registry.test.js`
Expected: PASS (all tests, including the two changed above).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tenantRegistry.js test/tenant-registry.test.js
git commit -m "tenantRegistry: accept empty tenants array, return accountMapPath"
```

---

### Task 2: `accountMapStore.js` — hot-reloadable account-map store

**Files:**
- Create: `src/lib/accountMapStore.js`
- Test: `test/account-map-store.test.js`

**Interfaces:**
- Produces: `createAccountMapStore(configPath, initialMapJson) => { getMapJson(): string, replaceAll(newMap: object): void }`; `validateAccountMap(map)` (also exported, throws on an invalid shape).
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/account-map-store.test.js`
Expected: FAIL with "Cannot find module '../src/lib/accountMapStore'".

- [ ] **Step 3: Implement**

```js
// src/lib/accountMapStore.js
const fs = require("node:fs");
const path = require("node:path");

const validateAccountMap = (map) => {
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new Error("Account map must be a JSON object");
  }
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Account map entry "${key}" must map to a non-empty string`);
    }
  }
};

const createAccountMapStore = (configPath, initialMapJson) => {
  let mapJson = initialMapJson;

  const getMapJson = () => mapJson;

  const replaceAll = (newMap) => {
    validateAccountMap(newMap); // throws on failure, leaving mapJson untouched
    const newMapJson = JSON.stringify(newMap, null, 2);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, newMapJson);
    mapJson = newMapJson;
  };

  return { getMapJson, replaceAll };
};

module.exports = { createAccountMapStore, validateAccountMap };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/account-map-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/accountMapStore.js test/account-map-store.test.js
git commit -m "Add per-tenant hot-reloadable account-map store"
```

---

### Task 3: `tenantAuth.js` — carry `accountMapStore` instead of `accountMapJson`

**Files:**
- Modify: `src/lib/tenantAuth.js`
- Test: `test/tenant-auth.test.js`

**Interfaces:**
- Consumes: `createAccountMapStore` (Task 2); each tenant's `accountMapPath` (Task 1).
- Produces: a tenant object from `buildTenantLookup` now has `accountMapStore` (not `accountMapJson`).

- [ ] **Step 1: Update the tests**

In `test/tenant-auth.test.js`, add a `tempAccountMapPath` helper next to the existing `tempTemplatesPath`, give each fixture tenant an `accountMapPath`, and change every assertion that read `accountMapJson` directly:

```js
function tempAccountMapPath(initialContent = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-auth-map-"));
  const accountMapPath = path.join(dir, "account-map.json");
  fs.writeFileSync(accountMapPath, JSON.stringify(initialContent));
  return accountMapPath;
}
```

```js
const buildTenants = () => [
  {
    id: "alice",
    apiKey: "alice-key",
    templates: [validTemplate("t-alice")],
    templatesPath: tempTemplatesPath([validTemplate("t-alice")]),
    accountMapJson: '{"1":"Alice Acc"}',
    accountMapPath: tempAccountMapPath({ "1": "Alice Acc" }),
    keycloakSub: "sub-alice",
  },
  {
    id: "bob",
    apiKey: "bob-key",
    templates: [validTemplate("t-bob")],
    templatesPath: tempTemplatesPath([validTemplate("t-bob")]),
    accountMapJson: '{"2":"Bob Acc"}',
    accountMapPath: tempAccountMapPath({ "2": "Bob Acc" }),
    keycloakSub: null,
  },
];
```

Change the assertion in the first `it` block from `assert.strictEqual(alice.accountMapJson, '{"1":"Alice Acc"}');` to:

```js
    assert.strictEqual(typeof alice.accountMapStore.getMapJson, "function");
    assert.strictEqual(typeof alice.accountMapStore.replaceAll, "function");
    assert.deepStrictEqual(JSON.parse(alice.accountMapStore.getMapJson()), { "1": "Alice Acc" });
```

Add one new test proving isolation, mirroring the existing templatesStore isolation test:

```js
  it("each tenant's accountMapStore.replaceAll() is independent (writes only that tenant's file)", () => {
    const tenants = buildTenants();
    const { tenantsByApiKey } = buildTenantLookup(tenants, new Map());
    const alice = resolveTenant(tenantsByApiKey, "alice-key");
    const bob = resolveTenant(tenantsByApiKey, "bob-key");

    alice.accountMapStore.replaceAll({ "1": "Alice Acc v2" });

    assert.deepStrictEqual(JSON.parse(alice.accountMapStore.getMapJson()), { "1": "Alice Acc v2" });
    assert.deepStrictEqual(JSON.parse(bob.accountMapStore.getMapJson()), { "2": "Bob Acc" });
    const bobOnDisk = JSON.parse(fs.readFileSync(tenants[1].accountMapPath, "utf8"));
    assert.deepStrictEqual(bobOnDisk, { "2": "Bob Acc" });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tenant-auth.test.js`
Expected: FAIL — `alice.accountMapStore` is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/tenantAuth.js`:

```js
const { createTemplatesStore } = require("../templates/store");
const { createAccountMapStore } = require("./accountMapStore");

const buildTenantLookup = (tenants, workerClients) => {
  const tenantsById = new Map();
  const tenantsByKeycloakSub = new Map();

  for (const t of tenants) {
    const tenant = {
      id: t.id,
      workerClient: workerClients.get(t.id),
      templatesStore: createTemplatesStore(t.templatesPath, t.templates),
      accountMapStore: createAccountMapStore(t.accountMapPath, t.accountMapJson),
      keycloakSub: t.keycloakSub,
    };
    tenantsById.set(t.id, tenant);
    if (typeof t.keycloakSub === "string" && t.keycloakSub.length > 0) {
      tenantsByKeycloakSub.set(t.keycloakSub, tenant);
    }
  }

  const tenantsByApiKey = new Map(tenants.map((t) => [t.apiKey, tenantsById.get(t.id)]));
  return { tenantsById, tenantsByApiKey, tenantsByKeycloakSub };
};
```

(Only the `require` line and the `accountMapJson: t.accountMapJson` → `accountMapStore: createAccountMapStore(...)` line actually change; `resolveTenant`/`resolveTenantByKeycloakSub` are untouched.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/tenant-auth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tenantAuth.js test/tenant-auth.test.js
git commit -m "tenantAuth: carry accountMapStore instead of a static accountMapJson"
```

---

### Task 4: Rename `/vietqr-transaction` → `/bank-transfer`; read through `accountMapStore`

**Files:**
- Rename: `src/routes/vietqrTransaction.js` → `src/routes/bankTransfer.js`
- Rename: `test/vietqr-transaction.test.js` → `test/bank-transfer.test.js`
- Modify: `src/server.js` (route registration only), `test/admin-full-chain-integration.test.js`, `test/admin-hot-reload-integration.test.js`, `test/tenant-routing-integration.test.js` (route path only)

**Interfaces:**
- Consumes: `request.tenant.accountMapStore.getMapJson()` (Task 3).
- Produces: `POST /bank-transfer` — identical request/response shape to the old `/vietqr-transaction`.

- [ ] **Step 1: Rename the route file's test and update it for the new path/store**

```bash
git mv test/vietqr-transaction.test.js test/bank-transfer.test.js
```

In `test/bank-transfer.test.js`: change `require("../src/routes/vietqrTransaction")` to `require("../src/routes/bankTransfer")`, every `url: "/vietqr-transaction"` to `url: "/bank-transfer"`, and every test tenant fixture's `accountMapJson: "..."` to `accountMapStore: { getMapJson: () => "..." }` (a minimal fake matching the real store's read-only-here interface).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/bank-transfer.test.js`
Expected: FAIL — module not found (file not renamed yet) or route not found.

- [ ] **Step 3: Rename and update the route file**

```bash
git mv src/routes/vietqrTransaction.js src/routes/bankTransfer.js
```

In `src/routes/bankTransfer.js`: rename the `vietqrTransactionSchema` constant to `bankTransferSchema`, change the route registration from `fastify.post("/vietqr-transaction", vietqrTransactionSchema, ...)` to `fastify.post("/bank-transfer", bankTransferSchema, ...)`, and change the account-map line:

```js
    const accountName = resolveAccountName(parsed.sourceAccountNumber, request.tenant.accountMapStore.getMapJson());
```

No other line in this file changes.

- [ ] **Step 4: Update `server.js`'s registration**

```js
  await fastify.register(require("./routes/bankTransfer"));
```

(replaces `await fastify.register(require("./routes/vietqrTransaction"));`)

- [ ] **Step 5: Update the other three test files' route path, and one fixture gap Task 3 exposes**

In `test/admin-hot-reload-integration.test.js` and `test/tenant-routing-integration.test.js`: change every `url: "/vietqr-transaction"` (or equivalent string literal) to `url: "/bank-transfer"`. No other change is needed in these two files.

In `test/admin-full-chain-integration.test.js`:
- Line 129: `await app.register(require("../src/routes/vietqrTransaction"), ...)` → `await app.register(require("../src/routes/bankTransfer"), ...)`.
- Line 187: `url: "/vietqr-transaction"` → `url: "/bank-transfer"` (rename the `vietqrResponse` local variable to `bankTransferResponse` for consistency, and the `describe` title on line 134 to say `/bank-transfer`).
- This file's `tenants` fixture (around line 89-98) builds tenant objects by hand rather than via `loadTenants()`, so it never picked up Task 1's new `accountMapPath` field. Since Task 3 changed `buildTenantLookup` to require `t.accountMapPath` (to construct `accountMapStore`), add it to this fixture now or every test in this file breaks:

```js
  const tenants = [
    {
      id: "alice",
      apiKey: "alice-api-key",
      templatesPath,
      templates: [],
      accountMapJson: '{"123456":"Checking"}',
      accountMapPath: path.join(dir, "tenants", "alice", "account-map.json"),
      keycloakSub: "sub-alice",
    },
  ];
```

(The path need not exist on disk — none of this file's pre-existing tests call `accountMapStore.replaceAll()`, only the read-only `getMapJson()` via `/bank-transfer`.)

- [ ] **Step 6: Run the full suite to verify everything passes**

Run: `node --test test/*.test.js`
Expected: PASS (aside from the three pre-existing real-Actual-server-required failures documented in every prior PR in this repo — `test/initialization.test.js`, `test/tenant-worker.test.js`, `test/transaction.test.js`).

- [ ] **Step 7: Commit**

```bash
git add src/routes/bankTransfer.js src/server.js test/bank-transfer.test.js \
  test/admin-full-chain-integration.test.js test/admin-hot-reload-integration.test.js \
  test/tenant-routing-integration.test.js
git commit -m "Rename /vietqr-transaction to /bank-transfer; read account map via accountMapStore"
```

---

### Task 5: `tenantWorkerPool.js` — extract `spawnOne`; expose `children`

**Files:**
- Modify: `src/worker/tenantWorkerPool.js`
- Test: `test/tenant-worker-pool.test.js`

**Interfaces:**
- Produces: `spawnOne(tenant, workerPath?, forkOptions?, { onSpawn? }?) => Promise<{ child, client }>` (new export); `spawnAll(tenants, workerPath?, forkOptions?) => Promise<{ clients, killAll, children }>` — `children` is new on the resolved object, everything else unchanged.
- Consumes: nothing new from earlier tasks — this is a self-contained refactor.

- [ ] **Step 1: Add tests for the new behavior first**

Add to `test/tenant-worker-pool.test.js`:

```js
const { spawnAll, spawnOne } = require("../src/worker/tenantWorkerPool");

describe("spawnOne", () => {
  it("resolves { child, client } for a healthy tenant", async () => {
    const { child, client } = await spawnOne({ id: "alice", tenantId: "alice" }, FAKE_WORKER_PATH);
    const accounts = await client.getAccounts();
    assert.deepStrictEqual(accounts, [{ id: "acc-alice", name: "Fake" }]);
    child.kill();
  });

  it("rejects and kills its own child when the tenant fails to initialize", async () => {
    await assert.rejects(
      () => spawnOne({ id: "bob", tenantId: "bob", failInit: true }, FAKE_WORKER_PATH),
      /bob.*failed to initialize/i
    );
  });

  it("calls onSpawn with the child as soon as it is forked, before ready/failure is known", async () => {
    const spawnedChildren = [];
    const { child } = await spawnOne({ id: "alice", tenantId: "alice" }, FAKE_WORKER_PATH, {}, {
      onSpawn: (c) => spawnedChildren.push(c),
    });
    assert.strictEqual(spawnedChildren.length, 1);
    assert.strictEqual(spawnedChildren[0], child);
    child.kill();
  });
});
```

Add one assertion to the existing "rejects spawnAll and kills every other worker when one tenant fails to init" test proving `children` is exposed even on the rejection path is unnecessary (that path never resolves); instead add a new passing-path assertion:

```js
  it("exposes every spawned child on the resolved object", async () => {
    const { children, killAll } = await spawnAll(
      [
        { id: "alice", tenantId: "alice" },
        { id: "bob", tenantId: "bob" },
      ],
      FAKE_WORKER_PATH
    );
    assert.strictEqual(children.length, 2);
    killAll();
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test test/tenant-worker-pool.test.js`
Expected: FAIL — `spawnOne` is not exported yet; `children` is `undefined`.

- [ ] **Step 3: Implement the refactor**

Replace the whole file:

```js
const { fork } = require("node:child_process");
const path = require("node:path");

const DEFAULT_WORKER_PATH = path.join(__dirname, "tenantWorker.js");

const createWorkerClient = (child) => {
  const pending = new Map();
  let counter = 0;
  let dead = false;

  const rejectAllPending = (err) => {
    dead = true;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };

  child.on("message", (msg) => {
    if (msg.requestId === undefined) return;
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  });

  child.once("exit", (code, signal) => {
    rejectAllPending(new Error(`Tenant worker process exited unexpectedly (code ${code}, signal ${signal})`));
  });
  child.once("disconnect", () => {
    rejectAllPending(new Error("Tenant worker process disconnected unexpectedly"));
  });
  child.on("error", (err) => {
    rejectAllPending(new Error(`Tenant worker process error: ${err.message}`));
  });

  const call = (method, args) => {
    if (dead || !child.connected || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new Error("Tenant worker process exited unexpectedly"));
    }
    return new Promise((resolve, reject) => {
      const requestId = `${process.pid}-${++counter}-${Date.now()}`;
      pending.set(requestId, { resolve, reject });
      child.send({ requestId, method, args });
    });
  };

  return {
    getAccounts: () => call("getAccounts", []),
    getPayees: () => call("getPayees", []),
    addTransactions: (accountId, transactions) => call("addTransactions", [accountId, transactions]),
    deleteTransaction: (id) => call("deleteTransaction", [id]),
    sync: () => call("sync", []),
    actualInternalSend: (method, params) => call("actualInternalSend", [method, params]),
  };
};

// Forks one child for `tenant`, waits for its ready handshake, and resolves { child, client }.
// On any failure (init failure, exit before ready, or a spawn-level error), rejects and kills
// its own child -- but never touches any other tenant's process, so callers spawning tenants
// one at a time (dynamic registration) never have a blast radius beyond their own attempt.
// `onSpawn`, if given, is invoked with the child as soon as it is forked -- before ready/failure
// is known -- so a caller managing a shared shutdown list (spawnAll, below) can track it early.
const spawnOne = (tenant, workerPath = DEFAULT_WORKER_PATH, forkOptions = {}, { onSpawn } = {}) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = fork(workerPath, [], forkOptions);
    if (onSpawn) onSpawn(child);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(err);
    };

    child.once("message", (msg) => {
      if (settled) return;
      if (msg.ready) {
        settled = true;
        resolve({ child, client: createWorkerClient(child) });
      } else {
        fail(new Error(`Tenant "${tenant.id}" failed to initialize: ${msg.error}`));
      }
    });

    child.once("exit", (code, signal) => {
      fail(new Error(`Tenant "${tenant.id}" worker exited before becoming ready (code ${code}, signal ${signal})`));
    });

    child.on("error", (err) => {
      fail(new Error(`Tenant "${tenant.id}" worker failed to spawn: ${err.message}`));
    });

    child.send(tenant);
  });
};

// Forks one child per tenant via spawnOne, all-or-nothing: if any single tenant fails, every
// child forked in this batch (ready or not) is killed and spawnAll rejects with that tenant's
// error. `children` is exposed on the resolved object so a caller can append later,
// dynamically-spawned children (see tenantProvisioning.js) to the same collection this
// function's own `killAll` drains.
const spawnAll = (tenants, workerPath = DEFAULT_WORKER_PATH, forkOptions = {}) => {
  const children = [];
  const killAll = () => children.forEach((child) => child.kill());

  if (tenants.length === 0) {
    return Promise.resolve({ clients: new Map(), killAll, children });
  }

  const onSpawn = (child) => children.push(child);

  return Promise.all(
    tenants.map((tenant) =>
      spawnOne(tenant, workerPath, forkOptions, { onSpawn }).then(({ client }) => ({ id: tenant.id, client }))
    )
  ).then(
    (results) => ({ clients: new Map(results.map((r) => [r.id, r.client])), killAll, children }),
    (err) => {
      killAll();
      throw err;
    }
  );
};

module.exports = { spawnAll, spawnOne };
```

- [ ] **Step 4: Run the full worker-pool suite**

Run: `node --test test/tenant-worker-pool.test.js`
Expected: PASS — every original test plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add src/worker/tenantWorkerPool.js test/tenant-worker-pool.test.js
git commit -m "tenantWorkerPool: extract spawnOne, expose children on spawnAll's result"
```

---

### Task 6: `tenantProvisioning.js` — `registerTenant()`

**Files:**
- Create: `src/lib/tenantProvisioning.js`
- Test: `test/tenant-provisioning.test.js`

**Interfaces:**
- Consumes: `spawnOne` (Task 5), `createTemplatesStore` (existing), `createAccountMapStore` (Task 2), the live `tenantsById`/`tenantsByApiKey`/`tenantsByKeycloakSub` Maps (Task 3's shape).
- Produces: `createTenantProvisioner({ tenantsConfigPath, actualUrl, workerPath?, tenantsById, tenantsByApiKey, tenantsByKeycloakSub, onWorkerSpawned? }) => { registerTenant({ keycloakSub, actualSyncId, actualPassword, actualEncryptionPassword? }) => Promise<Result> }` where `Result` is `{ ok: true, id, apiKey }` or `{ ok: false, code, error, message? }`.

- [ ] **Step 1: Write the failing tests**

```js
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
```

This requires `test/fixtures/fakeTenantWorker.js` (already used by `test/tenant-worker-pool.test.js`) to honor a `failInit` field on the tenant object sent to it — check that file: if it doesn't already support `failInit`/`exitCleanBeforeReady` flags exactly as used by the existing `tenant-worker-pool.test.js` suite, no change is needed here since those tests already pass with that fixture: reuse it as-is.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tenant-provisioning.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
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

  const run = async ({ keycloakSub, actualSyncId, actualPassword, actualEncryptionPassword }) => {
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/tenant-provisioning.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tenantProvisioning.js test/tenant-provisioning.test.js
git commit -m "Add tenantProvisioning.registerTenant: test-connect, persist, live-map insert"
```

---

### Task 7: `auth.js` — let an unregistered but authenticated user reach the registration API

**Files:**
- Modify: `src/plugins/auth.js`
- Test: `test/admin-auth.test.js`

**Interfaces:**
- Produces: the guard hook now allows `GET /admin`, `GET /admin/index.html`, `GET /admin/api/me`, and `POST /admin/api/register` through even when the authenticated session has no matching tenant; every other `/admin/*` path is unchanged (`403` with a new message pointing at self-service instead of "ask an operator").

- [ ] **Step 1: Update the tests**

`test/admin-auth.test.js`'s `buildApp` helper (already in the file) registers only two ad-hoc stub routes on top of the real `auth` plugin — `app.get("/admin/", ...)` and `app.post("/admin/test-post", ...)` — real route modules (`adminTemplates`, the not-yet-written `adminRegister`) are never mounted here; this file tests the guard hook in isolation. Extend `buildApp` with two more stub routes matching that same pattern:

```js
  app.get("/admin/", async () => ({ ok: true, tenant: true }));
  app.post("/admin/test-post", async (request) => ({ tenant: !!request.tenant }));
  app.get("/admin/api/me", async (request) => ({ tenant: !!request.tenant }));
  app.post("/admin/api/register", async (request) => ({ tenant: !!request.tenant }));
```

(the first two lines already exist; only the last two are new)

Then **replace** the existing `it("returns 403 when the authenticated sub has no matching tenant", ...)` test — its premise (`GET /admin/` always 403s with no tenant) is exactly what this task changes — with:

```js
  it("lets an authenticated session with no tenant reach GET /admin/ (registration view)", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-nobody" });
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub: new Map() });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const response = await app.inject({ method: "GET", url: "/admin/", headers: { cookie } });
    assert.strictEqual(response.statusCode, 200);
    await app.close();
  });

  it("lets an authenticated session with no tenant reach GET /admin/api/me and POST /admin/api/register", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-nobody" });
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub: new Map() });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const meResponse = await app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    assert.strictEqual(meResponse.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(meResponse.body), { tenant: false });

    const registerResponse = await app.inject({ method: "POST", url: "/admin/api/register", headers: { cookie } });
    assert.strictEqual(registerResponse.statusCode, 200);
    await app.close();
  });

  it("still 403s a non-allowlisted path (e.g. POST /admin/test-post) when there's no tenant", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-nobody" });
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub: new Map() });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const response = await app.inject({ method: "POST", url: "/admin/test-post", headers: { cookie } });
    assert.strictEqual(response.statusCode, 403);
    await app.close();
  });
```

- [ ] **Step 2: Run to verify the new/changed tests fail**

Run: `node --test test/admin-auth.test.js`
Expected: FAIL — `GET /admin/` and the two new stub routes all currently 403 for a no-tenant session.

- [ ] **Step 3: Implement**

In `src/plugins/auth.js`, replace the guard hook's tenant-resolution tail. Both `/admin` and `/admin/` are allowlisted because `ignoreTrailingSlash` (set on the real server, `src/server.js`) affects route *matching*, not the raw `request.url` string this hook inspects — a browser can legitimately request either form:

```js
  const NO_TENANT_REQUIRED_PATHS = new Set([
    "/admin",
    "/admin/",
    "/admin/index.html",
    "/admin/api/me",
    "/admin/api/register",
  ]);

  fastify.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin")) return;
    if (request.url.startsWith("/admin/login") || request.url.startsWith("/admin/callback")) return;

    if (!request.session.userSub) {
      if (request.method !== "GET") {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      const returnTo = encodeURIComponent(request.url);
      reply.redirect(`/admin/login?returnTo=${returnTo}`);
      return;
    }

    const tenant = resolveTenantByKeycloakSub(tenantsByKeycloakSub, request.session.userSub);
    if (tenant) {
      request.tenant = tenant;
      return;
    }

    // No tenant yet: only the registration view/API and the static entry page are reachable --
    // everything else (templates, account-map, preview) requires an already-provisioned tenant.
    if (NO_TENANT_REQUIRED_PATHS.has(request.url.split("?")[0])) {
      return;
    }

    reply.code(403).send({
      error: "No tenant associated with this account",
      message: "Visit /admin/ to connect your own Actual Budget account.",
    });
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/admin-auth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/auth.js test/admin-auth.test.js
git commit -m "auth: let an authenticated user with no tenant reach the registration API"
```

---

### Task 8: `adminRegister.js` — `GET /admin/api/me`, `POST /admin/api/register`

**Files:**
- Create: `src/routes/adminRegister.js`
- Test: `test/admin-register.test.js`

**Interfaces:**
- Consumes: `registerTenant` (Task 6), `request.tenant` / `request.session.userSub` (set by `auth.js`, Task 7).
- Produces: `GET /admin/api/me => { registered: boolean }`; `POST /admin/api/register` body `{ actualSyncId, actualPassword, actualEncryptionPassword? }` → `201 { id, apiKey }` or an error status/body from `registerTenant`'s result.

- [ ] **Step 1: Write the failing tests**

```js
// test/admin-register.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const adminRegisterPlugin = require("../src/routes/adminRegister");

async function buildApp({ tenant = null, sessionUserSub = "sub-1", registerTenantImpl } = {}) {
  const app = fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.session = { userSub: sessionUserSub };
    if (tenant) request.tenant = tenant;
  });
  await app.register(adminRegisterPlugin, { registerTenant: registerTenantImpl || (async () => ({ ok: true, id: "sub-1", apiKey: "abc" })) });
  return app;
}

describe("GET /admin/api/me", () => {
  it("reports registered:false when request.tenant is unset", async () => {
    const app = await buildApp({ tenant: null });
    const response = await app.inject({ method: "GET", url: "/admin/api/me" });
    assert.deepStrictEqual(JSON.parse(response.body), { registered: false });
    await app.close();
  });

  it("reports registered:true when request.tenant is set", async () => {
    const app = await buildApp({ tenant: { id: "sub-1" } });
    const response = await app.inject({ method: "GET", url: "/admin/api/me" });
    assert.deepStrictEqual(JSON.parse(response.body), { registered: true });
    await app.close();
  });
});

describe("POST /admin/api/register", () => {
  it("400s when actualSyncId or actualPassword is missing", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/admin/api/register", payload: { actualSyncId: "x" } });
    assert.strictEqual(response.statusCode, 400);
    await app.close();
  });

  it("409s immediately if request.tenant is already set (already registered)", async () => {
    const app = await buildApp({ tenant: { id: "sub-1" } });
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/register",
      payload: { actualSyncId: "x", actualPassword: "y" },
    });
    assert.strictEqual(response.statusCode, 409);
    await app.close();
  });

  it("passes the session's userSub as keycloakSub and returns 201 + apiKey on success", async () => {
    let capturedInput;
    const app = await buildApp({
      sessionUserSub: "sub-alice",
      registerTenantImpl: async (input) => {
        capturedInput = input;
        return { ok: true, id: "sub-alice", apiKey: "generated-key" };
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/register",
      payload: { actualSyncId: "sync-1", actualPassword: "pw", actualEncryptionPassword: "enc" },
    });
    assert.strictEqual(response.statusCode, 201);
    assert.deepStrictEqual(JSON.parse(response.body), { id: "sub-alice", apiKey: "generated-key" });
    assert.strictEqual(capturedInput.keycloakSub, "sub-alice");
    assert.strictEqual(capturedInput.actualSyncId, "sync-1");
    await app.close();
  });

  it("maps a failed registration's { ok: false, code, error, message } to the HTTP response", async () => {
    const app = await buildApp({
      registerTenantImpl: async () => ({ ok: false, code: 422, error: "Could not connect to Actual Budget", message: "bad password" }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/register",
      payload: { actualSyncId: "sync-1", actualPassword: "wrong" },
    });
    assert.strictEqual(response.statusCode, 422);
    assert.deepStrictEqual(JSON.parse(response.body), {
      error: "Could not connect to Actual Budget",
      message: "bad password",
    });
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/admin-register.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/routes/adminRegister.js
module.exports = async (fastify, opts) => {
  const { registerTenant } = opts;

  fastify.get("/admin/api/me", async (request) => {
    return { registered: Boolean(request.tenant) };
  });

  fastify.post("/admin/api/register", async (request, reply) => {
    if (request.tenant) {
      return reply.code(409).send({ error: "Tenant already exists" });
    }

    const { actualSyncId, actualPassword, actualEncryptionPassword } = request.body || {};
    if (!actualSyncId || !actualPassword) {
      return reply.code(400).send({ error: "actualSyncId and actualPassword are required" });
    }

    const result = await registerTenant({
      keycloakSub: request.session.userSub,
      actualSyncId,
      actualPassword,
      actualEncryptionPassword,
    });

    if (!result.ok) {
      return reply.code(result.code).send({ error: result.error, message: result.message });
    }

    return reply.code(201).send({ id: result.id, apiKey: result.apiKey });
  });
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/admin-register.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/adminRegister.js test/admin-register.test.js
git commit -m "Add GET /admin/api/me and POST /admin/api/register"
```

---

### Task 9: `adminAccountMap.js` — account-map CRUD

**Files:**
- Create: `src/routes/adminAccountMap.js`
- Test: `test/admin-account-map.test.js`

**Interfaces:**
- Consumes: `request.tenant.accountMapStore` (Task 3).
- Produces: `GET /admin/api/account-map`, `PUT /admin/api/account-map` (full replace).

- [ ] **Step 1: Write the failing tests**

```js
// test/admin-account-map.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const adminAccountMapPlugin = require("../src/routes/adminAccountMap");

function fakeAccountMapStore(initial) {
  let mapJson = JSON.stringify(initial);
  return {
    getMapJson: () => mapJson,
    replaceAll: (next) => {
      mapJson = JSON.stringify(next);
    },
  };
}

async function buildApp({ map = { "1": "Checking" }, setTenant = true } = {}) {
  const app = fastify({ logger: false });
  const accountMapStore = fakeAccountMapStore(map);
  if (setTenant) {
    app.addHook("preHandler", async (request) => {
      request.tenant = { id: "alice", accountMapStore };
    });
  }
  await app.register(adminAccountMapPlugin);
  return { app, accountMapStore };
}

describe("GET /admin/api/account-map", () => {
  it("returns the tenant's current account map", async () => {
    const { app } = await buildApp({ map: { "1": "Checking" } });
    const response = await app.inject({ method: "GET", url: "/admin/api/account-map" });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { "1": "Checking" });
    await app.close();
  });

  it("401s when request.tenant is unset", async () => {
    const { app } = await buildApp({ setTenant: false });
    const response = await app.inject({ method: "GET", url: "/admin/api/account-map" });
    assert.strictEqual(response.statusCode, 401);
    await app.close();
  });
});

describe("PUT /admin/api/account-map", () => {
  it("replaces the map", async () => {
    const { app, accountMapStore } = await buildApp({ map: {} });
    const response = await app.inject({
      method: "PUT",
      url: "/admin/api/account-map",
      payload: { "9": "Savings" },
    });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(accountMapStore.getMapJson()), { "9": "Savings" });
    await app.close();
  });

  it("400s on an invalid shape", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/admin/api/account-map",
      payload: { "9": 42 },
    });
    assert.strictEqual(response.statusCode, 400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/admin-account-map.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/routes/adminAccountMap.js
module.exports = async (fastify, opts) => {
  fastify.get("/admin/api/account-map", async (request, reply) => {
    if (!request.tenant) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return JSON.parse(request.tenant.accountMapStore.getMapJson());
  });

  fastify.put("/admin/api/account-map", async (request, reply) => {
    if (!request.tenant) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      request.tenant.accountMapStore.replaceAll(request.body);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid account map", message: err.message });
    }

    return JSON.parse(request.tenant.accountMapStore.getMapJson());
  });
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/admin-account-map.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/adminAccountMap.js test/admin-account-map.test.js
git commit -m "Add GET/PUT /admin/api/account-map"
```

---

### Task 10: Wire everything into `server.js`

**Files:**
- Modify: `src/server.js`
- Test: extend `test/admin-ui-registration.test.js` (feature-flag on/off regression) if it asserts the exact route list; otherwise no new test file — this task's correctness is proven by Task 13's full-chain test.

**Interfaces:**
- Consumes: every module from Tasks 1–9.
- Produces: a fully wired server — cookie path prefix-aware, `/bank-transfer` registered, self-service registration reachable, account-map CRUD reachable.

- [ ] **Step 1: Implement the wiring changes**

In `src/server.js`:

1. Destructure `tenantsById` too (currently only `tenantsByApiKey, tenantsByKeycloakSub` are pulled out):

```js
  const { buildTenantLookup, resolveTenant } = require("./lib/tenantAuth");
  const { tenantsById, tenantsByApiKey, tenantsByKeycloakSub } = buildTenantLookup(tenants, workerClients);
```

2. Capture `children` from `spawnAll`'s result (needed so a dynamically-registered tenant's worker is also killed on shutdown):

```js
  const { spawnAll } = require("./worker/tenantWorkerPool");
  const { clients: workerClients, killAll, children } = await spawnAll(
    tenants.map((t) => ({
      id: t.id,
      actualUrl: fastify.config.ACTUAL_URL,
      password: t.actualPassword,
      syncId: t.actualSyncId,
      encryptionPassword: t.actualEncryptionPassword,
    }))
  );
```

3. Fix the cookie path and wire the new routes/provisioner, inside the existing `if (adminUiConfig.enabled) { ... }` block:

```js
  if (adminUiConfig.enabled) {
    fastify.log.info("Admin UI enabled");
    await fastify.register(require("@fastify/cookie"));

    const basePath = new URL(adminUiConfig.appBaseUrl).pathname.replace(/\/$/, ""); // "" for a root deployment
    await fastify.register(require("@fastify/session"), {
      secret: adminUiConfig.sessionSecret,
      saveUninitialized: false,
      cookie: {
        secure: adminUiConfig.appBaseUrl.startsWith("https://"),
        path: `${basePath}/admin`,
        sameSite: "lax",
      },
    });

    await fastify.register(require("./plugins/auth"), { tenantsByKeycloakSub });
    await fastify.register(require("./plugins/staticAdmin"));
    await fastify.register(require("./routes/adminTemplates"));
    await fastify.register(require("./routes/adminAccountMap"));

    const { createTenantProvisioner } = require("./lib/tenantProvisioning");
    const { registerTenant } = createTenantProvisioner({
      tenantsConfigPath: fastify.config.TENANTS_CONFIG_PATH,
      actualUrl: fastify.config.ACTUAL_URL,
      tenantsById,
      tenantsByApiKey,
      tenantsByKeycloakSub,
      onWorkerSpawned: (child) => children.push(child),
    });
    await fastify.register(require("./routes/adminRegister"), { registerTenant });
  } else {
    fastify.log.info("Admin UI disabled (Keycloak env vars not set)");
  }
```

(`workerPath` is intentionally omitted from the `createTenantProvisioner` options object above — leaving it `undefined` so `spawnOne`'s own default parameter, the real `tenantWorker.js`, applies, exactly matching how `spawnAll` above is called with no explicit `workerPath` either.)

4. Change the bank-transfer registration line (from Task 4, already done, just confirm it reads):

```js
  await fastify.register(require("./routes/bankTransfer"));
```

- [ ] **Step 2: Run the full suite**

Run: `node --test test/*.test.js`
Expected: PASS (same three pre-existing real-Actual-server exceptions as every prior PR; everything else green, including `test/admin-ui-registration.test.js`'s feature-flag-off regression, which must still show `/admin/*` returning `404` when the five Keycloak env vars are unset).

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "server: wire self-service registration, account-map CRUD, path-prefix-aware cookie"
```

---

### Task 11: Admin UI — registration view + account-map panel

**Files:**
- Modify: `public/admin/index.html`

**Interfaces:**
- Consumes: `GET /admin/api/me`, `POST /admin/api/register`, `GET`/`PUT /admin/api/account-map` (Tasks 8–9).

- [ ] **Step 1: Add a registration view and an account-map panel, and gate the existing template editor behind `GET /admin/api/me`**

Replace the file's `<body>` and `<script>` with the version below. The template-editor markup/logic is unchanged except it is now wrapped in `<div id="main-view" hidden>` and only shown once `/admin/api/me` reports `registered: true`; a new `<div id="register-view" hidden>` and a small tab bar plus an account-map panel are added.

```html
<body>
  <div id="register-view" hidden>
    <div style="max-width: 480px; margin: 60px auto; font-family: system-ui, sans-serif;">
      <h2>Connect your Actual Budget account</h2>
      <div class="row" style="flex-direction: column; align-items: stretch; gap: 8px;">
        <label>Actual Sync ID <input id="reg-sync-id" /></label>
        <label>Actual Password <input id="reg-password" type="password" /></label>
        <label>Actual Encryption Password (optional) <input id="reg-enc-password" type="password" /></label>
        <button id="reg-submit-btn">Connect</button>
        <div id="reg-error" class="error"></div>
        <div id="reg-success" hidden>
          <p><strong>Save this API key now — it is shown only once:</strong></p>
          <code id="reg-api-key" style="user-select: all;"></code>
          <p><button id="reg-continue-btn">Continue</button></p>
        </div>
      </div>
    </div>
  </div>

  <div id="main-view" hidden>
    <div class="row" style="padding: 8px 12px; border-bottom: 1px solid #ddd;">
      <button id="tab-templates" class="active">Templates</button>
      <button id="tab-account-map">Account Map</button>
    </div>

    <div id="templates-tab" style="display: flex; height: calc(100vh - 45px);">
      <aside>
        <div class="row">
          <button id="new-btn">+ New</button>
        </div>
        <ul id="template-list"></ul>
      </aside>
      <main>
        <div class="row">
          <strong id="editor-title">New template</strong>
          <button id="save-btn">Save</button>
          <button id="delete-btn" style="display:none">Delete</button>
        </div>
        <textarea id="editor"></textarea>
        <div id="editor-error" class="error"></div>

        <strong>Preview</strong>
        <textarea id="preview-raw" placeholder="Paste a sample rawText here"></textarea>
        <div class="row">
          <button id="preview-btn">Test</button>
        </div>
        <div id="preview-result"></div>
      </main>
    </div>

    <div id="account-map-tab" style="display: none; padding: 12px;">
      <p>Maps a bank account number found in a notification's text to an Actual Budget account name.</p>
      <textarea id="account-map-editor" style="width: 100%; height: 300px; font-family: monospace;"></textarea>
      <div class="row">
        <button id="account-map-save-btn">Save</button>
      </div>
      <div id="account-map-error" class="error"></div>
    </div>
  </div>

  <script>
    async function api(method, path, body) {
      const response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
      return data;
    }

    let currentName = null; // null = unsaved new template

    async function refreshList() {
      const templates = await api("GET", "/admin/api/templates");
      const list = document.getElementById("template-list");
      list.innerHTML = "";
      for (const t of templates) {
        const li = document.createElement("li");
        li.textContent = `${t.name} (${t.sourceType}/${t.direction})`;
        li.className = t.name === currentName ? "active" : "";
        li.onclick = () => loadTemplate(t);
        list.appendChild(li);
      }
    }

    function loadTemplate(template) {
      currentName = template.name;
      document.getElementById("editor-title").textContent = template.name;
      document.getElementById("editor").value = JSON.stringify(template, null, 2);
      document.getElementById("delete-btn").style.display = "inline-block";
      document.getElementById("editor-error").textContent = "";
      refreshList();
    }

    document.getElementById("new-btn").onclick = () => {
      currentName = null;
      document.getElementById("editor-title").textContent = "New template";
      document.getElementById("editor").value = JSON.stringify(
        { name: "", sourceType: "email", direction: "expense", match: { contains: [] }, fields: {}, requiredFields: [] },
        null,
        2
      );
      document.getElementById("delete-btn").style.display = "none";
      document.getElementById("editor-error").textContent = "";
      refreshList();
    };

    document.getElementById("save-btn").onclick = async () => {
      const errorEl = document.getElementById("editor-error");
      errorEl.textContent = "";
      let template;
      try {
        template = JSON.parse(document.getElementById("editor").value);
      } catch (err) {
        errorEl.textContent = `Invalid JSON: ${err.message}`;
        return;
      }

      try {
        if (currentName === null) {
          await api("POST", "/admin/api/templates", template);
        } else {
          await api("PUT", `/admin/api/templates/${encodeURIComponent(currentName)}`, template);
        }
        loadTemplate(template);
      } catch (err) {
        errorEl.textContent = err.message;
      }
    };

    document.getElementById("delete-btn").onclick = async () => {
      if (currentName === null) return;
      if (!confirm(`Delete template "${currentName}"?`)) return;
      await api("DELETE", `/admin/api/templates/${encodeURIComponent(currentName)}`);
      document.getElementById("new-btn").onclick();
    };

    document.getElementById("preview-btn").onclick = async () => {
      const resultEl = document.getElementById("preview-result");
      resultEl.textContent = "";
      let template;
      try {
        template = JSON.parse(document.getElementById("editor").value);
      } catch (err) {
        resultEl.textContent = `Invalid JSON: ${err.message}`;
        return;
      }

      try {
        const result = await api("POST", "/admin/api/preview", {
          rawText: document.getElementById("preview-raw").value,
          template,
        });
        resultEl.textContent = JSON.stringify(result, null, 2);
      } catch (err) {
        resultEl.textContent = err.message;
      }
    };

    document.getElementById("tab-templates").onclick = () => {
      document.getElementById("templates-tab").style.display = "flex";
      document.getElementById("account-map-tab").style.display = "none";
    };
    document.getElementById("tab-account-map").onclick = async () => {
      document.getElementById("templates-tab").style.display = "none";
      document.getElementById("account-map-tab").style.display = "block";
      const map = await api("GET", "/admin/api/account-map");
      document.getElementById("account-map-editor").value = JSON.stringify(map, null, 2);
    };
    document.getElementById("account-map-save-btn").onclick = async () => {
      const errorEl = document.getElementById("account-map-error");
      errorEl.textContent = "";
      let map;
      try {
        map = JSON.parse(document.getElementById("account-map-editor").value);
      } catch (err) {
        errorEl.textContent = `Invalid JSON: ${err.message}`;
        return;
      }
      try {
        await api("PUT", "/admin/api/account-map", map);
      } catch (err) {
        errorEl.textContent = err.message;
      }
    };

    document.getElementById("reg-submit-btn").onclick = async () => {
      const errorEl = document.getElementById("reg-error");
      errorEl.textContent = "";
      try {
        const result = await api("POST", "/admin/api/register", {
          actualSyncId: document.getElementById("reg-sync-id").value,
          actualPassword: document.getElementById("reg-password").value,
          actualEncryptionPassword: document.getElementById("reg-enc-password").value || undefined,
        });
        document.getElementById("reg-api-key").textContent = result.apiKey;
        document.getElementById("reg-success").hidden = false;
      } catch (err) {
        errorEl.textContent = err.message;
      }
    };
    document.getElementById("reg-continue-btn").onclick = () => {
      document.getElementById("register-view").hidden = true;
      document.getElementById("main-view").hidden = false;
      refreshList();
    };

    (async () => {
      const { registered } = await api("GET", "/admin/api/me");
      if (registered) {
        document.getElementById("main-view").hidden = false;
        refreshList();
      } else {
        document.getElementById("register-view").hidden = false;
      }
    })();
  </script>
</body>
```

Keep the existing `<style>` block in `<head>` as-is; it already covers `aside`/`main`/`textarea`/`.row`/`.error`/`button`, all reused here.

- [ ] **Step 2: Manual verification**

There is no automated browser test for this file in this codebase (consistent with the original admin-ui plan). Verify by running the server locally against the fixtures used in Task 13's integration test and confirming in a browser: a fresh Keycloak session with no tenant shows the registration form; submitting valid fake-Actual credentials shows the API key once; reloading (now registered) shows the templates/account-map tabs.

- [ ] **Step 3: Commit**

```bash
git add public/admin/index.html
git commit -m "Admin UI: add registration view and account-map panel"
```

---

### Task 12: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the endpoint section**

Change the heading and every `/vietqr-transaction` reference in the "VietQR / Bank-email Transaction Import" section (lines ~91–110 as of this plan) to `/bank-transfer` / "Bank-Transfer Notification Import", e.g.:

```markdown
### Bank-Transfer Notification Import

`POST /bank-transfer` accepts raw bank-notification text (e.g. the plain-text body of a bank email) and automatically detects the source bank, parses the transaction, and creates it in Actual Budget — no need to structure the request yourself.
```

Update the two other `/vietqr-transaction` mentions in this file (the field-name list intro and the `account-map.json`/`templates.json` bullets) to `/bank-transfer` as well.

- [ ] **Step 2: Update the Admin UI section**

Replace the existing "Admin UI (Template Editor)" section with:

```markdown
## Admin UI (Template Editor + Self-Service Onboarding)

Setting all 5 of `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `SESSION_SECRET`, `APP_BASE_URL` enables a browser-based admin page at `/admin/`, gated behind Keycloak login. Leaving all 5 unset disables the feature entirely (`/admin/*` returns 404); setting only some of them is treated as a misconfiguration and the server refuses to start, naming which ones are missing.

**Self-service tenant onboarding:** a user who logs in successfully and has no tenant yet sees a form to connect their own Actual Budget account (sync ID, password, optional encryption password) instead of a dead end. On success, a new tenant is created immediately — no server restart, no operator involvement — and a freshly generated API key is shown exactly once for use with `/transaction` and `/bank-transfer`.

Once registered, the admin UI lets a tenant create/edit/delete/preview their own bank-transfer notification templates, and configure their own bank-account → Actual-account map — both take effect on the very next request, no restart required.

**Registering the Keycloak client:** create a confidential OIDC client in your Keycloak realm with the Authorization Code flow and PKCE enabled (Direct Access Grants, Implicit, and Service Accounts left off), and register `${APP_BASE_URL}/admin/callback` as a valid redirect URI and `${APP_BASE_URL}/admin/login` as a valid post-logout redirect URI.

**Deploying under a URL path prefix** (e.g. `APP_BASE_URL=https://example.com/actual-transfer-hub`, sharing a domain with other apps): strip the prefix at the reverse proxy so this app continues to see plain `/admin/*` paths — for nginx:

```nginx
location /actual-transfer-hub/ {
  proxy_pass http://actualtap:3001/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```
```

- [ ] **Step 3: Update the "requires config/tenants.json" line**

Change:

```markdown
**Note:** Actual Tap requires a `config/tenants.json` file to run. See [Multi-Tenant Configuration](#multi-tenant-configuration) for setup details.
```

to:

```markdown
**Note:** Actual Tap requires a `config/tenants.json` file to exist (an empty array `[]` is valid — the server starts with zero tenants and the first one can self-register through the admin UI, or an operator can hand-add entries as before). See [Multi-Tenant Configuration](#multi-tenant-configuration) for setup details.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: document /bank-transfer rename, self-service onboarding, path-prefix deployment"
```

---

### Task 13: Full-chain integration test + final regression

**Files:**
- Modify: `test/admin-full-chain-integration.test.js`
- Full suite regression run (no file changes beyond the test file above).

**Interfaces:**
- Proves the whole feature end-to-end, on the real `server.js` factory/registration order — the same posture the original admin-ui plan's Task 11/final review used to catch its three Critical issues.

**Note on this file's existing `buildApp`:** it hardcodes one pre-existing tenant ("alice") wired to a hand-built mock worker client (for the existing CRUD/preview/live-effect assertions) — it never touches a real `config/tenants.json` file or a real spawned worker process. That shape cannot exercise "zero tenants at boot, then a real dynamic registration," so this task adds a **second, separate** builder function, `buildFreshApp`, alongside the existing one — it does not modify `buildApp` or any existing test.

- [ ] **Step 1: Add the new builder and imports**

At the top of `test/admin-full-chain-integration.test.js`, add:

```js
const { loadTenants } = require("../src/lib/tenantRegistry");
const { spawnAll } = require("../src/worker/tenantWorkerPool");
const { createTenantProvisioner } = require("../src/lib/tenantProvisioning");

const FAKE_WORKER_PATH = path.join(__dirname, "fixtures/fakeTenantWorker.js");
```

Then, after the existing `buildApp` function, add:

```js
// A second, separate app builder for the zero-tenant-boot + self-registration scenario --
// deliberately independent of buildApp() above. Mirrors server.js's real Task 10 wiring:
// loadTenants() from a real tenants.json, spawnAll()/spawnOne() against the real
// fakeTenantWorker.js fixture, and the real tenantProvisioner wired into adminRegister.
async function buildFreshApp({ oidcClient = fakeOidcClient({ sub: "sub-new-user" }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-full-chain-fresh-"));
  const tenantsConfigPath = path.join(dir, "tenants.json");
  fs.writeFileSync(tenantsConfigPath, "[]");

  const app = fastify({
    logger: false,
    ajv: { customOptions: { allowUnionTypes: true } },
    routerOptions: { ignoreTrailingSlash: true },
    trustProxy: true,
  });

  app.decorate("config", {
    ACTUAL_URL: "http://actual.example.com",
    TENANTS_CONFIG_PATH: tenantsConfigPath,
    KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
    KEYCLOAK_CLIENT_ID: "actualtap-admin",
    KEYCLOAK_CLIENT_SECRET: "secret",
    SESSION_SECRET,
    APP_BASE_URL,
  });

  const tenants = loadTenants(tenantsConfigPath); // [] -- nobody registered yet
  const { clients: workerClients, children } = await spawnAll([], FAKE_WORKER_PATH);
  const { tenantsById, tenantsByApiKey, tenantsByKeycloakSub } = buildTenantLookup(tenants, workerClients);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?") || request.url.startsWith("/admin")) {
      return;
    }
    const apiKey = request.headers["x-api-key"];
    const tenant = resolveTenant(tenantsByApiKey, apiKey);
    if (!tenant) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.tenant = tenant;
  });

  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: SESSION_SECRET,
    saveUninitialized: false,
    cookie: { secure: APP_BASE_URL.startsWith("https://"), path: "/admin", sameSite: "lax" },
  });
  await app.register(require("../src/plugins/auth"), { oidcClient, tenantsByKeycloakSub });
  await app.register(require("../src/plugins/staticAdmin"));
  await app.register(require("../src/routes/adminTemplates"));
  await app.register(require("../src/routes/adminAccountMap"));

  const { registerTenant } = createTenantProvisioner({
    tenantsConfigPath,
    actualUrl: "http://actual.example.com",
    workerPath: FAKE_WORKER_PATH,
    tenantsById,
    tenantsByApiKey,
    tenantsByKeycloakSub,
    onWorkerSpawned: (child) => children.push(child),
  });
  await app.register(require("../src/routes/adminRegister"), { registerTenant });

  await app.register(fastifyCors, { methods: ["POST"] });
  await app.register(require("../src/routes/bankTransfer"), { dedupCache: createDedupCache() });

  return { app, children };
}
```

- [ ] **Step 2: Add the failing test**

```js
describe("Zero-tenant boot + self-service registration", () => {
  it("lets a fresh deployment's first user self-register and immediately use /bank-transfer", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-new-user" });
    const { app, children } = await buildFreshApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    let cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    cookie = callbackResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ") || cookie;

    const meBefore = await app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    assert.deepStrictEqual(JSON.parse(meBefore.body), { registered: false });

    const registerResponse = await app.inject({
      method: "POST",
      url: "/admin/api/register",
      headers: { cookie },
      payload: { actualSyncId: "sync-new", actualPassword: "pw" },
    });
    assert.strictEqual(registerResponse.statusCode, 201);
    const { apiKey } = JSON.parse(registerResponse.body);

    const meAfter = await app.inject({ method: "GET", url: "/admin/api/me", headers: { cookie } });
    assert.deepStrictEqual(JSON.parse(meAfter.body), { registered: true });

    // Immediately usable on the data plane, same running server, no restart
    const bankTransferResponse = await app.inject({
      method: "POST",
      url: "/bank-transfer",
      headers: { "x-api-key": apiKey },
      payload: { rawText: "no template will match this -- proves auth succeeded, not that parsing did" },
    });
    assert.notStrictEqual(bankTransferResponse.statusCode, 401);

    for (const child of children) child.kill();
    await app.close();
  });
});
```

Run: `node --test test/admin-full-chain-integration.test.js`
Expected: FAIL — `adminAccountMap`/`adminRegister`/`tenantProvisioning` don't exist yet if this task were run before Tasks 6–9; since this plan executes tasks in order, by this point they already exist, so the failure (if any) should only be a genuine wiring bug in `buildFreshApp` itself — fix that, never change an already-implemented module's own behavior to force this test green.

- [ ] **Step 3: Run to verify it passes**

Run: `node --test test/admin-full-chain-integration.test.js`
Expected: PASS.

- [ ] **Step 4: Full regression**

Run: `node --test test/*.test.js`
Expected: every test green except the three pre-existing real-Actual-server-required failures (`test/initialization.test.js`, `test/tenant-worker.test.js`, `test/transaction.test.js`) — same documented exception as every prior PR in this repo, not a regression.

- [ ] **Step 5: Commit**

```bash
git add test/admin-full-chain-integration.test.js
git commit -m "Add zero-tenant-boot + self-registration end-to-end test; final regression pass"
```
