# Multi-Tenant Actual Connections — Design

Status: draft, awaiting user review
Scope: foundational architecture change — one ActualTap deployment serving multiple users, each
with their own separate Actual Budget file ("financial plan"), each with their own bank-account
mapping and notification templates. This is a **prerequisite** to Sub-project B (admin UI +
Keycloak SSO, spec'd but not yet implemented) — B's per-user template/account-map isolation only
makes sense once this lands, since today's app can only ever talk to one Actual Budget file per
process.

## 1. Context

Every existing route (`/transaction`, `/vietqr-transaction`, and Sub-project B's planned admin
API) assumes exactly one Actual Budget connection for the whole process, configured once at
startup via `ACTUAL_URL`/`ACTUAL_SYNC_ID`/`ACTUAL_PASSWORD`/`ACTUAL_ENCRYPTION_PASSWORD` and a
single global `ACCOUNT_MAP` + `config/templates.json`.

Verified directly against the installed `@actual-app/api@26.9.0` package (`dist/index.js`): the
client is a **module-level singleton**, not an instance you can construct per connection —
`var internal = null;`, and `init()` overwrites it. Switching budgets
(`downloadBudget`/`loadBudget`) explicitly closes whichever budget was previously open before
loading the new one. **One Node process can have at most one Actual budget open at a time.**
This rules out "just hold multiple connection objects in one process" as an approach — true
multi-tenancy needs one OS process per tenant, each running its own `@actual-app/api` instance.

## 2. Goals / Non-goals

**Goals:**
- One ActualTap deployment serves N tenants simultaneously, each with their own Actual Budget
  file (same Actual server, different `ACTUAL_SYNC_ID`/password/encryption password per tenant).
- Each tenant has their own bank-account mapping and notification templates, fully isolated from
  other tenants.
- Each tenant is identified on the data-plane (`/transaction`, `/vietqr-transaction`) by their own
  API key — no OIDC/browser flow needed there, since Shortcuts/Tasker can't do redirect-based
  login.
- Tenants are provisioned by the operator hand-editing a config file and restarting — no
  self-service tenant creation.
- All tenant workers are spawned eagerly at startup (small expected scale — a handful of tenants,
  e.g. a family/small group); no idle-eviction or lazy-spawn complexity.
- One tenant's Actual connection failing at startup stops the whole server (fail-fast, matching
  today's `actualConnector` behavior) — no partial-outage "skip the broken tenant" mode.

**Non-goals:**
- No self-service tenant signup/provisioning UI.
- No per-tenant `ACTUAL_URL` (all tenants share one Actual server in this design).
- No idle worker eviction / dynamic scaling — every tenant's worker runs for the lifetime of the
  parent process.
- No changes to Sub-project A's matching/extraction semantics, or Sub-project B's CRUD/preview
  API shape — both are reused as-is, only re-keyed by tenant (§6).

## 3. File structure

```
config/tenants.json                            // NEW — tenant registry
config/tenants/<id>/account-map.json           // NEW — per tenant
config/tenants/<id>/templates.json             // NEW — per tenant
src/worker/tenantWorker.js                      // NEW — child process entrypoint
src/worker/tenantWorkerPool.js                  // NEW — parent-side spawn/IPC/routing
src/lib/actualConnectorInit.js                  // NEW — plain function extracted from the
                                                 //   deleted actualConnector.js (§5)
src/plugins/actualConnector.js                  // DELETE — superseded by tenantWorkerPool
src/plugins/env.js                              // MODIFY — remove ACCOUNT_MAP, ACTUAL_SYNC_ID,
                                                 //   ACTUAL_PASSWORD, ACTUAL_ENCRYPTION_PASSWORD,
                                                 //   API_KEY, TEMPLATES_CONFIG_PATH (all now
                                                 //   per-tenant); keep ACTUAL_URL; add
                                                 //   TENANTS_CONFIG_PATH (optional, default
                                                 //   config/tenants.json)
src/server.js                                    // MODIFY — load tenants.json, spawnAll workers,
                                                 //   build per-tenant auth/store maps, register
                                                 //   routes after all workers report ready
src/routes/transaction.js                        // MODIFY — resolve request.tenant, build the
                                                 //   fastifyLike shim (§5), no other logic change
src/routes/vietqrTransaction.js                  // MODIFY — same as above, plus per-tenant
                                                 //   templatesStore lookup
src/lib/actualAccounts.js                        // UNCHANGED
src/lib/actualTransactions.js                    // UNCHANGED
src/templates/* (Sub-project A engine)           // UNCHANGED — only the store becomes per-tenant
```

## 4. Tenant registry + per-tenant config layout

```
config/tenants.json                            // NEW — registry, operator-edited + restart
config/tenants/<tenant-id>/account-map.json    // NEW — replaces the global ACCOUNT_MAP env var
config/tenants/<tenant-id>/templates.json      // NEW — replaces the global config/templates.json
```

```jsonc
// config/tenants.json
[
  {
    "id": "alice",
    "actualSyncId": "8B51B58D-3A0D-4B5B-A41F-DE574306A4F2",
    "actualPassword": "...",
    "actualEncryptionPassword": "",   // optional, same semantics as today's ACTUAL_ENCRYPTION_PASSWORD
    "apiKey": "527D6AAA-...",         // used by /transaction, /vietqr-transaction
    "keycloakSub": "keycloak-user-id-for-alice"  // used by Sub-project B to map a logged-in
                                                   //   Keycloak user to their own tenant
  }
]
```

`ACTUAL_URL` stays a single global env var (one shared Actual server). `config/tenants/<id>/account-map.json`
has the exact same shape `ACCOUNT_MAP`'s JSON value had (`{"<bank account number>": "<Actual account name>"}`);
`config/tenants/<id>/templates.json` has the exact same shape Sub-project A's `config/templates.json`
had (an array of templates, validated by the same `validateTemplates`).

Config validation at startup: every tenant's `account-map.json` (JSON object) and `templates.json`
(via `validateTemplates`) must parse and validate, `apiKey` and `id` must be non-empty and unique
across the array, or the server fails to start naming the problem — same fail-fast posture as
`ACCOUNT_MAP`'s JSON-shape check today.

## 5. Worker process + IPC

Each tenant runs in its own child process (`child_process.fork()`), each with its own
`@actual-app/api` connection. There is no more single-connection "global `fastify.actual`" mode —
every deployment, including a single-tenant one, goes through `config/tenants.json` (§7). The
existing `src/plugins/actualConnector.js` Fastify plugin is **deleted**; its initialization logic
(URL validation, connectivity check, `init`, auth verification, budget-exists check, download
with retry, open-verification) is extracted verbatim into a plain reusable function that
`tenantWorker.js` is the sole caller of — no behavior change to the initialization sequence
itself, only *where* it runs (inside each tenant's own child process instead of the main
process) and that it's invoked as a plain function instead of a Fastify plugin hook.

```
src/worker/tenantWorker.js       // NEW — child process entrypoint
  - Receives { actualUrl, syncId, password, encryptionPassword } from the parent at startup
  - Runs the extracted actualConnector init logic
  - On success: process.send({ ready: true }); on failure: process.send({ ready: false, error }); exit
  - Listens for { requestId, method, args } messages; method ∈
    {"getAccounts", "getPayees", "addTransactions", "sync", "actualInternalSend"}
  - Replies { requestId, result } or { requestId, error }

src/worker/tenantWorkerPool.js   // NEW — parent-side
  spawnAll(tenants) => Promise<Map<tenantId, WorkerClient>>
    // forks one child per tenant, waits for every { ready: true }; if any tenant reports
    // { ready: false } or its process exits before reporting ready, kills every other
    // already-spawned worker and rejects — the whole server fails to start (§2's fail-fast goal)
  WorkerClient = {
    getAccounts(): Promise<Account[]>
    getPayees(): Promise<Payee[]>
    addTransactions(accountId, transactions): Promise<"ok"|{errors}>
    sync(): Promise<void>
    actualInternalSend(method, params): Promise<unknown>
  }
  // each method: posts an IPC message with a fresh requestId, resolves/rejects the returned
  // Promise when a reply with the matching requestId arrives (a Map<requestId, {resolve,reject}>
  // tracks in-flight calls per worker)
```

## 6. Routing, auth, and integration with Sub-projects A/B

**Auth middleware** (`src/server.js`) changes from comparing one global `X-API-KEY` to a
per-tenant lookup:
```js
const tenant = tenantsByApiKey.get(request.headers["x-api-key"]);
if (!tenant) return reply.code(401).send({ error: "Unauthorized" });
request.tenant = tenant; // { id, workerClient, templatesStore, accountMap }
```

**Key design decision — keep the change surface small.** `identify()`/`extract()` (Sub-project A)
and `resolveAccountName()` are pure JS logic with no Actual I/O — they keep running in the
**parent** process, just re-keyed: a `Map<tenantId, templatesStore>` and
`Map<tenantId, accountMap>` replace the single global instances Sub-project A/B's specs assumed.
Sub-project B's hot-reload mechanism (`replaceAll()`) is unchanged in shape — only its identity
becomes per-tenant.

Only the actual Actual-Budget I/O (`getAccountByName`, `addTransaction`, `syncBudget`,
`savePayeeLocation`) needs to reach a worker. The route builds a small shim object matching the
shape `src/lib/actualAccounts.js`/`src/lib/actualTransactions.js` already expect from `fastify`:
```js
const fastifyLike = {
  actual: request.tenant.workerClient,                              // getAccounts/getPayees/addTransactions/sync
  actualInternal: { send: request.tenant.workerClient.actualInternalSend },
  log: fastify.log,
};
await getAccountByName(fastifyLike, accountName);
```
**`src/lib/actualAccounts.js`, `src/lib/actualTransactions.js`, and the `savePayeeLocation` helper
in `src/routes/transaction.js` require zero changes** — only the two route files (`transaction.js`,
`vietqrTransaction.js`) change how they obtain the object they pass into those functions.

**Sub-project B integration:** each Keycloak-authenticated admin user (matched via `keycloakSub`
in `config/tenants.json`) only ever sees/edits `request.tenant`'s own `templatesStore` and
`accountMap` — no other change to B's CRUD/preview design.

## 7. Migration (breaking change from Sub-project A)

- `ACCOUNT_MAP` and `TEMPLATES_CONFIG_PATH` env vars are removed, replaced by
  `config/tenants.json` + per-tenant `account-map.json`/`templates.json`.
- The global `API_KEY` env var is removed; each tenant's `apiKey` field in `tenants.json` takes
  its place.
- **Migration path for an existing single-tenant deployment:** create one entry in
  `config/tenants.json` reusing the existing `ACTUAL_SYNC_ID`/`ACTUAL_PASSWORD`/
  `ACTUAL_ENCRYPTION_PASSWORD`/`API_KEY` values; move the existing `ACCOUNT_MAP` JSON value into
  that tenant's `account-map.json`; move the existing `config/templates.json` into that tenant's
  `templates.json` unchanged.

## 8. Testing plan

- **Worker init logic**: reuse `actualConnector`'s existing test coverage against the extracted
  plain function (unchanged behavior, just called directly instead of as a Fastify plugin).
- **`tenantWorkerPool`**: round-trip IPC test — spawn a worker with a scripted fixed reply, call
  through `WorkerClient`, assert the right `requestId` resolves; one tenant reporting
  `{ ready: false }` → `spawnAll` rejects and every other already-spawned worker in that batch is
  killed (no leaked child processes).
- **Routing/auth**: valid API key → correct `request.tenant`; unknown/missing key → `401`; two
  tenants' requests interleaved (e.g. via `Promise.all`) each see only their own
  `templatesStore`/`workerClient` — the core isolation guarantee this spec exists to provide.
- **End-to-end**: two tenants (two mock workers), `POST /vietqr-transaction` against both,
  confirm tenant A's transaction never reaches tenant B's mock `addTransactions` call and
  vice versa.

## 9. Out of scope (future)

- Idle worker eviction / dynamic tenant scaling beyond a handful of tenants.
- Self-service tenant provisioning (UI or API) — still config-file + restart only.
- Per-tenant `ACTUAL_URL` (different Actual servers per tenant).
