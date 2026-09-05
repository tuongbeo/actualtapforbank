# Tenant Self-Service Onboarding — Design

Status: draft, awaiting user review
Scope: extends the Multi-Tenant Actual Connections spec
(`docs/superpowers/specs/2026-09-05-multi-tenant-actual-connections-design.md`, merged, §2/§9
explicitly deferred self-service) and the Admin UI + Keycloak SSO spec
(`docs/superpowers/specs/2026-09-05-admin-ui-keycloak-sso-design.md`, merged) — lets a
Keycloak-authenticated user provision their own tenant (Actual Budget connection + account-map +
templates) without an operator hand-editing `config/tenants.json` and restarting the server.
Also closes a path-prefix deployment gap surfaced by this deployment's real `APP_BASE_URL`.

## 1. Context

The multi-tenant spec's §2 explicitly declared "no self-service tenant signup" a non-goal, given
an expected scale of "a handful of tenants." This deployment now wants real users to onboard
themselves, so that decision is revisited here.

The admin-ui spec's auth flow (§4) assumes a tenant already exists for a logged-in
`keycloakSub`; the shipped guard (`src/plugins/auth.js`) returns a hard `403` telling the
operator to manually add the tenant. This spec replaces that dead end with a self-service
registration path.

Re-verified (again) against the installed `@actual-app/api@26.9.0`
(`node_modules/@actual-app/api/dist/index.js`): the client remains a module-level singleton —
`var internal = null;`, overwritten by `init()`; `send()`, `setServer()`, and `handlers` are all
module-scope, not attached to the value `init()` returns. This spec does **not** change the
one-child-process-per-tenant architecture — it only changes how a new tenant's entry gets
created.

Real deployment values now known:
- Keycloak realm `cash-lens` (shared with `actual-budget-web`, `cash-lens-test`, and MCP
  connectors — this app's own client `actual-transfer-hub-admin` is isolated: confidential,
  Standard Flow only, PKCE S256, no Direct Access Grants/Implicit/Service Accounts).
- `APP_BASE_URL=https://cash.lens.io.vn/actual-transfer-hub` — a **path-prefixed** deployment.
  The original admin-ui spec's cookie design (hardcoded `path: "/admin"`) did not anticipate
  this: a cookie set with `Path=/admin` is never sent back by the browser on requests to
  `/actual-transfer-hub/admin/*`, since the browser evaluates `Path` against the URL it actually
  sees. Left unfixed, login would appear to succeed and then immediately look unauthenticated
  again on the very next request.

## 2. Goals / Non-goals

**Goals:**
- A Keycloak-authenticated user with no existing tenant sees a self-service "connect your Actual
  Budget" form instead of a `403`.
- Submitting real Actual credentials (`actualSyncId`, `actualPassword`,
  `actualEncryptionPassword`) triggers a real connection attempt before anything is persisted —
  bad credentials are rejected with a clear error, nothing is written to disk or added to any
  in-memory registry.
- On success, a new tenant is added to the running server **without restarting**:
  `config/tenants.json` gains a new entry, a dedicated worker process is spawned, and the tenant
  is immediately usable via a freshly generated `apiKey` (shown once) for `/transaction` and
  `/vietqr-transaction`.
- Account-map CRUD is added to the admin UI, mirroring the existing templates CRUD — otherwise a
  self-registered tenant has no way to configure bank-account → Actual-account mapping, and every
  transaction would fail with "Unknown source account."
- The app works correctly when deployed under a URL path prefix (this deployment:
  `/actual-transfer-hub`) — specifically, the session cookie's `Path` matches the
  externally-visible prefix.
- Registration is idempotent per `keycloakSub` — a user who already has a tenant is sent straight
  to the normal admin UI, never shown the registration form again.

