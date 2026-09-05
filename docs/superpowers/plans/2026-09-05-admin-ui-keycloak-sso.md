# Admin UI + Keycloak SSO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator log in with Keycloak SSO to a browser-based admin page and create/edit/delete/preview their own tenant's `/vietqr-transaction` notification templates, with changes taking effect immediately — no container restart.

**Architecture:** A per-tenant, in-memory-plus-file `templatesStore` (list/replace, validate-before-write) replaces the frozen `templates` array each tenant currently gets at startup; `/vietqr-transaction` reads through the same store instance the new admin CRUD API writes through, so a save is visible on the very next request. A Keycloak OIDC (Authorization Code + PKCE) login gates everything under `/admin/*`; a successful login's `sub` claim is matched against a tenant's `keycloakSub` field in `config/tenants.json` to resolve `request.tenant`, the same way an API key resolves it on the data-plane routes. The whole feature is off by default (404 on `/admin/*`) unless five Keycloak/session env vars are all set.

**Tech Stack:** Node.js, Fastify 5, `openid-client` (OIDC Authorization Code + PKCE), `@fastify/cookie` + `@fastify/session` (session cookie), `@fastify/static` (serves the one admin HTML page), `node:test` + `assert`.

**Spec:** `docs/superpowers/specs/2026-09-05-admin-ui-keycloak-sso-design.md`, integrated per §6 of `docs/superpowers/specs/2026-09-05-multi-tenant-actual-connections-design.md`.

## Reconciling the spec with the shipped multi-tenant code