**Non-goals:**
- No worker-lifecycle change beyond "always-on once created" — no lazy-spawn, no idle eviction
  (explicit choice, matching the multi-tenant spec's existing posture).
- No self-service tenant *deletion* through the UI this pass — still operator/file-edit.
- No change to Keycloak realm/client management itself — this spec consumes the already-created
  `cash-lens` realm / `actual-transfer-hub-admin` client as externally provisioned.
- No multi-`ACTUAL_URL` support (still one shared Actual server, per the multi-tenant spec).
- No rate-limiting or cap on total tenant count.

## 3. File structure

```
src/lib/tenantProvisioning.js     // NEW — registerTenant(): validate, test-connect, persist,
                                  //   mutate live registry, single in-process write mutex
src/worker/tenantWorkerPool.js    // MODIFY — extract spawnOne() from spawnAll(); export both;
                                  //   killAll() must also reach post-boot workers
src/lib/accountMapStore.js        // NEW — createAccountMapStore(), mirrors templates/store.js
src/routes/adminAccountMap.js     // NEW — CRUD for the account map, mirrors adminTemplates.js
src/routes/adminRegister.js       // NEW — POST /admin/api/register
src/lib/tenantAuth.js             // MODIFY — tenant object carries accountMapStore instead of
                                  //   accountMapJson
src/lib/tenantRegistry.js         // MODIFY — also return each tenant's accountMapPath (mirrors
                                  //   the existing templatesPath)
src/routes/vietqrTransaction.js   // MODIFY — read via request.tenant.accountMapStore.getMapJson()
src/plugins/auth.js               // MODIFY — replace the hard 403 with the registration path;
                                  //   no longer requires request.tenant to reach /admin/register
public/admin/index.html           // MODIFY — registration view (shown when the API reports "no
                                  //   tenant yet") + account-map CRUD panel
src/server.js                     // MODIFY — cookie Path derived from APP_BASE_URL's own
                                  //   pathname; wire new routes; pass the live Maps + spawnOne
                                  //   into tenantProvisioning
README.md                         // MODIFY — nginx strip-prefix example; updated Keycloak
                                  //   redirect URI guidance for path-prefixed deployments
```

## 4. Tenant registration flow

```
GET /admin/  (Keycloak-authenticated session, no tenant for this sub)
  → today: 403 "contact admin"
  → NEW: 200, admin UI renders its registration view (no tenant data to show yet)

POST /admin/api/register
  body: { actualSyncId, actualPassword, actualEncryptionPassword? }
  requires: request.session.userSub set (Keycloak-authenticated) — does NOT require
            request.tenant, since none exists yet
  → tenantsByKeycloakSub already has this sub → 409 { error: "Tenant already exists" }
  → spawnOne({ id: userSub, actualUrl: <the deployment's global ACTUAL_URL>, syncId, password,
               encryptionPassword })
       failure → 422 { error: "Could not connect to Actual Budget", message: <cause> } —
                 nothing persisted, nothing added to any map
       success → persist (§5) → insert into the live registry (§6)
  → 201 { id, apiKey }   // apiKey is shown exactly once; the UI must tell the user to save it
                         //   before navigating away
```

## 5. Persistence (`src/lib/tenantProvisioning.js`)

- `id` is the `keycloakSub` itself — already unique per Keycloak user, so no separate identifier
  needs to be generated or collision-checked.
- `apiKey` is generated server-side: `crypto.randomBytes(32).toString("hex")`.
- On a successful `spawnOne()`:
  1. `fs.mkdirSync(path.join(tenantsRootDir, "tenants", id), { recursive: true })`.
  2. Write `account-map.json` = `"{}"` and `templates.json` = `"[]"` for the new tenant.
  3. Re-read `tenants.json`, append the new entry, write the result through a temp file +
     `fs.renameSync` (atomic on the same filesystem) — never a partial/torn write if the process
     crashes mid-write.
- A single in-process mutex (a chained promise: `queue = queue.then(fn, fn)`) serializes
  registrations, so two near-simultaneous requests can never race on the same `tenants.json`
  read-modify-write.
- If persistence fails **after** the worker already connected successfully, the just-spawned
  worker is killed and the request fails with `500` — an orphaned worker with no registry entry
  is never left behind.

## 6. Live registry mutation

`tenantsById`, `tenantsByApiKey`, and `tenantsByKeycloakSub` (from `buildTenantLookup`,
`src/lib/tenantAuth.js`) are plain `Map` instances held by reference in `src/server.js` and
closed over by `auth.js`'s guard hook and the data-plane API-key hook. Inserting a new entry into
these same instances from `tenantProvisioning.js` is visible everywhere immediately — no
restart, no pub/sub, no polling.

The `onClose` shutdown hook's `killAll()` must also reach workers spawned after boot: the array
`spawnAll()`'s closure tracks internally is exposed (returned alongside `clients`/`killAll`) so a
dynamically-spawned child can be appended to the same collection the shutdown hook already
drains.

## 7. Worker pool refactor (`src/worker/tenantWorkerPool.js`)

- Extract `spawnOne(tenant, workerPath, forkOptions) => Promise<{ child, client }>` — the
  per-child fork/ready-handshake/error-handling logic currently inlined in `spawnAll`'s
  `tenants.forEach`.
- `spawnAll(tenants, ...)` becomes: fork every tenant via `spawnOne`; if any single one rejects,
  kill every other child from this batch too. This preserves the existing all-or-nothing startup
  behavior exactly — a behavior-preserving refactor, so every existing `spawnAll` test must still
  pass unmodified.
- `spawnOne` is also exported and used directly (not through `spawnAll`) by
  `tenantProvisioning.js` for one dynamic registration; its failure only kills its own child,
  never touching any other tenant's already-running worker.

## 8. Account-map store + CRUD (mirrors the admin-ui spec's templates store/CRUD)

```js
// src/lib/accountMapStore.js
createAccountMapStore(configPath, initialMapJson) => {
  getMapJson() => string                 // current in-memory value, as a raw JSON string
  replaceAll(newMapObject) => void       // throws (no write, no mutation) if newMapObject isn't
                                          //   a flat object of string -> non-empty string; else
                                          //   writes configPath, then updates the in-memory value
}
```

`src/routes/adminAccountMap.js` (guarded by the same `request.tenant` check `adminTemplates.js`
already uses):

| Method + path | Behavior |
|---|---|
| `GET /admin/api/account-map` | Returns `JSON.parse(request.tenant.accountMapStore.getMapJson())`. |
| `PUT /admin/api/account-map` | Body is the full replacement object (`{"<bank account number>": "<Actual account name>"}`). Calls `replaceAll()`. Invalid shape → `400`. |

`vietqrTransaction.js` changes
`resolveAccountName(parsed.sourceAccountNumber, request.tenant.accountMapJson)` to
`resolveAccountName(parsed.sourceAccountNumber, request.tenant.accountMapStore.getMapJson())` —
`resolveAccountName` itself (`src/lib/accountResolver.js`) is unchanged; it already only takes a
JSON string.

`tenantAuth.js`'s `buildTenantLookup` changes the tenant object it builds from
`accountMapJson: t.accountMapJson` to
`accountMapStore: createAccountMapStore(t.accountMapPath, t.accountMapJson)`, which requires
`tenantRegistry.js` to also return each tenant's `accountMapPath` (mirrors the already-existing
`templatesPath` it returns today).

## 9. Path-prefix deployment fix

`APP_BASE_URL` may include a path component (this deployment:
`https://cash.lens.io.vn/actual-transfer-hub`). `src/server.js`'s session-cookie registration
currently hardcodes `path: "/admin"`; it must become the deployment's own base path plus
`/admin`:

```js
const basePath = new URL(adminUiConfig.appBaseUrl).pathname.replace(/\/$/, ""); // "" for root
cookie: { ..., path: `${basePath}/admin` }
```

For `https://cash.lens.io.vn/actual-transfer-hub` this evaluates to `/actual-transfer-hub/admin`;
for a root deployment (`https://actualtap.example.com`) it evaluates to `/admin` — unchanged
behavior for every existing root-domain deployment.

**Recommended reverse-proxy pattern** (to be documented in the README): strip the prefix before
forwarding, so the app itself continues to see requests as `/admin/*` and no route registration
needs to change:

```nginx
location /actual-transfer-hub/ {
  proxy_pass http://actualtap:3001/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

A reverse proxy that instead forwards the prefix through unchanged would require every `/admin/*`
route registration (`auth.js`, `staticAdmin.js`, `adminTemplates.js`, `adminAccountMap.js`,
`adminRegister.js`) to be threaded through a configurable base path — explicitly out of scope
this pass (see §11).

## 10. Testing plan

- **`tenantProvisioning.js`**: duplicate `keycloakSub` rejected (`409`, no side effect); bad
  Actual credentials rejected (`422`, no file written, no live-map entry, the worker's child
  process is not left running); success path — `tenants.json`/`account-map.json`/`templates.json`
  are all written correctly, live maps are updated, the returned `apiKey` resolves via
  `resolveTenant` immediately.
- **`tenantWorkerPool.js`**: `spawnOne` unit tests (ready / failure / exit-before-ready);
  `spawnAll` regression (existing tests unchanged); a new test proving a `spawnOne` failure never
  touches another tenant's already-running worker.
- **Full-chain integration** (extends `test/admin-full-chain-integration.test.js`): fake Keycloak
  login for a `sub` with no tenant → hits `/admin/` → gets the registration view, not a `403` →
  `POST /admin/api/register` against a mock Actual connection → asserts the returned `apiKey`
  works immediately against `/vietqr-transaction`, in the same running test-server instance, no
  restart.
- **`accountMapStore` / `adminAccountMap.js`**: mirrors the existing
  `templates-store.test.js` / `admin-templates.test.js` coverage.
- **Path-prefix cookie test**: an `APP_BASE_URL` with a path component produces a session cookie
  whose `Set-Cookie` `Path` attribute includes that prefix; a request to the prefixed path
  carrying that cookie is accepted as authenticated.

## 11. Out of scope (deferred)

- Self-service tenant deletion/deregistration through the UI.
- Lazy-spawn / idle-eviction worker lifecycle (still always-on once created).
- Rate-limiting or capping total tenant count.
- Reverse-proxy pass-through-without-stripping support (a configurable base path threaded through
  every route) — only the strip-prefix deployment pattern is supported this pass.
- Keycloak realm/client lifecycle management — already provisioned externally, consumed here as
  given (`KEYCLOAK_ISSUER_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`).