Both specs above were written before the multi-tenant architecture was implemented (PR #10, in review). The **shipped** interfaces differ from what both specs describe in three ways this plan resolves explicitly, rather than assuming the specs' original names:

1. **No `templatesStore` exists yet.** The admin-UI spec's whole hot-reload design (§5) assumes a `createTemplatesStore(configPath)` object was already threaded through `vietqrTransaction.js` by Sub-project A. It never was — the shipped `src/routes/vietqrTransaction.js:34` reads `const templates = request.tenant.templates;`, a **plain, frozen array** loaded once at startup by `src/lib/tenantRegistry.js`'s `loadTenants()` and copied verbatim onto the tenant object by `src/lib/tenantAuth.js`'s `buildTenantLookup()`. This plan introduces `src/templates/store.js` (§5 of the admin-UI spec, unmodified in shape) and wires ONE instance of it per tenant (not one global instance) into `request.tenant.templatesStore`, replacing the raw array field. `vietqrTransaction.js` changes exactly one line (`request.tenant.templates` → `request.tenant.templatesStore.getTemplates()`) to read through it — see Task 4.
2. **The shipped `request.tenant` shape is `{ id, workerClient, templates, accountMapJson, keycloakSub }`**, not the multi-tenant spec §6's illustrative `{ id, workerClient, templatesStore, accountMap }`. This plan changes `templates` → `templatesStore` (point 1) but leaves `accountMapJson` exactly as shipped — the admin UI never reads or writes the account map, only templates, so there is nothing to reconcile there.
3. **No `keycloakSub`-based tenant lookup exists yet.** `src/lib/tenantAuth.js` currently only builds `tenantsById`/`tenantsByApiKey` (used by the data-plane's API-key auth). This plan adds a third map, `tenantsByKeycloakSub`, and a `resolveTenantByKeycloakSub` function, built and used the same way `tenantsByApiKey`/`resolveTenant` already are — see Task 3.

Every task below is written against these three reconciliations, not the specs' original prose.

## Global Constraints

- The admin UI is **off by default**: `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `SESSION_SECRET`, `APP_BASE_URL` are all optional env vars (no defaults). None set → `/admin/*` is never registered (404s naturally, no code needed to produce the 404). Some-but-not-all set → the server fails to start, naming exactly which ones are missing.
- `SESSION_SECRET` must be a non-empty string of at least 32 characters when the feature is enabled, validated at startup (same fail-fast posture as this codebase's existing `ACTUAL_URL`/tenant-registry validation).
- A valid, successfully-verified Keycloak session is sufficient for admin access — no role/group claim check (confirmed decision, carried from the original spec).
- `config/templates.json` remains the *shape* every per-tenant `templates.json` follows; there is still no database — `config/tenants/<id>/templates.json` is the persisted source of truth, read once at boot into the per-tenant store's initial in-memory value and rewritten in full on every `replaceAll()`.
- `src/lib/actualAccounts.js`, `src/lib/actualTransactions.js`, `src/worker/*`, `src/lib/tenantRegistry.js`'s validation logic, and the account-map side of the tenant object (`accountMapJson`) are NOT touched beyond the one addition in Task 2 (a resolved `templatesPath` field) — this plan only adds template-authoring and auth, it does not change how transactions are created or how the account map works.
- `package.json`'s test script is `node --test test/*.test.js` — a non-recursive glob. Every new test file goes flat in `test/`; fixtures may live in subdirectories.
- `openid-client` is pinned to the `^5` major (the last one with the classic `Issuer`/`generators`/CommonJS-`require`-friendly API) specifically to avoid ESM/CJS interop — this codebase is 100% CommonJS (`require`/`module.exports`) throughout, and `openid-client@6+` is ESM-only. If `npm install` reports a newer `^5.x` patch than the one written in this plan, that's fine — use whatever `^5` resolves to; do not jump to `^6`.
- Real OIDC discovery/token-exchange against a live Keycloak cannot run in this sandbox (no Keycloak instance available). Every task's implementer must inject a fake `oidcClient` object via `opts` (the same dependency-injection pattern this codebase already uses for `opts.dedupCache` in `vietqrTransaction.js`) so `src/plugins/auth.js`'s logic is fully unit-testable without a real Keycloak. Only the small `createOidcClient()` factory itself (the thing that calls `Issuer.discover`) is untestable here — same "requires a real external server, not exercised in this sandbox" convention already used for `test/initialization.test.js`/`test/tenant-worker.test.js` in the multi-tenant plan.

---

## File Structure

```
src/templates/store.js            // NEW — createTemplatesStore(configPath, initialTemplates)
src/lib/tenantRegistry.js         // MODIFY — also resolve + return each tenant's templatesPath
src/lib/tenantAuth.js             // MODIFY — templatesStore per tenant, tenantsByKeycloakSub map,
                                   //   resolveTenantByKeycloakSub()
src/routes/vietqrTransaction.js   // MODIFY — read request.tenant.templatesStore.getTemplates()
src/lib/adminFeatureFlag.js       // NEW — resolveAdminUiConfig(config) (all-5-or-none env check)
src/plugins/env.js                // MODIFY — add 5 optional Keycloak/session env vars
package.json                      // MODIFY — add openid-client, @fastify/session,
                                   //   @fastify/cookie, @fastify/static
src/plugins/auth.js               // NEW — OIDC login/callback/logout, session, /admin/* guard
src/routes/adminTemplates.js      // NEW — CRUD (Task 7) + preview (Task 8) under /admin/api/
src/plugins/staticAdmin.js        // NEW — serves public/admin/index.html under /admin/
public/admin/index.html           // NEW — the one-page admin UI
src/server.js                     // MODIFY — conditionally register auth/staticAdmin/adminTemplates;
                                   //   exclude /admin/* from the existing API-key preHandler hook
Dockerfile                        // MODIFY — COPY ./public ./public
README.md                         // MODIFY — Admin UI setup section

test/templates-store.test.js         // NEW
test/tenant-registry.test.js         // MODIFY — assert templatesPath is returned
test/tenant-auth.test.js             // MODIFY — templatesStore + keycloakSub lookup
test/vietqr-transaction.test.js      // MODIFY — mock templatesStore instead of raw templates array
test/admin-feature-flag.test.js      // NEW
test/admin-auth.test.js              // NEW — PKCE/state, session shape, guard, feature-flag-off
test/admin-templates.test.js         // NEW — CRUD + preview
test/admin-ui-registration.test.js   // NEW — feature-flag-off/on/partial registration behavior
test/admin-hot-reload-integration.test.js  // NEW — the "no restart required" proof
```

---

### Task 1: Per-tenant templates store (`src/templates/store.js`)

**Files:**
- Create: `src/templates/store.js`
- Test: `test/templates-store.test.js`

**Interfaces:**
- Consumes: `validateTemplates` (`../templates/schema`, already merged)
- Produces: `createTemplatesStore(configPath: string, initialTemplates: Array) => { getTemplates(): Array, replaceAll(newTemplates: Array): void }`. `replaceAll` throws (and touches neither the file nor the in-memory array) if `validateTemplates(newTemplates)` fails; otherwise it creates `configPath`'s parent directory if missing (a tenant with no prior `templates.json` also has no `config/tenants/<id>/` directory yet — both per-tenant files are individually optional), writes `configPath` (pretty-printed JSON), and then updates the in-memory array.

- [ ] **Step 1: Write the failing tests**

Create `test/templates-store.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/templates-store.test.js`
Expected: FAIL — `Cannot find module '../src/templates/store'`

- [ ] **Step 3: Implement**

Create `src/templates/store.js`:

```js
const fs = require("node:fs");
const path = require("node:path");
const { validateTemplates } = require("./schema");

const createTemplatesStore = (configPath, initialTemplates) => {
  let templates = initialTemplates;

  const getTemplates = () => templates;

  const replaceAll = (newTemplates) => {
    validateTemplates(newTemplates); // throws on failure, leaving `templates` untouched
    fs.mkdirSync(path.dirname(configPath), { recursive: true }); // a tenant whose templates.json
      // never existed also never had its config/tenants/<id>/ directory created — both per-tenant
      // files are individually optional, so this directory may not exist yet on this store's first write
    fs.writeFileSync(configPath, JSON.stringify(newTemplates, null, 2));
    templates = newTemplates;
  };

  return { getTemplates, replaceAll };
};

module.exports = { createTemplatesStore };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/templates-store.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/templates/store.js test/templates-store.test.js
git commit -m "Add per-tenant templates store (createTemplatesStore)"
```

---

### Task 2: `tenantRegistry.js` — resolve and return each tenant's `templatesPath`

**Files:**
- Modify: `src/lib/tenantRegistry.js`
- Modify: `test/tenant-registry.test.js`

**Interfaces:**
- Produces: `loadTenants(tenantsConfigPath)` now returns tenant objects shaped `{ id, actualSyncId, actualPassword, actualEncryptionPassword, apiKey, keycloakSub, accountMapJson, templates, templatesPath }` — the only change is the added `templatesPath` field (a string: the exact path `templates.json` was read from, i.e. `path.join(tenantsRootDir, "tenants", id, "templates.json")`, which is already computed internally but was never returned before).

- [ ] **Step 1: Write the failing test**

In `test/tenant-registry.test.js`, add this test inside the existing `describe("loadTenants", ...)` block (alongside the existing tests — do not remove any of them):

```js
  it("returns each tenant's resolved templatesPath", () => {
    const tenants = loadTenants(FIXTURE_VALID);
    const [alice] = tenants;
    assert.strictEqual(
      alice.templatesPath,
      path.join(path.dirname(FIXTURE_VALID), "tenants", "alice", "templates.json")
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/tenant-registry.test.js`
Expected: FAIL — `alice.templatesPath` is `undefined`

- [ ] **Step 3: Implement**

In `src/lib/tenantRegistry.js`, the function already computes `templatesPath` as a local variable (`const templatesPath = path.join(tenantsRootDir, "tenants", raw.id, "templates.json");`). Add it to the returned object literal at the end of the `.map()` callback:

```js
    return {
      id: raw.id,
      actualSyncId: raw.actualSyncId,
      actualPassword: raw.actualPassword,
      actualEncryptionPassword: raw.actualEncryptionPassword || "",
      apiKey: raw.apiKey,
      keycloakSub: raw.keycloakSub || null,
      accountMapJson,
      templates,
      templatesPath,
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/tenant-registry.test.js`
Expected: PASS (all tests, including the new one)

- [ ] **Step 5: Commit**

```bash
git add src/lib/tenantRegistry.js test/tenant-registry.test.js
git commit -m "Return each tenant's resolved templatesPath from loadTenants"
```

---

### Task 3: `tenantAuth.js` — per-tenant `templatesStore` + `keycloakSub` lookup

**Files:**
- Modify: `src/lib/tenantAuth.js`
- Modify: `test/tenant-auth.test.js`

**Interfaces:**
- Consumes: `createTemplatesStore` (Task 1, `../templates/store`)
- Produces: `buildTenantLookup(tenants, workerClients) => { tenantsById, tenantsByApiKey, tenantsByKeycloakSub }`. Each tenant object built by this function is now `{ id, workerClient, templatesStore, accountMapJson, keycloakSub }` — `templatesStore` (an object) replaces the old `templates` (a raw array) field; `templatesStore` is built via `createTemplatesStore(t.templatesPath, t.templates)`. Also produces `resolveTenantByKeycloakSub(tenantsByKeycloakSub, sub) => tenant | null`, mirroring the existing `resolveTenant`.
- `tenantsByKeycloakSub` only contains entries for tenants whose `keycloakSub` is a non-null, non-empty string — multiple tenants may have `keycloakSub: null` (not yet configured for SSO) and none of those should collide on a `null` key.

- [ ] **Step 1: Write the failing tests**

Replace `test/tenant-auth.test.js` in full:

```js
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

const buildTenants = () => [
  {
    id: "alice",
    apiKey: "alice-key",
    templates: [{ name: "t-alice" }],
    templatesPath: tempTemplatesPath([{ name: "t-alice" }]),
    accountMapJson: '{"1":"Alice Acc"}',
    keycloakSub: "sub-alice",
  },
  {
    id: "bob",
    apiKey: "bob-key",
    templates: [{ name: "t-bob" }],
    templatesPath: tempTemplatesPath([{ name: "t-bob" }]),
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
    assert.deepStrictEqual(alice.templatesStore.getTemplates(), [{ name: "t-alice" }]);
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

    alice.templatesStore.replaceAll([{ name: "t-alice-v2" }]);

    assert.deepStrictEqual(alice.templatesStore.getTemplates(), [{ name: "t-alice-v2" }]);
    assert.deepStrictEqual(bob.templatesStore.getTemplates(), [{ name: "t-bob" }]);
    const bobOnDisk = JSON.parse(fs.readFileSync(tenants[1].templatesPath, "utf8"));
    assert.deepStrictEqual(bobOnDisk, [{ name: "t-bob" }]);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/tenant-auth.test.js`
Expected: FAIL — `resolveTenantByKeycloakSub` is not exported; `alice.templatesStore` is `undefined`

- [ ] **Step 3: Implement**

Replace `src/lib/tenantAuth.js` in full:

```js
const { createTemplatesStore } = require("../templates/store");

const buildTenantLookup = (tenants, workerClients) => {
  const tenantsById = new Map();
  const tenantsByKeycloakSub = new Map();

  for (const t of tenants) {
    const tenant = {
      id: t.id,
      workerClient: workerClients.get(t.id),
      templatesStore: createTemplatesStore(t.templatesPath, t.templates),
      accountMapJson: t.accountMapJson,
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

const resolveTenant = (tenantsByApiKey, apiKey) => tenantsByApiKey.get(apiKey) || null;

const resolveTenantByKeycloakSub = (tenantsByKeycloakSub, sub) => tenantsByKeycloakSub.get(sub) || null;

module.exports = { buildTenantLookup, resolveTenant, resolveTenantByKeycloakSub };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/tenant-auth.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/tenantAuth.js test/tenant-auth.test.js
git commit -m "Add per-tenant templatesStore and keycloakSub-based tenant lookup"
```

---

### Task 4: Rewire `/vietqr-transaction` onto `templatesStore`

**Files:**
- Modify: `src/routes/vietqrTransaction.js`
- Modify: `test/vietqr-transaction.test.js`

**Interfaces:**
- Consumes: `request.tenant.templatesStore.getTemplates()` (Task 3)
- No other change to this route's logic, dedup key, or error handling.

- [ ] **Step 1: Modify `src/routes/vietqrTransaction.js`**

Change exactly this one line:

```js
    const templates = request.tenant.templates;
```
to:
```js
    const templates = request.tenant.templatesStore.getTemplates();
```

- [ ] **Step 2: Update `test/vietqr-transaction.test.js`'s `buildMockServer`**

The mock server currently builds `request.tenant = { id: tenantId, workerClient: mockWorkerClient, templates, accountMapJson };` (a raw `templates` array). Change it to provide a `templatesStore`-shaped object instead — a minimal fake is enough since this test file never exercises `replaceAll()`:

```js
    request.tenant = {
      id: tenantId,
      workerClient: mockWorkerClient,
      templatesStore: { getTemplates: () => templates },
      accountMapJson,
    };
```

(This replaces the single line `request.tenant = { id: tenantId, workerClient: mockWorkerClient, templates, accountMapJson };` inside the `preHandler` hook in `buildMockServer` — nothing else in the file changes.)

- [ ] **Step 3: Run the test to verify it passes**

Run: `node --test test/vietqr-transaction.test.js`
Expected: PASS (all 10 existing tests, unchanged assertions)

- [ ] **Step 4: Commit**

```bash
git add src/routes/vietqrTransaction.js test/vietqr-transaction.test.js
git commit -m "Read /vietqr-transaction's templates through request.tenant.templatesStore"
```

---

### Task 5: Feature-flag config (`src/lib/adminFeatureFlag.js`) + env schema

**Files:**
- Create: `src/lib/adminFeatureFlag.js`
- Modify: `src/plugins/env.js`
- Modify: `package.json`
- Test: `test/admin-feature-flag.test.js`

**Interfaces:**
- Produces: `resolveAdminUiConfig(config: object) => { enabled: false } | { enabled: true, issuerUrl, clientId, clientSecret, sessionSecret, appBaseUrl }`. Throws a single `Error` naming exactly which of the 5 required keys are missing if 1-4 (but not 0 or 5) are present. Throws if `SESSION_SECRET` is present but shorter than 32 characters.
- `config` is whatever object exposes the 5 keys as string-or-undefined properties (in production, `fastify.config`; in tests, a plain object).

- [ ] **Step 1: Write the failing tests**

Create `test/admin-feature-flag.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { resolveAdminUiConfig } = require("../src/lib/adminFeatureFlag");

const FULL_CONFIG = {
  KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
  KEYCLOAK_CLIENT_ID: "actualtap-admin",
  KEYCLOAK_CLIENT_SECRET: "s3cr3t",
  SESSION_SECRET: "a".repeat(32),
  APP_BASE_URL: "https://actualtap.example.com",
};

describe("resolveAdminUiConfig", () => {
  it("returns { enabled: false } when none of the 5 vars are set", () => {
    assert.deepStrictEqual(resolveAdminUiConfig({}), { enabled: false });
  });

  it("returns the full resolved config when all 5 vars are set", () => {
    const result = resolveAdminUiConfig(FULL_CONFIG);
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.issuerUrl, FULL_CONFIG.KEYCLOAK_ISSUER_URL);
    assert.strictEqual(result.clientId, FULL_CONFIG.KEYCLOAK_CLIENT_ID);
    assert.strictEqual(result.clientSecret, FULL_CONFIG.KEYCLOAK_CLIENT_SECRET);
    assert.strictEqual(result.sessionSecret, FULL_CONFIG.SESSION_SECRET);
    assert.strictEqual(result.appBaseUrl, FULL_CONFIG.APP_BASE_URL);
  });

  it("throws naming the missing vars when only some are set", () => {
    const partial = { ...FULL_CONFIG, KEYCLOAK_CLIENT_SECRET: undefined, APP_BASE_URL: undefined };
    assert.throws(
      () => resolveAdminUiConfig(partial),
      /KEYCLOAK_CLIENT_SECRET.*APP_BASE_URL|APP_BASE_URL.*KEYCLOAK_CLIENT_SECRET/
    );
  });

  it("throws when SESSION_SECRET is shorter than 32 characters", () => {
    const shortSecret = { ...FULL_CONFIG, SESSION_SECRET: "too-short" };
    assert.throws(() => resolveAdminUiConfig(shortSecret), /SESSION_SECRET/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/admin-feature-flag.test.js`
Expected: FAIL — `Cannot find module '../src/lib/adminFeatureFlag'`

- [ ] **Step 3: Implement**

Create `src/lib/adminFeatureFlag.js`:

```js
const REQUIRED_KEYS = [
  "KEYCLOAK_ISSUER_URL",
  "KEYCLOAK_CLIENT_ID",
  "KEYCLOAK_CLIENT_SECRET",
  "SESSION_SECRET",
  "APP_BASE_URL",
];

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

const resolveAdminUiConfig = (config) => {
  const present = REQUIRED_KEYS.filter((k) => isNonEmptyString(config[k]));

  if (present.length === 0) {
    return { enabled: false };
  }

  if (present.length < REQUIRED_KEYS.length) {
    const missing = REQUIRED_KEYS.filter((k) => !isNonEmptyString(config[k]));
    throw new Error(
      `Partial admin UI configuration: missing ${missing.join(", ")}. ` +
        `Set all of ${REQUIRED_KEYS.join(", ")} to enable the admin UI, or none to leave it disabled.`
    );
  }

  if (config.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters long");
  }

  return {
    enabled: true,
    issuerUrl: config.KEYCLOAK_ISSUER_URL,
    clientId: config.KEYCLOAK_CLIENT_ID,
    clientSecret: config.KEYCLOAK_CLIENT_SECRET,
    sessionSecret: config.SESSION_SECRET,
    appBaseUrl: config.APP_BASE_URL,
  };
};

module.exports = { resolveAdminUiConfig, REQUIRED_KEYS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/admin-feature-flag.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the 5 optional env vars to `src/plugins/env.js`**

Add these 5 properties to the existing `schema.properties` object (do not add any of them to `required` — they stay optional):

```js
    KEYCLOAK_ISSUER_URL: { type: "string" },
    KEYCLOAK_CLIENT_ID: { type: "string" },
    KEYCLOAK_CLIENT_SECRET: { type: "string" },
    SESSION_SECRET: { type: "string" },
    APP_BASE_URL: { type: "string" },
```

- [ ] **Step 6: Add the new dependencies to `package.json`**

Add to `"dependencies"`:

```json
    "openid-client": "^5.7.1",
    "@fastify/cookie": "^11.0.2",
    "@fastify/session": "^11.1.0",
    "@fastify/static": "^8.1.1",
```

Run `npm install` and commit the resulting `package-lock.json` changes alongside `package.json`. If any of these four pinned versions fail to resolve (registry has moved on), install the latest version matching the same major (`^5` for `openid-client`, `^11`/`^11`/`^8` for the three `@fastify/*` packages) and use that instead — do not jump `openid-client` to `^6` (see Global Constraints: it is ESM-only, this codebase is CommonJS).

- [ ] **Step 7: Commit**

```bash
git add src/lib/adminFeatureFlag.js test/admin-feature-flag.test.js src/plugins/env.js package.json package-lock.json
git commit -m "Add admin UI feature-flag resolution and its 5 optional env vars"
```

---

### Task 6: OIDC auth plugin (`src/plugins/auth.js`)

**Files:**
- Create: `src/plugins/auth.js`
- Test: `test/admin-auth.test.js`

**Interfaces:**
- Consumes: `fastify.config.{KEYCLOAK_ISSUER_URL, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, APP_BASE_URL}`, `opts.tenantsByKeycloakSub` (Task 3's `Map`), and — for testability only — an injectable `opts.oidcClient` that, when provided, is used INSTEAD of calling the real `createOidcClient()` (which does a real network `Issuer.discover()` call).
- Produces: registers `GET /admin/login`, `GET /admin/callback`, `POST /admin/logout`, and a global `preHandler` hook that redirects any unauthenticated `GET /admin/*` request (other than `/admin/login`/`/admin/callback`) to `/admin/login`, and sets `request.tenant` (looked up via `resolveTenantByKeycloakSub`) for an authenticated one. Also exports `createOidcClient` (not itself unit-tested here — requires a real Keycloak).

- [ ] **Step 1: Write the failing tests**

Create `test/admin-auth.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const fastifyCookie = require("@fastify/cookie");
const fastifySession = require("@fastify/session");
const authPlugin = require("../src/plugins/auth");

const SESSION_SECRET = "a".repeat(32);
const APP_BASE_URL = "https://actualtap.example.com";

function fakeOidcClient({ sub = "sub-alice" } = {}) {
  const calls = { authorizationUrl: [], callback: [] };
  return {
    calls,
    authorizationUrl(params) {
      calls.authorizationUrl.push(params);
      return "https://keycloak.example.com/auth?mock=1";
    },
    async callback(params, checks) {
      calls.callback.push({ params, checks });
      if (params.code === "bad-code") throw new Error("invalid_grant");
      return {
        claims: () => ({ sub, preferred_username: "alice", email: "alice@example.com" }),
      };
    },
    endSessionUrl: null,
  };
}

async function buildApp({ oidcClient = fakeOidcClient(), tenantsByKeycloakSub = new Map([["sub-alice", { id: "alice", templatesStore: {} }]]) } = {}) {
  const app = fastify({ logger: false });
  app.decorate("config", {
    KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
    KEYCLOAK_CLIENT_ID: "actualtap-admin",
    KEYCLOAK_CLIENT_SECRET: "secret",
    APP_BASE_URL,
  });
  await app.register(fastifyCookie);
  await app.register(fastifySession, { secret: SESSION_SECRET, cookie: { secure: false } });
  await app.register(authPlugin, { oidcClient, tenantsByKeycloakSub });
  app.get("/admin/", async () => ({ ok: true, tenant: true }));
  return app;
}

describe("GET /admin/login", () => {
  it("redirects to the authorization URL and stashes PKCE verifier + state in the session", async () => {
    const oidcClient = fakeOidcClient();
    const app = await buildApp({ oidcClient });
    const response = await app.inject({ method: "GET", url: "/admin/login" });
    assert.strictEqual(response.statusCode, 302);
    assert.strictEqual(response.headers.location, "https://keycloak.example.com/auth?mock=1");
    assert.strictEqual(oidcClient.calls.authorizationUrl.length, 1);
    const params = oidcClient.calls.authorizationUrl[0];
    assert.strictEqual(params.code_challenge_method, "S256");
    assert.ok(params.code_challenge);
    assert.ok(params.state);
    await app.close();
  });
});

describe("GET /admin/callback", () => {
  it("on success, sets a session and redirects to returnTo", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const app = await buildApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login?returnTo=/admin/foo" });
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/admin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });

    assert.strictEqual(callbackResponse.statusCode, 302);
    assert.strictEqual(callbackResponse.headers.location, "/admin/foo");
    assert.strictEqual(oidcClient.calls.callback.length, 1);
    assert.strictEqual(oidcClient.calls.callback[0].params.code, "good-code");
    await app.close();
  });

  it("rejects a mismatched state without calling the token endpoint", async () => {
    const oidcClient = fakeOidcClient();
    const app = await buildApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const response = await app.inject({
      method: "GET",
      url: "/admin/callback?code=good-code&state=wrong-state",
      headers: { cookie },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(oidcClient.calls.callback.length, 0);
    await app.close();
  });

  it("returns 401 when the token exchange itself fails", async () => {
    const oidcClient = fakeOidcClient();
    const app = await buildApp({ oidcClient });

    const loginResponse = await app.inject({ method: "GET", url: "/admin/login" });
    const cookie = loginResponse.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = oidcClient.calls.authorizationUrl[0].state;

    const response = await app.inject({
      method: "GET",
      url: `/admin/callback?code=bad-code&state=${state}`,
      headers: { cookie },
    });

    assert.strictEqual(response.statusCode, 401);
    await app.close();
  });
});

describe("admin guard preHandler", () => {
  it("redirects an unauthenticated GET /admin/* request to /admin/login", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/admin/" });
    assert.strictEqual(response.statusCode, 302);
    assert.ok(response.headers.location.startsWith("/admin/login"));
    await app.close();
  });

  it("sets request.tenant and allows the request through after a successful login", async () => {
    const oidcClient = fakeOidcClient({ sub: "sub-alice" });
    const tenantsByKeycloakSub = new Map([["sub-alice", { id: "alice", templatesStore: {} }]]);
    const app = await buildApp({ oidcClient, tenantsByKeycloakSub });

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
    assert.deepStrictEqual(JSON.parse(response.body), { ok: true, tenant: true });
    await app.close();
  });

  it("returns 403 when the authenticated sub has no matching tenant", async () => {
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
    assert.strictEqual(response.statusCode, 403);
    await app.close();
  });
});

describe("POST /admin/logout", () => {
  it("destroys the session and redirects to /admin/login when no end-session endpoint exists", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/admin/logout" });
    assert.strictEqual(response.statusCode, 302);
    assert.strictEqual(response.headers.location, "/admin/login");
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/admin-auth.test.js`
Expected: FAIL — `Cannot find module '../src/plugins/auth'`

- [ ] **Step 3: Implement**

Create `src/plugins/auth.js`:

```js
const fp = require("fastify-plugin");
const { Issuer, generators } = require("openid-client");
const { resolveTenantByKeycloakSub } = require("../lib/tenantAuth");

const createOidcClient = async ({ issuerUrl, clientId, clientSecret, redirectUri }) => {
  const issuer = await Issuer.discover(issuerUrl);
  const client = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: [redirectUri],
    response_types: ["code"],
  });

  return {
    authorizationUrl: (params) => client.authorizationUrl(params),
    callback: (params, checks) => client.callback(redirectUri, params, checks),
    endSessionUrl: issuer.metadata.end_session_endpoint
      ? (params) => client.endSessionUrl(params)
      : null,
  };
};

module.exports = fp(async (fastify, opts) => {
  const { KEYCLOAK_ISSUER_URL, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, APP_BASE_URL } = fastify.config;
  const redirectUri = `${APP_BASE_URL}/admin/callback`;

  const oidcClient =
    opts.oidcClient ||
    (await createOidcClient({
      issuerUrl: KEYCLOAK_ISSUER_URL,
      clientId: KEYCLOAK_CLIENT_ID,
      clientSecret: KEYCLOAK_CLIENT_SECRET,
      redirectUri,
    }));

  const { tenantsByKeycloakSub } = opts;

  fastify.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin")) return;
    if (request.url.startsWith("/admin/login") || request.url.startsWith("/admin/callback")) return;

    if (!request.session.userSub) {
      const returnTo = encodeURIComponent(request.url);
      reply.redirect(`/admin/login?returnTo=${returnTo}`);
      return;
    }

    const tenant = resolveTenantByKeycloakSub(tenantsByKeycloakSub, request.session.userSub);
    if (!tenant) {
      reply.code(403).send({
        error: "No tenant associated with this account",
        message: `Add "keycloakSub": "${request.session.userSub}" to a tenant's entry in config/tenants.json, then restart.`,
      });
      return;
    }
    request.tenant = tenant;
  });

  fastify.get("/admin/login", async (request, reply) => {
    const codeVerifier = generators.codeVerifier();
    const state = generators.state();
    request.session.codeVerifier = codeVerifier;
    request.session.oauthState = state;
    request.session.returnTo = request.query.returnTo || "/admin/";

    const url = oidcClient.authorizationUrl({
      scope: "openid profile email",
      code_challenge: generators.codeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
    });
    reply.redirect(url);
  });

  fastify.get("/admin/callback", async (request, reply) => {
    const { code, state } = request.query;

    if (!state || state !== request.session.oauthState) {
      reply.code(400).send({ error: "Invalid state" });
      return;
    }

    let tokenSet;
    try {
      tokenSet = await oidcClient.callback(
        { code, state },
        { code_verifier: request.session.codeVerifier, state: request.session.oauthState }
      );
    } catch (err) {
      reply.code(401).send({ error: "Authentication failed", message: err.message });
      return;
    }

    const claims = tokenSet.claims();
    request.session.userSub = claims.sub;
    request.session.userLabel = claims.preferred_username || claims.email || claims.sub;
    delete request.session.codeVerifier;
    delete request.session.oauthState;

    const returnTo = request.session.returnTo || "/admin/";
    delete request.session.returnTo;
    reply.redirect(returnTo);
  });

  fastify.post("/admin/logout", async (request, reply) => {
    const endSessionUrl = oidcClient.endSessionUrl
      ? oidcClient.endSessionUrl({ post_logout_redirect_uri: `${APP_BASE_URL}/admin/login` })
      : "/admin/login";
    await request.session.destroy();
    reply.redirect(endSessionUrl);
  });
});

module.exports.createOidcClient = createOidcClient;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/admin-auth.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/plugins/auth.js test/admin-auth.test.js
git commit -m "Add OIDC (Keycloak) login/callback/logout and the /admin/* auth guard"
```

---

### Task 7: Admin templates CRUD API (`src/routes/adminTemplates.js`)

**Files:**
- Create: `src/routes/adminTemplates.js`
- Test: `test/admin-templates.test.js`

**Interfaces:**
- Consumes: `request.tenant.templatesStore` (Task 3, set by `auth.js`'s guard hook from Task 6)
- Produces: `GET /admin/api/templates`, `POST /admin/api/templates`, `PUT /admin/api/templates/:name`, `DELETE /admin/api/templates/:name`.

- [ ] **Step 1: Write the failing tests**

Create `test/admin-templates.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const adminTemplatesPlugin = require("../src/routes/adminTemplates");

const TEMPLATE_A = {
  name: "a",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["Foo"] },
  fields: { x: { label: "Foo:", stopLabel: "$END$" } },
  requiredFields: ["x"],
};

function fakeTemplatesStore(initial) {
  let templates = initial;
  return {
    getTemplates: () => templates,
    replaceAll: (next) => {
      templates = next;
    },
  };
}

async function buildApp({ templates = [TEMPLATE_A] } = {}) {
  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });
  const templatesStore = fakeTemplatesStore(templates);
  app.addHook("preHandler", async (request) => {
    request.tenant = { id: "alice", templatesStore };
  });
  await app.register(adminTemplatesPlugin);
  return { app, templatesStore };
}

describe("GET /admin/api/templates", () => {
  it("returns the tenant's current templates", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/admin/api/templates" });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), [TEMPLATE_A]);
    await app.close();
  });
});

describe("POST /admin/api/templates", () => {
  it("appends a new template", async () => {
    const { app, templatesStore } = await buildApp({ templates: [] });
    const newTemplate = { ...TEMPLATE_A, name: "b" };
    const response = await app.inject({ method: "POST", url: "/admin/api/templates", payload: newTemplate });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(templatesStore.getTemplates(), [newTemplate]);
    await app.close();
  });

  it("returns 409 when the name already exists", async () => {
    const { app } = await buildApp({ templates: [TEMPLATE_A] });
    const response = await app.inject({ method: "POST", url: "/admin/api/templates", payload: TEMPLATE_A });
    assert.strictEqual(response.statusCode, 409);
    assert.strictEqual(JSON.parse(response.body).error, "Template already exists");
    await app.close();
  });

  it("returns 400 with the validation message when the new template is invalid", async () => {
    const { app } = await buildApp({ templates: [] });
    const response = await app.inject({ method: "POST", url: "/admin/api/templates", payload: { name: "bad" } });
    assert.strictEqual(response.statusCode, 400);
    await app.close();
  });
});

describe("PUT /admin/api/templates/:name", () => {
  it("replaces the existing entry", async () => {
    const { app, templatesStore } = await buildApp({ templates: [TEMPLATE_A] });
    const updated = { ...TEMPLATE_A, direction: "income" };
    const response = await app.inject({ method: "PUT", url: "/admin/api/templates/a", payload: updated });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(templatesStore.getTemplates(), [updated]);
    await app.close();
  });

  it("returns 404 when :name doesn't match any existing entry", async () => {
    const { app } = await buildApp({ templates: [TEMPLATE_A] });
    const response = await app.inject({ method: "PUT", url: "/admin/api/templates/nonexistent", payload: TEMPLATE_A });
    assert.strictEqual(response.statusCode, 404);
    await app.close();
  });

  it("returns 400 when renaming to a name that collides with a different entry", async () => {
    const templateB = { ...TEMPLATE_A, name: "b" };
    const { app } = await buildApp({ templates: [TEMPLATE_A, templateB] });
    const renamed = { ...TEMPLATE_A, name: "b" }; // renaming "a" to the already-existing "b"
    const response = await app.inject({ method: "PUT", url: "/admin/api/templates/a", payload: renamed });
    assert.strictEqual(response.statusCode, 400);
    await app.close();
  });
});

describe("DELETE /admin/api/templates/:name", () => {
  it("removes the matching entry", async () => {
    const { app, templatesStore } = await buildApp({ templates: [TEMPLATE_A] });
    const response = await app.inject({ method: "DELETE", url: "/admin/api/templates/a" });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(templatesStore.getTemplates(), []);
    await app.close();
  });

  it("returns 404 when :name doesn't match any existing entry", async () => {
    const { app } = await buildApp({ templates: [TEMPLATE_A] });
    const response = await app.inject({ method: "DELETE", url: "/admin/api/templates/nonexistent" });
    assert.strictEqual(response.statusCode, 404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/admin-templates.test.js`
Expected: FAIL — `Cannot find module '../src/routes/adminTemplates'`

- [ ] **Step 3: Implement**

Create `src/routes/adminTemplates.js`:

```js
module.exports = async (fastify, opts) => {
  fastify.get("/admin/api/templates", async (request) => {
    return request.tenant.templatesStore.getTemplates();
  });

  fastify.post("/admin/api/templates", async (request, reply) => {
    const templates = request.tenant.templatesStore.getTemplates();
    const newTemplate = request.body;

    if (templates.some((t) => t.name === newTemplate.name)) {
      return reply.code(409).send({ error: "Template already exists" });
    }

    try {
      request.tenant.templatesStore.replaceAll([...templates, newTemplate]);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid template", message: err.message });
    }

    return newTemplate;
  });

  fastify.put("/admin/api/templates/:name", async (request, reply) => {
    const templates = request.tenant.templatesStore.getTemplates();
    const index = templates.findIndex((t) => t.name === request.params.name);
    if (index === -1) {
      return reply.code(404).send({ error: "Template not found" });
    }

    const next = [...templates];
    next[index] = request.body;

    try {
      request.tenant.templatesStore.replaceAll(next);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid template", message: err.message });
    }

    return request.body;
  });

  fastify.delete("/admin/api/templates/:name", async (request, reply) => {
    const templates = request.tenant.templatesStore.getTemplates();
    const index = templates.findIndex((t) => t.name === request.params.name);
    if (index === -1) {
      return reply.code(404).send({ error: "Template not found" });
    }

    const next = templates.filter((_, i) => i !== index);
    request.tenant.templatesStore.replaceAll(next); // removing an entry can't introduce a new validation error

    return { ok: true };
  });
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/admin-templates.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/routes/adminTemplates.js test/admin-templates.test.js
git commit -m "Add admin templates CRUD API"
```

---

### Task 8: Preview endpoint (`POST /admin/api/preview`)

**Files:**
- Modify: `src/routes/adminTemplates.js`
- Modify: `test/admin-templates.test.js`

**Interfaces:**
- Consumes: `normalize`, `identify`, `extract`, `AmbiguousMatchError` (`../templates`, already merged — same imports `vietqrTransaction.js` already uses), `validateTemplates` (`../templates/schema`)
- Produces: `POST /admin/api/preview`, body `{ rawText, template }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/admin-templates.test.js` (add these `require`s at the top alongside the existing ones, and this new `describe` block at the end):

```js
const fs = require("node:fs");
const path = require("node:path");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8");
const BIDV_TEMPLATE = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/templates.json"), "utf8"))[0];
```

```js
describe("POST /admin/api/preview", () => {
  it("returns matched: true and the parsed fields when the draft template matches", async () => {
    const { app } = await buildApp({ templates: [] });
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/preview",
      payload: { rawText: FIXTURE, template: BIDV_TEMPLATE },
    });
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.matched, true);
    assert.strictEqual(body.parsed.amount, -1000000);
    await app.close();
  });

  it("returns matched: false when the draft template doesn't match the sample text", async () => {
    const { app } = await buildApp({ templates: [] });
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/preview",
      payload: { rawText: "Your OTP code is 123456", template: BIDV_TEMPLATE },
    });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { matched: false });
    await app.close();
  });

  it("returns 400 when the draft template itself fails schema validation", async () => {
    const { app } = await buildApp({ templates: [] });
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/preview",
      payload: { rawText: FIXTURE, template: { name: "bad" } },
    });
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Invalid template");
    await app.close();
  });

  it("returns matched: true with an error message when extraction throws", async () => {
    const { app } = await buildApp({ templates: [] });
    const brokenTemplate = {
      ...BIDV_TEMPLATE,
      fields: { ...BIDV_TEMPLATE.fields, amount: { ...BIDV_TEMPLATE.fields.amount, stopLabel: "$NEVER_PRESENT$" } },
    };
    const response = await app.inject({
      method: "POST",
      url: "/admin/api/preview",
      payload: { rawText: FIXTURE, template: brokenTemplate },
    });
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.matched, true);
    assert.ok(body.error);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/admin-templates.test.js`
Expected: FAIL — `404` for `POST /admin/api/preview` (route doesn't exist yet)

- [ ] **Step 3: Implement**

Add to the top of `src/routes/adminTemplates.js`:

```js
const { normalize, identify, extract } = require("../templates");
const { validateTemplates } = require("../templates/schema");
```

Add this route inside the exported plugin function, alongside the existing CRUD routes:

```js
  fastify.post("/admin/api/preview", async (request, reply) => {
    const { rawText, template } = request.body;

    try {
      validateTemplates([template]);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid template", message: err.message });
    }

    const normalizedText = normalize(rawText);
    const matched = identify(normalizedText, [template]); // single-element array: never throws AmbiguousMatchError

    if (!matched) {
      return { matched: false };
    }

    try {
      const parsed = extract(normalizedText, matched);
      return { matched: true, parsed };
    } catch (err) {
      return { matched: true, error: err.message };
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/admin-templates.test.js`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/routes/adminTemplates.js test/admin-templates.test.js
git commit -m "Add template preview endpoint (POST /admin/api/preview)"
```

---

### Task 9: Static admin page (`src/plugins/staticAdmin.js` + `public/admin/index.html`)

**Files:**
- Create: `src/plugins/staticAdmin.js`
- Create: `public/admin/index.html`

**Interfaces:**
- Consumes: `GET /admin/api/templates`, `POST /admin/api/templates`, `PUT /admin/api/templates/:name`, `DELETE /admin/api/templates/:name`, `POST /admin/api/preview` (Tasks 7-8)
- Produces: `GET /admin/` (and any other static path under `/admin/`) serves `public/admin/index.html`.

This task is UI-only; it is verified manually (Step 3) rather than by an automated test, since there is no browser-automation tooling configured in this repo's test suite. `staticAdmin.js` itself is trivial enough (a single `@fastify/static` registration) that a unit test would only be testing the library, not this codebase's logic.

- [ ] **Step 1: Create `src/plugins/staticAdmin.js`**

```js
const path = require("node:path");
const fastifyStatic = require("@fastify/static");

module.exports = async (fastify, opts) => {
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, "..", "..", "public", "admin"),
    prefix: "/admin/",
  });
};
```

- [ ] **Step 2: Create `public/admin/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ActualTap — Templates</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; display: flex; height: 100vh; }
    aside { width: 260px; border-right: 1px solid #ddd; overflow-y: auto; padding: 12px; box-sizing: border-box; }
    aside ul { list-style: none; margin: 0; padding: 0; }
    aside li { padding: 8px; border-radius: 4px; cursor: pointer; }
    aside li:hover, aside li.active { background: #eef; }
    main { flex: 1; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; gap: 12px; }
    textarea { width: 100%; font-family: monospace; font-size: 13px; box-sizing: border-box; }
    #editor { flex: 1; min-height: 200px; }
    #preview-raw { height: 120px; }
    #preview-result { background: #f7f7f7; padding: 8px; border-radius: 4px; white-space: pre-wrap; font-family: monospace; font-size: 13px; }
    .row { display: flex; gap: 8px; align-items: center; }
    .error { color: #b00020; }
    button { padding: 6px 12px; cursor: pointer; }
  </style>
</head>
<body>
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

  <script>
    let currentName = null; // null = unsaved new template

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

    refreshList();
  </script>
</body>
</html>
```

- [ ] **Step 3: Verify by reading, not running**

There is no browser-automation test harness in this repo. Verify by re-reading `public/admin/index.html` against the three sections required by the spec: (1) a template list from `GET /admin/api/templates` that loads an entry into the editor on click, (2) a raw-JSON textarea editor whose Save calls `POST`/`PUT /admin/api/templates`, showing API error messages inline, (3) a preview panel with a `rawText` textarea and a "Test" button calling `POST /admin/api/preview`. Confirm all three are present in the file just written.

- [ ] **Step 4: Commit**

```bash
git add src/plugins/staticAdmin.js public/admin/index.html
git commit -m "Add the static admin page (list/editor/preview)"
```

---

### Task 10: Wire it all into `server.js` + Dockerfile

**Files:**
- Modify: `src/server.js`
- Modify: `Dockerfile`
- Test: `test/admin-ui-registration.test.js`

**Interfaces:**
- Consumes: `resolveAdminUiConfig` (Task 5), `auth.js`/`staticAdmin.js`/`adminTemplates.js` (Tasks 6, 9, 7-8), `tenantsByKeycloakSub` (Task 3, already produced by `buildTenantLookup`, just not yet consumed by `server.js`)

`src/server.js` itself is never unit-tested directly in this codebase (it boots real tenant workers, which need a real Actual server — the same reason `test/transaction.test.js` needs one). The spec's own testing plan (§9) explicitly requires a "feature-flag off → `/admin/*` 404s, server starts normally" regression check, so this task adds a small standalone test that mirrors `registerModules()`'s exact conditional-registration branching (Step 1 below) without booting real tenant workers — the same pattern Task 3 of the multi-tenant plan used to make the per-tenant auth hook testable in isolation from `server.js`.

- [ ] **Step 1: Modify `registerModules()` in `src/server.js`**

In the existing global API-key `preHandler` hook, extend the existing `/health` exclusion to also exclude `/admin`:

```js
  fastify.addHook("preHandler", async (request, reply) => {
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
```

Right after that hook registration (and after the existing `const { buildTenantLookup, resolveTenant } = require("./lib/tenantAuth");` / `const { tenantsByApiKey } = buildTenantLookup(tenants, workerClients);` lines — change that destructure to also pull out `tenantsByKeycloakSub`), add the conditional admin-UI registration:

```js
  const { buildTenantLookup, resolveTenant } = require("./lib/tenantAuth");
  const { tenantsByApiKey, tenantsByKeycloakSub } = buildTenantLookup(tenants, workerClients);
```

```js
  const { resolveAdminUiConfig } = require("./lib/adminFeatureFlag");
  const adminUiConfig = resolveAdminUiConfig(fastify.config);

  if (adminUiConfig.enabled) {
    fastify.log.info("Admin UI enabled");
    await fastify.register(require("@fastify/cookie"));
    await fastify.register(require("@fastify/session"), {
      secret: adminUiConfig.sessionSecret,
      cookie: { secure: adminUiConfig.appBaseUrl.startsWith("https://") },
    });
    await fastify.register(require("./plugins/auth"), { tenantsByKeycloakSub });
    await fastify.register(require("./plugins/staticAdmin"));
    await fastify.register(require("./routes/adminTemplates"));
  } else {
    fastify.log.info("Admin UI disabled (Keycloak env vars not set)");
  }
```

Place this block after `tenantsByApiKey`/`tenantsByKeycloakSub` are built and before `await fastify.register(require("@fastify/cors"), ...)`. `resolveAdminUiConfig` is called unconditionally (even before the `if`) so that a partial (1-4 vars set) misconfiguration fails startup with a clear error, per the feature-flag's own contract — do not wrap the `resolveAdminUiConfig(fastify.config)` call itself in the `if`.

- [ ] **Step 2: Add `public/` to the Docker image**

In `Dockerfile`, alongside the existing `COPY ./config ./config` line, add:

```dockerfile
COPY ./public ./public
```

- [ ] **Step 3: Write the feature-flag registration test**

Create `test/admin-ui-registration.test.js` — mirrors exactly the conditional-registration logic Step 1 just added to `registerModules()`, without booting real tenant workers:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const { resolveAdminUiConfig } = require("../src/lib/adminFeatureFlag");

async function buildApp(config) {
  const app = fastify({ logger: false });
  app.decorate("config", config);

  const adminUiConfig = resolveAdminUiConfig(app.config);
  if (adminUiConfig.enabled) {
    await app.register(require("@fastify/cookie"));
    await app.register(require("@fastify/session"), {
      secret: adminUiConfig.sessionSecret,
      cookie: { secure: false },
    });
    await app.register(require("../src/plugins/auth"), {
      oidcClient: {
        authorizationUrl: () => "https://keycloak.example.com/auth?mock=1",
        callback: async () => ({ claims: () => ({ sub: "sub-nobody" }) }),
        endSessionUrl: null,
      },
      tenantsByKeycloakSub: new Map(),
    });
    await app.register(require("../src/plugins/staticAdmin"));
    await app.register(require("../src/routes/adminTemplates"));
  }

  return app;
}

describe("admin UI conditional registration (mirrors server.js's registerModules())", () => {
  it("with none of the 5 Keycloak env vars set, /admin/ 404s and the app still starts", async () => {
    const app = await buildApp({});
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/admin/" });
    assert.strictEqual(response.statusCode, 404);
    await app.close();
  });

  it("with all 5 set, /admin/ is served (guard redirects to login instead of 404)", async () => {
    const app = await buildApp({
      KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
      KEYCLOAK_CLIENT_ID: "actualtap-admin",
      KEYCLOAK_CLIENT_SECRET: "secret",
      SESSION_SECRET: "a".repeat(32),
      APP_BASE_URL: "https://actualtap.example.com",
    });
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/admin/" });
    assert.strictEqual(response.statusCode, 302);
    await app.close();
  });

  it("with only some of the 5 set, the app fails to start with a clear error", async () => {
    await assert.rejects(
      () => buildApp({ KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual" }),
      /Partial admin UI configuration/
    );
  });
});
```

- [ ] **Step 4: Run the full test suite**

Run: `node --test test/*.test.js`
Expected: every sandbox-runnable test file passes; the 3 pre-existing real-Actual-server failures (`test/initialization.test.js`, `test/tenant-worker.test.js`, `test/transaction.test.js`) are unchanged and unrelated.

- [ ] **Step 5: Commit**

```bash
git add src/server.js Dockerfile test/admin-ui-registration.test.js
git commit -m "Wire the admin UI (auth, static page, CRUD/preview API) into server.js"
```

---

### Task 11: End-to-end hot-reload integration test

**Files:**
- Create: `test/admin-hot-reload-integration.test.js`

**Interfaces:**
- Consumes: `createTemplatesStore` (Task 1), `vietqrTransaction` route (Task 4), `adminTemplates` route (Tasks 7-8) — registers both against the SAME store instance in one app, proving the central "no restart required" requirement end-to-end.

- [ ] **Step 1: Write the test**

Create `test/admin-hot-reload-integration.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const fastify = require("fastify");
const { createTemplatesStore } = require("../src/templates/store");
const { createDedupCache } = require("../src/lib/dedupCache");

const TEMPLATE = {
  name: "hot-reload-test",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["HOTRELOAD-MARKER"] },
  fields: {
    sourceAccountNumber: { label: "Account:", stopLabel: "$END$" },
    amount: { label: "Amount:", type: "amount", stopLabel: "$END2$" },
  },
  requiredFields: ["sourceAccountNumber", "amount"],
};

const SAMPLE_TEXT = "HOTRELOAD-MARKER Account: 123456 $END$ Amount: 10.00 $END2$";

async function buildApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hot-reload-"));
  const templatesPath = path.join(dir, "templates.json");
  fs.writeFileSync(templatesPath, "[]");
  const templatesStore = createTemplatesStore(templatesPath, []);

  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });
  const addedTransactions = [];
  const mockWorkerClient = {
    getAccounts: async () => [{ id: "acc-1", name: "Checking" }],
    addTransactions: async (accountId, transactions) => {
      addedTransactions.push({ accountId, transactions });
      return "ok";
    },
    sync: async () => {},
  };
  app.decorate("addedTransactions", addedTransactions);

  app.addHook("preHandler", async (request) => {
    request.tenant = {
      id: "alice",
      workerClient: mockWorkerClient,
      templatesStore,
      accountMapJson: '{"123456":"Checking"}',
    };
  });

  await app.register(require("../src/routes/vietqrTransaction"), { dedupCache: createDedupCache() });
  await app.register(require("../src/routes/adminTemplates"));

  return app;
}

describe("Admin UI hot-reload (no restart required)", () => {
  it("a template created via the admin API is immediately usable by /vietqr-transaction", async () => {
    const app = await buildApp();

    const before = await app.inject({ method: "POST", url: "/vietqr-transaction", payload: { rawText: SAMPLE_TEXT } });
    assert.strictEqual(before.statusCode, 400);
    assert.strictEqual(JSON.parse(before.body).error, "Unrecognized bank format");

    const createResponse = await app.inject({ method: "POST", url: "/admin/api/templates", payload: TEMPLATE });
    assert.strictEqual(createResponse.statusCode, 200);

    const after = await app.inject({ method: "POST", url: "/vietqr-transaction", payload: { rawText: SAMPLE_TEXT } });
    assert.strictEqual(after.statusCode, 200);
    assert.strictEqual(app.addedTransactions.length, 1);

    await app.close();
  });

  it("a template deleted via the admin API stops matching on the very next request", async () => {
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/admin/api/templates", payload: TEMPLATE });

    const before = await app.inject({ method: "POST", url: "/vietqr-transaction", payload: { rawText: SAMPLE_TEXT } });
    assert.strictEqual(before.statusCode, 200);

    await app.inject({ method: "DELETE", url: `/admin/api/templates/${TEMPLATE.name}` });

    const after = await app.inject({ method: "POST", url: "/vietqr-transaction", payload: { rawText: SAMPLE_TEXT } });
    assert.strictEqual(after.statusCode, 400);

    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `node --test test/admin-hot-reload-integration.test.js`
Expected: PASS (2 tests)

- [ ] **Step 3: Commit**

```bash
git add test/admin-hot-reload-integration.test.js
git commit -m "Add end-to-end test proving admin template edits need no restart"
```

---

### Task 12: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the 5 new env vars to the Environment Variables table**

Add 5 rows to the existing table (after `TENANTS_CONFIG_PATH`):

```markdown
| `KEYCLOAK_ISSUER_URL`        | https://keycloak.yourdomain.com/realms/actual | _(optional)_ Enables the admin UI when set together with the other 4 admin vars below. The Keycloak realm issuer URL (same realm Actual Budget's own server uses). |
| `KEYCLOAK_CLIENT_ID`         | actualtap-admin                      | _(optional)_ The OIDC client ID registered in that Keycloak realm for this app. |
| `KEYCLOAK_CLIENT_SECRET`     | (secret)                             | _(optional)_ The OIDC client secret for that client. |
| `SESSION_SECRET`             | (32+ random characters)              | _(optional)_ Signs the admin session cookie. Required to be at least 32 characters when the admin UI is enabled. |
| `APP_BASE_URL`               | https://actualtap.yourdomain.com     | _(optional)_ This deployment's externally-reachable base URL, used to build the OIDC redirect URI (`${APP_BASE_URL}/admin/callback`) — register this exact URL in the Keycloak client. |
```

- [ ] **Step 2: Add an "Admin UI" section**

Add a new section (after "Multi-Tenant Configuration"):

```markdown
## Admin UI (Template Editor)

Setting all 5 of `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `SESSION_SECRET`, `APP_BASE_URL` enables a browser-based admin page at `/admin/`, gated behind Keycloak login, for creating/editing/deleting/previewing a tenant's `/vietqr-transaction` templates without hand-editing `templates.json` or restarting the container. Leaving all 5 unset disables the feature entirely (`/admin/*` returns 404); setting only some of them is treated as a misconfiguration and the server refuses to start, naming which ones are missing.

**Mapping a Keycloak user to a tenant:** add `"keycloakSub": "<the user's Keycloak subject id>"` to that tenant's entry in `config/tenants.json`. A user who logs in successfully but has no `keycloakSub` mapped to any tenant sees a `403` explaining exactly what to add and where.

**Registering the Keycloak client:** create an OIDC client in your Keycloak realm with the Authorization Code flow and PKCE enabled, and register `${APP_BASE_URL}/admin/callback` as a valid redirect URI.

Changes made through the admin UI take effect on the very next `/vietqr-transaction` request — no restart required (this is the one exception to the rest of this app's "edit the file and restart" model).
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the admin UI and Keycloak SSO setup"
```

---

### Task 13: Full regression run and final consistency check

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full suite**

Run: `node --test test/*.test.js`
Expected: every file passes except `test/initialization.test.js`, `test/tenant-worker.test.js`, `test/transaction.test.js` (all three require a real Actual server, unchanged from before this plan).

- [ ] **Step 2: Grep for any remaining reference to `request.tenant.templates` (the old raw-array field name)**

Run: `grep -rn "tenant\.templates\b" src/ test/ --include="*.js"`
Expected: no output — every reference should now be `tenant.templatesStore` (this catches a missed spot in Task 4's rewiring or a stray old-style mock left in some other test file).

- [ ] **Step 3: Confirm the admin UI's feature-flag-off path still passes today's regression suite**

Run: `node --test test/vietqr-transaction.test.js test/tenant-auth.test.js test/tenant-registry.test.js`
Expected: PASS — these three files together exercise every place `templatesStore`/`templatesPath` changed hands (Tasks 1-4), so a regression in the reconciliation would show up here specifically.

- [ ] **Step 4: Re-read the spec's Goals/Non-goals and confirm each is met**

- Static admin page, gated by Keycloak, CRUD + preview, no restart required: ✅ Tasks 6-11.
- Off by default, all-or-nothing env var check: ✅ Task 5, wired in Task 10.
- Anyone who authenticates gets full access (no role/claim check): ✅ Task 6 (no role check anywhere in the guard hook).
- No new persistence backend — `templates.json` remains the source of truth: ✅ Task 1 (`createTemplatesStore` still just reads/writes that file).
- Per-tenant isolation of the admin UI's own template CRUD (the multi-tenant integration this plan reconciles): ✅ Task 3 (`tenantsByKeycloakSub` + per-tenant `templatesStore` instances), proven independent in Task 3's own "each tenant's replaceAll() is independent" test.

No task left uncovered.
