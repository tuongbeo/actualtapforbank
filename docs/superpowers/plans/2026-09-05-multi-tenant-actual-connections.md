# Multi-Tenant Actual Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one ActualTap deployment serve multiple tenants, each with their own Actual Budget file, bank-account mapping, and notification templates — replacing the single global Actual connection with one child process per tenant.

**Architecture:** A tenant registry (`config/tenants.json` + per-tenant `account-map.json`/`templates.json`) is loaded at startup; a worker pool forks one child process per tenant, each running the existing Actual-connector initialization logic against its own budget; the parent process routes each incoming request to its tenant (via a per-tenant API key) and forwards Actual I/O to that tenant's worker over IPC, while template matching/extraction and account-name resolution stay in the parent (pure JS, no Actual I/O).

**Tech Stack:** Node.js, Fastify 5, `@actual-app/api`, Node's built-in `child_process`, `node:test` + `assert` (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-05-multi-tenant-actual-connections-design.md`

## Global Constraints

- One Node process can hold at most one Actual budget open at a time (`@actual-app/api` is a module-level singleton) — this is why each tenant needs its own child process, not just its own JS object.
- `config/tenants.json` is a JSON array; each entry needs `id`, `apiKey`, `actualSyncId`, `actualPassword` (all required, non-empty strings) and optionally `actualEncryptionPassword`, `keycloakSub`. `id` and `apiKey` must be unique across the array.
- Per-tenant files live at `config/tenants/<id>/account-map.json` and `config/tenants/<id>/templates.json`, resolved relative to wherever `tenants.json` itself lives. Both are optional per tenant — a missing `account-map.json` behaves like `{}`, a missing `templates.json` behaves like `[]` (same soft-defaults as the env vars they replace).
- `ACTUAL_URL` stays a single global env var (one shared Actual server for all tenants). `ACCOUNT_MAP`, `ACTUAL_SYNC_ID`, `ACTUAL_PASSWORD`, `ACTUAL_ENCRYPTION_PASSWORD`, `API_KEY`, `TEMPLATES_CONFIG_PATH` are all removed from `src/plugins/env.js` — replaced by `TENANTS_CONFIG_PATH` (optional, default `config/tenants.json`).
- One tenant's Actual connection failing at startup must stop the whole server (fail-fast) — every other already-spawned tenant worker must be killed, not left running.
- `src/lib/actualAccounts.js` and `src/lib/actualTransactions.js` are NOT modified — every route builds a `fastifyLike` shim object (`{ actual, actualInternal, log }`) matching what those two files already expect, so they keep working unchanged against a tenant's `WorkerClient` instead of a real Fastify instance.
- The dedup cache key in `/vietqr-transaction` must include the tenant id — two different tenants' transactions with the same bank reference code and the same template name must never collide (this is a real correctness gap found while planning, not called out explicitly in the spec's re-keying description — see Task 8).
- `package.json`'s `test` script is `node --test test/*.test.js` — a non-recursive glob. Every new test file goes flat in `test/`; fixtures may live in subdirectories (`test/fixtures/...`).
- Tests that need a real Actual server (already the case for `test/initialization.test.js` and `test/transaction.test.js` before this plan) keep that same requirement — they are not expected to pass in a bare sandbox without real `ACTUAL_URL`/credentials, only on a VM/CI where those are configured. Don't block any task on them; every other test file must pass in this sandbox.

---

## File Structure

```
src/lib/actualConnectorInit.js    // NEW — connectToActual(), extracted from actualConnector.js
src/plugins/actualConnector.js    // MODIFY (Task 1) then DELETE (Task 10)
src/worker/workerProtocol.js      // NEW — createMessageHandler() (pure IPC message dispatch)
src/worker/tenantWorker.js        // NEW — child process entrypoint
src/worker/tenantWorkerPool.js    // NEW — spawnAll() / WorkerClient
src/lib/tenantRegistry.js         // NEW — loadTenants()
src/lib/tenantAuth.js             // NEW — buildTenantLookup() / resolveTenant()
src/plugins/env.js                // MODIFY — remove per-tenant env vars, add TENANTS_CONFIG_PATH
src/routes/transaction.js         // MODIFY — build fastifyLike from request.tenant
src/routes/vietqrTransaction.js   // MODIFY — same, plus per-tenant templates/accountMap, tenant-scoped dedup key
src/server.js                     // MODIFY — wire tenant registry + worker pool + per-tenant auth
README.md                         // MODIFY — migration section (Task 11)

test/initialization.test.js       // MODIFY (Task 1) — test connectToActual directly
test/worker-protocol.test.js      // NEW
test/tenant-worker.test.js        // NEW (real-Actual-server test, same caveat as existing ones)
test/fixtures/fakeTenantWorker.js // NEW — scripted worker for sandbox-testable pool tests
test/tenant-worker-pool.test.js   // NEW
test/tenant-registry.test.js      // NEW
test/tenant-auth.test.js          // NEW — routing/auth unit tests (spec §8)
test/fixtures/tenants/valid/tenants.json                       // NEW
test/fixtures/tenants/valid/tenants/alice/account-map.json      // NEW
test/fixtures/tenants/valid/tenants/alice/templates.json        // NEW
test/fixtures/tenants/invalid/tenants.json                      // NEW
test/sync-failure.test.js         // MODIFY — mock request.tenant instead of decorating fastify.actual
test/vietqr-transaction.test.js   // MODIFY — same, plus a cross-tenant dedup isolation test
test/helpers.js                   // MODIFY (Task 10) — build the multi-tenant server for real-Actual tests
test/transaction.test.js          // MODIFY (Task 10) — adapt to helpers.js's new buildServer()
```

---

### Task 1: Extract `connectToActual` from `actualConnector.js`

**Files:**
- Create: `src/lib/actualConnectorInit.js`
- Modify: `src/plugins/actualConnector.js` (become a thin wrapper)
- Modify: `test/initialization.test.js`

**Interfaces:**
- Produces: `connectToActual({ actualUrl, password, syncId, encryptionPassword, logger }) => Promise<{ actualInternal }>` — throws the same errors (same messages) the current inline `actualConnector.js` logic throws.

- [ ] **Step 1: Create `src/lib/actualConnectorInit.js` with the extracted logic**

```js
const actual = require("@actual-app/api");
const os = require("os");
const path = require("path");
const fs = require("fs");

const validateUrl = (url) => {
  if (!url || typeof url !== "string") {
    throw new Error("ACTUAL_URL is not a valid string");
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("ACTUAL_URL must use http:// or https:// protocol");
    }
    return url.replace(/\/+$/, "");
  } catch (err) {
    throw new Error(`Invalid ACTUAL_URL format: ${err.message}`);
  }
};

const verifyConnectivity = async (url) => {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (response.status < 200 || response.status >= 400) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new Error("Connection timed out - check if server is accessible");
    }
    if (err.cause?.code === "ENOTFOUND") {
      throw new Error("Cannot resolve hostname - check if ACTUAL_URL is correct");
    }
    if (err.cause?.code === "ECONNREFUSED") {
      throw new Error("Connection refused - check if server is running");
    }
    throw new Error(`Network error: ${err.message}`);
  }
};

const initializeActual = async (serverURL, password, timeoutMs) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "actualtap-"));

  try {
    return await Promise.race([
      actual.init({ dataDir, serverURL, password }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs)),
    ]);
  } catch (err) {
    if (err.message === "TIMEOUT") {
      throw new Error(`Initialization timed out after ${timeoutMs / 1000} seconds`);
    }
    throw new Error(`Failed to initialize Actual API: ${err.message}`);
  }
};

const verifyAuthentication = async () => {
  try {
    const budgets = await actual.getBudgets();
    if (!budgets || budgets.length === 0) {
      throw new Error("ACTUAL_PASSWORD is incorrect (no budgets found)");
    }
    return budgets;
  } catch (err) {
    throw new Error(`Authentication failed: ${err.message}`);
  }
};

const verifyBudgetExists = (budgets, syncId) => {
  const budget = budgets.find((b) => b.groupId === syncId);
  if (!budget) {
    const availableIds = budgets.map((b) => b.groupId).join(", ");
    throw new Error(`Budget '${syncId}' not found. Available: ${availableIds}`);
  }
  return budget;
};

const downloadBudget = async (syncId, encryptionPassword, logger, maxRetries, retryDelay) => {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`Downloading budget (attempt ${attempt}/${maxRetries})`);

      if (encryptionPassword) {
        await actual.downloadBudget(syncId, { password: encryptionPassword });
      } else {
        await actual.downloadBudget(syncId);
      }

      return;
    } catch (err) {
      lastError = err;

      if (err.message?.includes("decrypt") || err.message?.includes("encryption")) {
        throw new Error(`ACTUAL_ENCRYPTION_PASSWORD is incorrect: ${err.message}`);
      }

      logger.warn(`Budget download attempt ${attempt}/${maxRetries} failed: ${err.message || err.reason || err}`);

      if (attempt < maxRetries) {
        logger.info(`Retrying in ${retryDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  throw new Error(
    `Failed to download budget after ${maxRetries} attempts: ${lastError.message || lastError.reason || lastError}`
  );
};

const verifyBudgetOpen = async () => {
  try {
    await actual.getAccounts();
  } catch (err) {
    if (err.message?.includes("No budget file is open")) {
      throw new Error(
        "Budget failed to open. This is likely due to a version mismatch between ActualTap and your Actual Budget server. " +
          "Please ensure ActualTap is updated to match your Actual Budget server version."
      );
    }
    throw new Error(`Failed to verify budget: ${err.message}`);
  }
};

const connectToActual = async ({ actualUrl, password, syncId, encryptionPassword, logger }) => {
  const TIMEOUT = 30000;
  const RETRY_COUNT = 3;
  const RETRY_DELAY = 2000;

  logger.info("Initializing Actual connector");

  const url = validateUrl(actualUrl);
  logger.info(`Connecting to: ${url}`);

  await verifyConnectivity(url);
  logger.info("Server is reachable");

  const actualInternal = await initializeActual(url, password, TIMEOUT);
  logger.info("Actual API initialized");

  const budgets = await verifyAuthentication();
  logger.info(`Authenticated - found ${budgets.length} budget(s)`);

  const budget = verifyBudgetExists(budgets, syncId);
  logger.info(`Budget found: ${budget.name || budget.groupId}`);

  await downloadBudget(syncId, encryptionPassword, logger, RETRY_COUNT, RETRY_DELAY);

  await verifyBudgetOpen();
  logger.info("Budget downloaded and verified successfully");

  return { actualInternal };
};

module.exports = { connectToActual };
```

- [ ] **Step 2: Replace `src/plugins/actualConnector.js` with a thin wrapper**

```js
const actual = require("@actual-app/api");
const fp = require("fastify-plugin");
const { connectToActual } = require("../lib/actualConnectorInit");

const actualConnector = fp(async (fastify) => {
  const { ACTUAL_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID, ACTUAL_ENCRYPTION_PASSWORD } = fastify.config;

  const { actualInternal } = await connectToActual({
    actualUrl: ACTUAL_URL,
    password: ACTUAL_PASSWORD,
    syncId: ACTUAL_SYNC_ID,
    encryptionPassword: ACTUAL_ENCRYPTION_PASSWORD,
    logger: fastify.log,
  });

  fastify.decorate("actual", actual);
  fastify.decorate("actualInternal", actualInternal);

  fastify.addHook("onClose", async () => {
    try {
      await actual.shutdown();
      fastify.log.info("Actual API shut down");
    } catch (err) {
      fastify.log.error(`Cleanup error: ${err.message}`);
    }
  });
});

module.exports = actualConnector;
```

- [ ] **Step 3: Rewrite `test/initialization.test.js` to call `connectToActual` directly**

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const actual = require("@actual-app/api");
const { connectToActual } = require("../src/lib/actualConnectorInit");

const logger = { info: () => {}, warn: () => {}, error: () => {} };

async function connectWithOverrides(overrides) {
  try {
    await connectToActual({
      actualUrl: process.env.ACTUAL_URL,
      password: process.env.ACTUAL_PASSWORD,
      syncId: process.env.ACTUAL_SYNC_ID,
      encryptionPassword: process.env.ACTUAL_ENCRYPTION_PASSWORD,
      logger,
      ...overrides,
    });
  } finally {
    try { await actual.shutdown(); } catch {}
  }
}

describe("Initialization failures", () => {
  it("should fail with invalid ACTUAL_URL", async () => {
    await assert.rejects(
      () => connectWithOverrides({ actualUrl: "not-a-valid-url" }),
      (err) => {
        assert.ok(
          err.message.includes("Invalid ACTUAL_URL") || err.message.includes("URL"),
          `Expected URL error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("should fail with wrong ACTUAL_PASSWORD", async () => {
    await assert.rejects(
      () => connectWithOverrides({ password: "definitely-wrong-password-12345" }),
      (err) => {
        assert.ok(
          err.message.includes("password") ||
            err.message.includes("Authentication") ||
            err.message.includes("auth"),
          `Expected auth error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("should fail with invalid ACTUAL_SYNC_ID", async () => {
    await assert.rejects(
      () => connectWithOverrides({ syncId: "00000000-0000-0000-0000-000000000000" }),
      (err) => {
        assert.ok(
          err.message.includes("not found") ||
          err.message.includes("Budget") ||
          err.message.toLowerCase().includes("budget"),
          `Expected budget-related error, got: ${err.message}`
        );
        return true;
      }
    );
  });
});
```

- [ ] **Step 4: Run the test (requires real `ACTUAL_URL`/`ACTUAL_PASSWORD`/`ACTUAL_SYNC_ID` env vars — same requirement this file already had; do not block this task on it in a bare sandbox)**

Run: `node --test test/initialization.test.js`
Expected: PASS on a machine with real Actual credentials configured; this file's behavior is otherwise unchanged from before this task.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actualConnectorInit.js src/plugins/actualConnector.js test/initialization.test.js
git commit -m "Extract connectToActual from the actualConnector Fastify plugin"
```

---

### Task 2: Worker IPC message dispatch (`src/worker/workerProtocol.js`)

**Files:**
- Create: `src/worker/workerProtocol.js`
- Test: `test/worker-protocol.test.js`

**Interfaces:**
- Produces: `createMessageHandler(actualClient) => (message: {requestId, method, args}) => Promise<{requestId, result} | {requestId, error: {message}}>` where `actualClient` exposes `getAccounts()`, `getPayees()`, `addTransactions(accountId, transactions)`, `sync()`, `actualInternalSend(method, params)`.

- [ ] **Step 1: Write the failing tests**

Create `test/worker-protocol.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createMessageHandler } = require("../src/worker/workerProtocol");

const fakeActualClient = (overrides = {}) => ({
  getAccounts: async () => [{ id: "acc-1", name: "Checking" }],
  getPayees: async () => [{ id: "payee-1", name: "Test" }],
  addTransactions: async (accountId, transactions) => "ok",
  sync: async () => {},
  actualInternalSend: async (method, params) => ({ method, params }),
  ...overrides,
});

describe("createMessageHandler", () => {
  it("routes getAccounts and returns the result with the matching requestId", async () => {
    const handle = createMessageHandler(fakeActualClient());
    const reply = await handle({ requestId: "r1", method: "getAccounts", args: [] });
    assert.deepStrictEqual(reply, { requestId: "r1", result: [{ id: "acc-1", name: "Checking" }] });
  });

  it("routes addTransactions with its args in order", async () => {
    const received = [];
    const client = fakeActualClient({
      addTransactions: async (accountId, transactions) => {
        received.push(accountId, transactions);
        return "ok";
      },
    });
    const handle = createMessageHandler(client);
    const reply = await handle({ requestId: "r2", method: "addTransactions", args: ["acc-1", [{ id: "t1" }]] });
    assert.deepStrictEqual(reply, { requestId: "r2", result: "ok" });
    assert.deepStrictEqual(received, ["acc-1", [{ id: "t1" }]]);
  });

  it("routes actualInternalSend with its args in order", async () => {
    const handle = createMessageHandler(fakeActualClient());
    const reply = await handle({ requestId: "r3", method: "actualInternalSend", args: ["api/payees-get-nearby", { latitude: 1 }] });
    assert.deepStrictEqual(reply, { requestId: "r3", result: { method: "api/payees-get-nearby", params: { latitude: 1 } } });
  });

  it("returns an error reply (not a throw) for an unknown method", async () => {
    const handle = createMessageHandler(fakeActualClient());
    const reply = await handle({ requestId: "r4", method: "notAMethod", args: [] });
    assert.strictEqual(reply.requestId, "r4");
    assert.ok(reply.error.message.includes("notAMethod"));
  });

  it("returns an error reply (not a throw) when the underlying client rejects", async () => {
    const client = fakeActualClient({ sync: async () => { throw new Error("boom"); } });
    const handle = createMessageHandler(client);
    const reply = await handle({ requestId: "r5", method: "sync", args: [] });
    assert.deepStrictEqual(reply, { requestId: "r5", error: { message: "boom" } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/worker-protocol.test.js`
Expected: FAIL — `Cannot find module '../src/worker/workerProtocol'`

- [ ] **Step 3: Implement**

Create `src/worker/workerProtocol.js`:

```js
const METHODS = {
  getAccounts: (client) => client.getAccounts(),
  getPayees: (client) => client.getPayees(),
  addTransactions: (client, args) => client.addTransactions(...args),
  sync: (client) => client.sync(),
  actualInternalSend: (client, args) => client.actualInternalSend(...args),
};

const createMessageHandler = (actualClient) => async (message) => {
  const { requestId, method, args = [] } = message;
  const handler = METHODS[method];

  if (!handler) {
    return { requestId, error: { message: `Unknown method "${method}"` } };
  }

  try {
    const result = await handler(actualClient, args);
    return { requestId, result };
  } catch (err) {
    return { requestId, error: { message: err.message } };
  }
};

module.exports = { createMessageHandler };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/worker-protocol.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/worker/workerProtocol.js test/worker-protocol.test.js
git commit -m "Add worker IPC message dispatch (createMessageHandler)"
```

---

### Task 3: Child process entrypoint (`src/worker/tenantWorker.js`)

**Files:**
- Create: `src/worker/tenantWorker.js`
- Test: `test/tenant-worker.test.js`

**Interfaces:**
- Consumes: `connectToActual` (Task 1, `../lib/actualConnectorInit`), `createMessageHandler` (Task 2, `./workerProtocol`)
- Produces: a script runnable via `child_process.fork()`. On `process.send`'d config `{ actualUrl, password, syncId, encryptionPassword }`, it connects to Actual, then replies `{ ready: true }` on success or `{ ready: false, error }` (then exits with a non-zero code) on failure. After a successful `{ ready: true }`, it handles `{ requestId, method, args }` messages via `createMessageHandler` and replies with what that returns.

- [ ] **Step 1: Implement**

Create `src/worker/tenantWorker.js`:

```js
const actual = require("@actual-app/api");
const { connectToActual } = require("../lib/actualConnectorInit");
const { createMessageHandler } = require("./workerProtocol");

const logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

process.once("message", async (config) => {
  const { actualUrl, password, syncId, encryptionPassword } = config;

  let actualInternal;
  try {
    ({ actualInternal } = await connectToActual({ actualUrl, password, syncId, encryptionPassword, logger }));
  } catch (err) {
    process.send({ ready: false, error: err.message });
    process.exit(1);
    return;
  }

  const actualClient = {
    getAccounts: () => actual.getAccounts(),
    getPayees: () => actual.getPayees(),
    addTransactions: (accountId, transactions) => actual.addTransactions(accountId, transactions),
    sync: () => actual.sync(),
    actualInternalSend: (method, params) => actualInternal.send(method, params),
  };
  const handleMessage = createMessageHandler(actualClient);

  process.send({ ready: true });

  process.on("message", async (message) => {
    const reply = await handleMessage(message);
    process.send(reply);
  });
});
```

- [ ] **Step 2: Write the real-fork integration test**

Create `test/tenant-worker.test.js` (requires real `ACTUAL_URL`/`ACTUAL_PASSWORD`/`ACTUAL_SYNC_ID` env vars, same requirement as `test/initialization.test.js` — do not block this task on it in a bare sandbox):

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fork } = require("node:child_process");

const WORKER_PATH = path.join(__dirname, "../src/worker/tenantWorker.js");

function withWorker(config, run) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_PATH);
    let readyReceived = false;

    child.once("message", async (msg) => {
      if (!msg.ready) {
        child.kill();
        reject(new Error(`Worker failed to become ready: ${msg.error}`));
        return;
      }
      readyReceived = true;
      try {
        await run(child);
        child.kill();
        resolve();
      } catch (err) {
        child.kill();
        reject(err);
      }
    });

    child.once("exit", (code) => {
      if (!readyReceived && code !== 0) {
        reject(new Error(`Worker exited before becoming ready (code ${code})`));
      }
    });

    child.send(config);
  });
}

describe("tenantWorker (requires a real Actual server)", () => {
  it("becomes ready and answers a getAccounts round trip", async () => {
    await withWorker(
      {
        actualUrl: process.env.ACTUAL_URL,
        password: process.env.ACTUAL_PASSWORD,
        syncId: process.env.ACTUAL_SYNC_ID,
        encryptionPassword: process.env.ACTUAL_ENCRYPTION_PASSWORD,
      },
      (child) =>
        new Promise((resolve, reject) => {
          child.once("message", (reply) => {
            if (reply.error) {
              reject(new Error(reply.error.message));
              return;
            }
            assert.strictEqual(reply.requestId, "test-1");
            assert.ok(Array.isArray(reply.result));
            resolve();
          });
          child.send({ requestId: "test-1", method: "getAccounts", args: [] });
        })
    );
  });
});
```

- [ ] **Step 3: Run the test (on a machine with real Actual credentials)**

Run: `node --test test/tenant-worker.test.js`
Expected: PASS on a machine with real Actual credentials configured.

- [ ] **Step 4: Commit**

```bash
git add src/worker/tenantWorker.js test/tenant-worker.test.js
git commit -m "Add tenantWorker child-process entrypoint"
```

---

### Task 4: Worker pool (`src/worker/tenantWorkerPool.js`)

**Files:**
- Create: `src/worker/tenantWorkerPool.js`
- Create: `test/fixtures/fakeTenantWorker.js`
- Test: `test/tenant-worker-pool.test.js`

**Interfaces:**
- Produces: `spawnAll(tenants: Array<{id, actualUrl, actualPassword, actualSyncId, actualEncryptionPassword}>, workerPath?: string) => Promise<{ clients: Map<string, WorkerClient>, killAll: () => void }>` where `WorkerClient = { getAccounts(), getPayees(), addTransactions(accountId, transactions), sync(), actualInternalSend(method, params) }`. Rejects (and kills every already-spawned child in the same batch) if any tenant reports `{ ready: false }` or its process exits before reporting ready.

- [ ] **Step 1: Create the fake worker fixture**

Create `test/fixtures/fakeTenantWorker.js` (mimics the real protocol without touching Actual, for sandbox-only pool tests):

```js
process.once("message", (config) => {
  if (config.failInit) {
    process.send({ ready: false, error: "simulated init failure" });
    process.exit(1);
    return;
  }

  process.send({ ready: true });

  process.on("message", (msg) => {
    if (msg.method === "getAccounts") {
      process.send({ requestId: msg.requestId, result: [{ id: `acc-${config.tenantId}`, name: "Fake" }] });
    } else if (msg.method === "boom") {
      process.send({ requestId: msg.requestId, error: { message: "simulated failure" } });
    } else {
      process.send({ requestId: msg.requestId, result: null });
    }
  });
});
```

- [ ] **Step 2: Write the failing tests**

Create `test/tenant-worker-pool.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnAll } = require("../src/worker/tenantWorkerPool");

const FAKE_WORKER_PATH = path.join(__dirname, "fixtures/fakeTenantWorker.js");

describe("spawnAll", () => {
  it("resolves an empty clients map for an empty tenant list", async () => {
    const { clients, killAll } = await spawnAll([], FAKE_WORKER_PATH);
    assert.strictEqual(clients.size, 0);
    killAll();
  });

  it("spawns one worker per tenant and returns a working client for each", async () => {
    const { clients, killAll } = await spawnAll(
      [
        { id: "alice", tenantId: "alice" },
        { id: "bob", tenantId: "bob" },
      ],
      FAKE_WORKER_PATH
    );

    assert.strictEqual(clients.size, 2);
    const aliceAccounts = await clients.get("alice").getAccounts();
    const bobAccounts = await clients.get("bob").getAccounts();
    assert.deepStrictEqual(aliceAccounts, [{ id: "acc-alice", name: "Fake" }]);
    assert.deepStrictEqual(bobAccounts, [{ id: "acc-bob", name: "Fake" }]);
    killAll();
  });

  it("rejects a method call when the worker replies with an error", async () => {
    const { clients, killAll } = await spawnAll([{ id: "alice", tenantId: "alice" }], FAKE_WORKER_PATH);
    await assert.rejects(() => clients.get("alice").actualInternalSend("boom", {}), /simulated failure/);
    killAll();
  });

  it("rejects spawnAll and kills every other worker when one tenant fails to init", async () => {
    await assert.rejects(
      () =>
        spawnAll(
          [
            { id: "alice", tenantId: "alice" },
            { id: "bob", tenantId: "bob", failInit: true },
          ],
          FAKE_WORKER_PATH
        ),
      /bob.*failed to initialize|failed to initialize.*bob/i
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/tenant-worker-pool.test.js`
Expected: FAIL — `Cannot find module '../src/worker/tenantWorkerPool'`

- [ ] **Step 4: Implement**

Create `src/worker/tenantWorkerPool.js`:

```js
const { fork } = require("node:child_process");
const path = require("node:path");

const DEFAULT_WORKER_PATH = path.join(__dirname, "tenantWorker.js");

const createWorkerClient = (child) => {
  const pending = new Map();
  let counter = 0;

  child.on("message", (msg) => {
    if (msg.requestId === undefined) return;
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  });

  const call = (method, args) =>
    new Promise((resolve, reject) => {
      const requestId = `${process.pid}-${++counter}-${Date.now()}`;
      pending.set(requestId, { resolve, reject });
      child.send({ requestId, method, args });
    });

  return {
    getAccounts: () => call("getAccounts", []),
    getPayees: () => call("getPayees", []),
    addTransactions: (accountId, transactions) => call("addTransactions", [accountId, transactions]),
    sync: () => call("sync", []),
    actualInternalSend: (method, params) => call("actualInternalSend", [method, params]),
  };
};

const spawnAll = (tenants, workerPath = DEFAULT_WORKER_PATH) => {
  return new Promise((resolve, reject) => {
    const children = [];
    const clients = new Map();
    let settled = false;
    let readyCount = 0;

    const killAll = () => children.forEach((child) => child.kill());

    if (tenants.length === 0) {
      resolve({ clients, killAll });
      return;
    }

    tenants.forEach((tenant) => {
      const child = fork(workerPath);
      children.push(child);

      child.once("message", (msg) => {
        if (settled) return;

        if (msg.ready) {
          clients.set(tenant.id, createWorkerClient(child));
          readyCount += 1;
          if (readyCount === tenants.length) {
            settled = true;
            resolve({ clients, killAll });
          }
        } else {
          settled = true;
          killAll();
          reject(new Error(`Tenant "${tenant.id}" failed to initialize: ${msg.error}`));
        }
      });

      child.once("exit", (code) => {
        if (settled || readyCount === tenants.length) return;
        if (code !== 0) {
          settled = true;
          killAll();
          reject(new Error(`Tenant "${tenant.id}" worker exited before becoming ready (code ${code})`));
        }
      });

      child.send(tenant);
    });
  });
};

module.exports = { spawnAll };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/tenant-worker-pool.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/worker/tenantWorkerPool.js test/fixtures/fakeTenantWorker.js test/tenant-worker-pool.test.js
git commit -m "Add tenant worker pool (spawnAll, WorkerClient)"
```

---

### Task 5: Tenant registry (`src/lib/tenantRegistry.js`)

**Files:**
- Create: `src/lib/tenantRegistry.js`
- Create: `test/fixtures/tenants/valid/tenants.json`
- Create: `test/fixtures/tenants/valid/tenants/alice/account-map.json`
- Create: `test/fixtures/tenants/valid/tenants/alice/templates.json`
- Create: `test/fixtures/tenants/invalid/tenants.json`
- Test: `test/tenant-registry.test.js`

**Interfaces:**
- Consumes: `validateTemplates` (`../templates/schema`, already merged)
- Produces: `loadTenants(tenantsConfigPath: string) => Array<{ id, actualSyncId, actualPassword, actualEncryptionPassword, apiKey, keycloakSub, accountMapJson, templates }>`. Throws one aggregated `Error` listing every problem found. `accountMapJson` stays a JSON **string** (not parsed) so `src/lib/accountResolver.js`'s existing `resolveAccountName(sourceAccountNumber, accountMapJson)` signature needs no change.

- [ ] **Step 1: Create the fixtures**

Create `test/fixtures/tenants/valid/tenants.json`:

```json
[
  {
    "id": "alice",
    "actualSyncId": "8B51B58D-3A0D-4B5B-A41F-DE574306A4F2",
    "actualPassword": "alice-password",
    "apiKey": "alice-api-key"
  }
]
```

Create `test/fixtures/tenants/valid/tenants/alice/account-map.json`:

```json
{ "8820966012": "BIDV Cash" }
```

Create `test/fixtures/tenants/valid/tenants/alice/templates.json`:

```json
[
  {
    "name": "test-template",
    "sourceType": "email",
    "direction": "expense",
    "match": { "contains": ["Foo"] },
    "fields": { "code": { "label": "Code:", "stopLabel": "$END$" } },
    "requiredFields": ["code"]
  }
]
```

Create `test/fixtures/tenants/invalid/tenants.json` (missing `apiKey` on the one entry, and a duplicate `id` case is exercised separately in the test file below):

```json
[
  {
    "id": "alice",
    "actualSyncId": "8B51B58D-3A0D-4B5B-A41F-DE574306A4F2",
    "actualPassword": "alice-password"
  }
]
```

- [ ] **Step 2: Write the failing tests**

Create `test/tenant-registry.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { loadTenants } = require("../src/lib/tenantRegistry");

const FIXTURE_VALID = path.join(__dirname, "fixtures/tenants/valid/tenants.json");
const FIXTURE_INVALID = path.join(__dirname, "fixtures/tenants/invalid/tenants.json");

describe("loadTenants", () => {
  it("loads a valid tenants.json with its per-tenant account-map and templates", () => {
    const tenants = loadTenants(FIXTURE_VALID);
    assert.strictEqual(tenants.length, 1);
    const [alice] = tenants;
    assert.strictEqual(alice.id, "alice");
    assert.strictEqual(alice.apiKey, "alice-api-key");
    assert.strictEqual(alice.actualSyncId, "8B51B58D-3A0D-4B5B-A41F-DE574306A4F2");
    assert.strictEqual(alice.actualEncryptionPassword, "");
    assert.strictEqual(alice.keycloakSub, null);
    assert.strictEqual(JSON.parse(alice.accountMapJson)["8820966012"], "BIDV Cash");
    assert.strictEqual(alice.templates.length, 1);
    assert.strictEqual(alice.templates[0].name, "test-template");
  });

  it("throws listing every problem when required fields are missing", () => {
    assert.throws(() => loadTenants(FIXTURE_INVALID), /"apiKey" is required/);
  });

  it("throws when the tenants file doesn't exist", () => {
    assert.throws(() => loadTenants(path.join(__dirname, "fixtures/tenants/does-not-exist.json")), /not found/);
  });

  it("throws when the array is empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-empty-"));
    const emptyPath = path.join(dir, "tenants.json");
    fs.writeFileSync(emptyPath, "[]");
    assert.throws(() => loadTenants(emptyPath), /non-empty array/);
  });

  it("throws on a duplicate tenant id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-dup-"));
    const dupPath = path.join(dir, "tenants.json");
    fs.writeFileSync(
      dupPath,
      JSON.stringify([
        { id: "alice", apiKey: "key-1", actualSyncId: "sync-1", actualPassword: "pw" },
        { id: "alice", apiKey: "key-2", actualSyncId: "sync-2", actualPassword: "pw" },
      ])
    );
    assert.throws(() => loadTenants(dupPath), /duplicate tenant id "alice"/);
  });

  it("defaults accountMapJson to \"{}\" and templates to [] when the per-tenant files don't exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenants-nofiles-"));
    fs.writeFileSync(
      path.join(dir, "tenants.json"),
      JSON.stringify([{ id: "bob", apiKey: "bob-key", actualSyncId: "sync-1", actualPassword: "pw" }])
    );
    const tenants = loadTenants(path.join(dir, "tenants.json"));
    assert.strictEqual(tenants[0].accountMapJson, "{}");
    assert.deepStrictEqual(tenants[0].templates, []);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/tenant-registry.test.js`
Expected: FAIL — `Cannot find module '../src/lib/tenantRegistry'`

- [ ] **Step 4: Implement**

Create `src/lib/tenantRegistry.js`:

```js
const fs = require("node:fs");
const path = require("node:path");
const { validateTemplates } = require("../templates/schema");

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

const loadTenants = (tenantsConfigPath) => {
  if (!fs.existsSync(tenantsConfigPath)) {
    throw new Error(`Tenants config not found at "${tenantsConfigPath}"`);
  }

  const rawTenants = JSON.parse(fs.readFileSync(tenantsConfigPath, "utf8"));
  if (!Array.isArray(rawTenants) || rawTenants.length === 0) {
    throw new Error("Tenants config must be a non-empty array");
  }

  const errors = [];
  const seenIds = new Set();
  const seenApiKeys = new Set();
  const tenantsRootDir = path.dirname(tenantsConfigPath);

  const tenants = rawTenants.map((raw, index) => {
    const tPath = `tenants[${index}]`;

    if (!isNonEmptyString(raw.id)) errors.push(`${tPath}: "id" is required and must be a non-empty string`);
    if (!isNonEmptyString(raw.apiKey)) errors.push(`${tPath}: "apiKey" is required and must be a non-empty string`);
    if (!isNonEmptyString(raw.actualSyncId)) errors.push(`${tPath}: "actualSyncId" is required and must be a non-empty string`);
    if (!isNonEmptyString(raw.actualPassword)) errors.push(`${tPath}: "actualPassword" is required and must be a non-empty string`);

    if (isNonEmptyString(raw.id)) {
      if (seenIds.has(raw.id)) errors.push(`${tPath}: duplicate tenant id "${raw.id}"`);
      seenIds.add(raw.id);
    }
    if (isNonEmptyString(raw.apiKey)) {
      if (seenApiKeys.has(raw.apiKey)) errors.push(`${tPath}: duplicate apiKey (tenant "${raw.id}")`);
      seenApiKeys.add(raw.apiKey);
    }

    if (!isNonEmptyString(raw.id)) return null;

    const accountMapPath = path.join(tenantsRootDir, "tenants", raw.id, "account-map.json");
    const templatesPath = path.join(tenantsRootDir, "tenants", raw.id, "templates.json");

    let accountMapJson = "{}";
    if (fs.existsSync(accountMapPath)) {
      accountMapJson = fs.readFileSync(accountMapPath, "utf8");
      try {
        JSON.parse(accountMapJson);
      } catch (err) {
        errors.push(`${tPath}: account-map.json is not valid JSON: ${err.message}`);
      }
    }

    let templates = [];
    if (fs.existsSync(templatesPath)) {
      try {
        templates = JSON.parse(fs.readFileSync(templatesPath, "utf8"));
        validateTemplates(templates);
      } catch (err) {
        errors.push(`${tPath}: templates.json is invalid: ${err.message}`);
      }
    }

    return {
      id: raw.id,
      actualSyncId: raw.actualSyncId,
      actualPassword: raw.actualPassword,
      actualEncryptionPassword: raw.actualEncryptionPassword || "",
      apiKey: raw.apiKey,
      keycloakSub: raw.keycloakSub || null,
      accountMapJson,
      templates,
    };
  });

  if (errors.length > 0) {
    throw new Error(`Invalid tenants config:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return tenants;
};

module.exports = { loadTenants };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/tenant-registry.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/tenantRegistry.js test/tenant-registry.test.js test/fixtures/tenants
git commit -m "Add tenant registry loader (loadTenants)"
```

---

### Task 6: `src/plugins/env.js` — remove per-tenant env vars

**Files:**
- Modify: `src/plugins/env.js`

**Interfaces:**
- Produces: `fastify.config.ACTUAL_URL` (required string), `fastify.config.TENANTS_CONFIG_PATH` (optional string, default `"config/tenants.json"`). `API_KEY`, `ACTUAL_SYNC_ID`, `ACTUAL_PASSWORD`, `ACTUAL_ENCRYPTION_PASSWORD`, `ACCOUNT_MAP`, `TEMPLATES_CONFIG_PATH` no longer exist on `fastify.config`.

- [ ] **Step 1: Replace the file**

```js
const fastifyEnv = require("@fastify/env");
const fp = require("fastify-plugin");

const schema = {
  type: "object",
  required: ["ACTUAL_URL"],
  properties: {
    ACTUAL_URL: { type: "string" },
    TENANTS_CONFIG_PATH: { type: "string", default: "config/tenants.json" },
  },
};

const options = {
  schema: schema,
  data: process.env,
};

module.exports = fp(async (fastify, opts) => {
  try {
    await fastify.register(fastifyEnv, options);
  } catch (error) {
    fastify.log.error(`Failed to register environment variables: ${error.message}`);
    throw error;
  }
});
```

- [ ] **Step 2: Commit**

No dedicated test file exists for `env.js` alone (it was only ever exercised indirectly through other tests, which get updated in later tasks to stop relying on the removed fields). This step is a standalone commit since removing these fields is a clean, isolated change; downstream breakage from other test files touching the removed env vars is fixed in Tasks 7, 8, and 10.

```bash
git add src/plugins/env.js
git commit -m "Remove per-tenant env vars from env schema, add TENANTS_CONFIG_PATH"
```

---

### Task 7: Rewire `/transaction` onto `request.tenant`

**Files:**
- Modify: `src/routes/transaction.js`
- Modify: `test/sync-failure.test.js`

**Interfaces:**
- Consumes: `request.tenant.workerClient` (set by the auth hook added in Task 9 — for this task's own tests, injected directly by a test-local `preHandler`)
- No change to `src/lib/actualAccounts.js` or `src/lib/actualTransactions.js` — this task only changes what object `transaction.js` passes into them.

- [ ] **Step 1: Modify `src/routes/transaction.js`**

Replace the body of the exported route handler (everything from `const transaction = createTransaction(request);` through the final `return reply.send(transaction);`) so that a `fastifyLike` shim built from `request.tenant.workerClient` is used everywhere the handler previously used `fastify` directly:

```js
const { randomUUID } = require("crypto");
const { parseAmount } = require("../lib/parseAmount");
const { getAccountByName } = require("../lib/actualAccounts");
const { addTransaction, syncBudget } = require("../lib/actualTransactions");

const transactionSchema = {
  schema: {
    body: {
      type: "object",
      properties: {
        amount: { type: ["number", "string"], default: 0 },
        payee: { type: "string", default: "Unknown" },
        account: { type: "string" },
        notes: { type: "string" },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        type: {
          type: "string",
          enum: ["payment", "deposit"],
          default: "payment",
        },
      },
      required: ["account"],
    },
  },
};

const isValidDate = (dateStr) => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const createTransaction = (request) => {
  const { payee, amount: rawAmount, notes, date, type = "payment" } = request.body;
  const amount = typeof rawAmount === "string" ? parseAmount(rawAmount) : rawAmount;
  const isDeposit = type === "deposit";
  const transactionAmount = amount !== undefined && !isNaN(amount) ? Math.round(amount * 100) * (isDeposit ? 1 : -1) : 0;

  return {
    id: randomUUID(),
    payee_name: payee || "Unknown",
    amount: transactionAmount,
    notes: notes || "",
    date: date || new Date().toLocaleDateString('en-CA'),
    cleared: false,
  };
};

const savePayeeLocation = async (fastifyLike, payeeName, latitude, longitude) => {
  const payee = (await fastifyLike.actual.getPayees()).find(
    ({ name }) => name.toLowerCase() === payeeName.trim().toLowerCase()
  );
  if (!payee) return;

  const nearby = await fastifyLike.actualInternal.send("api/payees-get-nearby", {
    latitude,
    longitude,
    maxDistance: 500,
  });
  if (!nearby.some(({ location }) => location.payee_id === payee.id)) {
    await fastifyLike.actualInternal.send("api/payee-location-create", { payeeId: payee.id, latitude, longitude });
  }
};

module.exports = async (fastify, opts) => {
  fastify.post("/transaction", transactionSchema, async (request, reply) => {
    request.log.info(`Received transaction request with body: ${JSON.stringify(request.body)}`);

    const hasLocation = request.body.latitude !== undefined || request.body.longitude !== undefined;
    if (hasLocation && (request.body.latitude === undefined || request.body.longitude === undefined)) {
      return reply.code(400).send({ error: "Invalid location", message: "latitude and longitude must be provided together" });
    }

    if (request.body.date && !isValidDate(request.body.date)) {
      return reply.code(400).send({
        error: "Invalid date",
        message: `"${request.body.date}" is not a valid calendar date. Expected format: YYYY-MM-DD`,
      });
    }

    const fastifyLike = {
      actual: request.tenant.workerClient,
      actualInternal: { send: request.tenant.workerClient.actualInternalSend },
      log: fastify.log,
    };

    const transaction = createTransaction(request);
    const accountName = request.body.account;
    const { accountId, accounts } = await getAccountByName(fastifyLike, accountName);

    if (!accountId) {
      return reply.code(400).send({
        error: "Invalid account",
        message: `Account "${accountName}" not found. Available accounts: ${accounts.map((a) => a.name).join(", ")}`,
      });
    }

    await addTransaction(fastifyLike, accountId, transaction);

    if (hasLocation) {
      try {
        await savePayeeLocation(fastifyLike, transaction.payee_name, request.body.latitude, request.body.longitude);
      } catch (locErr) {
        request.log.error(`Failed to save payee location: ${locErr.message}`);
      }
    }

    const syncResult = await syncBudget(fastifyLike);
    if (!syncResult.ok) {
      return reply.code(500).send({
        error: "Sync failed",
        message: "Transaction was saved locally but failed to sync to the server. It may be lost on restart.",
      });
    }

    return reply.send(transaction);
  });
};
```

- [ ] **Step 2: Rewrite `test/sync-failure.test.js`'s `buildMockServer` to inject `request.tenant` instead of decorating `fastify.actual`/`fastify.actualInternal` directly**

Replace the whole file:

```js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");

async function buildMockServer({ syncBehaviour = "success", nearbyPayees = [] } = {}) {
  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });

  app.decorate("config", { API_KEY: "test-key" });

  const locationRequests = [];
  const mockWorkerClient = {
    getAccounts: async () => [{ id: "acc-1", name: "Checking" }],
    getPayees: async () => [{ id: "payee-1", name: "Test" }],
    addTransactions: async () => "ok",
    sync: async () => {
      if (syncBehaviour === "fail") {
        throw new Error("PostError: unauthorized");
      }
    },
    actualInternalSend: async (name, args) => {
      locationRequests.push({ name, args });
      return name === "api/payees-get-nearby" ? nearbyPayees : undefined;
    },
  };
  app.decorate("locationRequests", locationRequests);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) return;
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== app.config.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.tenant = { id: "test-tenant", workerClient: mockWorkerClient };
  });

  await app.register(require("../src/routes/transaction"));

  return app;
}

describe("Sync failure handling", () => {
  describe("when sync succeeds", () => {
    let app;

    before(async () => {
      app = await buildMockServer({ syncBehaviour: "success" });
    });

    after(async () => {
      await app.close();
    });

    it("should return 200", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/transaction",
        headers: { "x-api-key": "test-key", "content-type": "application/json" },
        payload: { account: "Checking", amount: 10.0, payee: "Test" },
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.ok(body.id);
      assert.strictEqual(body.payee_name, "Test");
    });
  });

  describe("when sync fails", () => {
    let app;

    before(async () => {
      app = await buildMockServer({ syncBehaviour: "fail" });
    });

    after(async () => {
      await app.close();
    });

    it("should return 500 with sync error details", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/transaction",
        headers: { "x-api-key": "test-key", "content-type": "application/json" },
        payload: { account: "Checking", amount: 10.0, payee: "Test" },
      });

      assert.strictEqual(response.statusCode, 500);
      const body = JSON.parse(response.body);
      assert.strictEqual(body.error, "Sync failed");
      assert.ok(body.message.includes("failed to sync"), `Expected sync failure message, got: ${body.message}`);
    });
  });

  it("saves a payee location when coordinates are supplied", async () => {
    const app = await buildMockServer();
    const response = await app.inject({
      method: "POST",
      url: "/transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { account: "Checking", payee: "Test", latitude: -37.8136, longitude: 144.9631 },
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(app.locationRequests, [
      { name: "api/payees-get-nearby", args: { latitude: -37.8136, longitude: 144.9631, maxDistance: 500 } },
      { name: "api/payee-location-create", args: { payeeId: "payee-1", latitude: -37.8136, longitude: 144.9631 } },
    ]);
    await app.close();
  });

  it("does not save a duplicate nearby payee location", async () => {
    const app = await buildMockServer({
      nearbyPayees: [{ payee: { id: "payee-1" }, location: { payee_id: "payee-1" } }],
    });
    const response = await app.inject({
      method: "POST",
      url: "/transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { account: "Checking", payee: "Test", latitude: -37.8136, longitude: 144.9631 },
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(app.locationRequests, [
      { name: "api/payees-get-nearby", args: { latitude: -37.8136, longitude: 144.9631, maxDistance: 500 } },
    ]);
    await app.close();
  });

  it("requires both location coordinates", async () => {
    const app = await buildMockServer();
    const response = await app.inject({
      method: "POST",
      url: "/transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { account: "Checking", latitude: -37.8136 },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Invalid location");
    await app.close();
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `node --test test/sync-failure.test.js`
Expected: PASS (all tests, same assertions as before — only the setup changed)

- [ ] **Step 4: Commit**

```bash
git add src/routes/transaction.js test/sync-failure.test.js
git commit -m "Rewire /transaction onto request.tenant"
```

---

### Task 8: Rewire `/vietqr-transaction` onto `request.tenant` + fix cross-tenant dedup collision

**Files:**
- Modify: `src/routes/vietqrTransaction.js`
- Modify: `test/vietqr-transaction.test.js`

**Interfaces:**
- Consumes: `request.tenant.{workerClient, templates, accountMapJson, id}`
- **Correctness fix beyond pure re-keying:** the dedup key must include the tenant id. Without this, two different tenants whose banks happen to produce the same `referenceCode` under the same template `name` (e.g. both using the shipped `bidv-expense` template) would collide in the dedup cache — tenant B's transaction would be silently treated as a duplicate of tenant A's and never created. `buildDedupKey` gains a `tenantId` parameter as its first argument.

- [ ] **Step 1: Modify `src/routes/vietqrTransaction.js`**

```js
const { randomUUID, createHash } = require("crypto");
const { normalize, identify, extract, AmbiguousMatchError } = require("../templates");
const { resolveAccountName } = require("../lib/accountResolver");
const { createDedupCache } = require("../lib/dedupCache");
const { getAccountByName } = require("../lib/actualAccounts");
const { addTransaction, syncBudget } = require("../lib/actualTransactions");

const vietqrTransactionSchema = {
  schema: {
    body: {
      type: "object",
      properties: {
        rawText: { type: "string", minLength: 1 },
        capturedAt: { type: "string" },
      },
      required: ["rawText"],
    },
  },
};

const buildDedupKey = (tenantId, templateName, parsed, normalizedText) => {
  if (parsed.referenceCode) {
    return `${tenantId}:${templateName}:ref:${parsed.referenceCode}`;
  }
  const hash = createHash("sha256").update(normalizedText).digest("hex");
  return `${tenantId}:${templateName}:hash:${hash}`;
};

module.exports = async (fastify, opts) => {
  const dedupCache = opts.dedupCache || createDedupCache();

  fastify.post("/vietqr-transaction", vietqrTransactionSchema, async (request, reply) => {
    const normalizedText = normalize(request.body.rawText);
    const templates = request.tenant.templates;

    let template;
    try {
      template = identify(normalizedText, templates);
    } catch (err) {
      if (err instanceof AmbiguousMatchError) {
        return reply.code(500).send({ error: "Ambiguous template match", message: err.message });
      }
      throw err;
    }

    if (!template) {
      return reply.code(400).send({
        error: "Unrecognized bank format",
        message: "No template matched the provided rawText",
      });
    }

    let parsed;
    try {
      parsed = extract(normalizedText, template);
    } catch (err) {
      return reply.code(422).send({
        error: "Failed to parse transaction",
        message: err.message,
      });
    }

    if (typeof parsed.amount !== "number" || !Number.isFinite(parsed.amount)) {
      return reply.code(422).send({
        error: "Failed to parse transaction",
        message: `Could not parse a numeric amount (got "${parsed.amount}")`,
      });
    }

    const accountName = resolveAccountName(parsed.sourceAccountNumber, request.tenant.accountMapJson);
    if (!accountName) {
      return reply.code(400).send({
        error: "Unknown source account",
        message: `Source account "${parsed.sourceAccountNumber}" is not mapped in this tenant's account map`,
      });
    }

    const fastifyLike = {
      actual: request.tenant.workerClient,
      actualInternal: { send: request.tenant.workerClient.actualInternalSend },
      log: fastify.log,
    };

    const { accountId, accounts } = await getAccountByName(fastifyLike, accountName);
    if (!accountId) {
      return reply.code(400).send({
        error: "Invalid account",
        message: `Account "${accountName}" not found in Actual. Available accounts: ${accounts.map((a) => a.name).join(", ")}`,
      });
    }

    const dedupKey = buildDedupKey(request.tenant.id, template.name, parsed, normalizedText);
    if (dedupCache.checkAndMark(dedupKey)) {
      return reply.send({ duplicate: true, ...parsed });
    }

    const signedAmount = parsed.direction === "expense" ? -Math.abs(parsed.amount) : Math.abs(parsed.amount);
    const transaction = {
      id: randomUUID(),
      payee_name: parsed.counterpartyName,
      amount: signedAmount * 100,
      notes: parsed.description,
      date: parsed.transactionDate,
      imported_id: parsed.referenceCode,
      cleared: false,
    };

    try {
      await addTransaction(fastifyLike, accountId, transaction);
    } catch (err) {
      dedupCache.unmark(dedupKey);
      throw err;
    }

    const syncResult = await syncBudget(fastifyLike);
    if (!syncResult.ok) {
      return reply.code(500).send({
        error: "Sync failed",
        message: "Transaction was saved locally but failed to sync to the server. It may be lost on restart.",
      });
    }

    return reply.send(transaction);
  });
};
```

- [ ] **Step 2: Rewrite `test/vietqr-transaction.test.js`**

Replace the whole file:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const fastify = require("fastify");
const { createDedupCache } = require("../src/lib/dedupCache");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8");
const TEMPLATES = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/templates.json"), "utf8"));

async function buildMockServer({
  accountMapJson = '{"8820966012":"BIDV Cash"}',
  accounts = [{ id: "acc-1", name: "BIDV Cash" }],
  syncBehaviour = "success",
  templates = TEMPLATES,
  tenantId = "test-tenant",
  dedupCache = createDedupCache(),
} = {}) {
  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });

  app.decorate("config", { API_KEY: "test-key" });

  const addedTransactions = [];
  const mockWorkerClient = {
    getAccounts: async () => accounts,
    addTransactions: async (accountId, transactions) => {
      addedTransactions.push({ accountId, transactions });
      return "ok";
    },
    sync: async () => {
      if (syncBehaviour === "fail") {
        throw new Error("PostError: unauthorized");
      }
    },
  };
  app.decorate("addedTransactions", addedTransactions);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) return;
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== app.config.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.tenant = { id: tenantId, workerClient: mockWorkerClient, templates, accountMapJson };
  });

  await app.register(require("../src/routes/vietqrTransaction"), { dedupCache });

  return app;
}

describe("POST /vietqr-transaction", () => {
  it("creates an expense transaction from a matching BIDV email", async () => {
    const app = await buildMockServer();
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });

    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.amount, -1000000);
    assert.strictEqual(body.payee_name, "PHAM MANH TUONG");
    assert.strictEqual(body.date, "2026-09-04");
    assert.strictEqual(body.imported_id, "6247BIDVE2NEKZD1");
    assert.ok(body.notes.includes("6247BIDVE2NEKZD1"));
    assert.strictEqual(app.addedTransactions.length, 1);
    assert.strictEqual(app.addedTransactions[0].accountId, "acc-1");
    await app.close();
  });

  it("returns 400 when no template matches", async () => {
    const app = await buildMockServer();
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: "Your OTP code is 123456" },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Unrecognized bank format");
    await app.close();
  });

  it("returns 400 for a BIDV email lacking the debit-account label (e.g. an income variant)", async () => {
    const app = await buildMockServer();
    const incomeText = FIXTURE.replace("Tài khoản nguồn:", "Tài khoản đích:");
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: incomeText },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Unrecognized bank format");
    await app.close();
  });

  it("returns 500 when more than one template matches the same rawText", async () => {
    const duplicateTemplates = [
      {
        name: "dup-a",
        sourceType: "email",
        direction: "expense",
        match: { contains: ["FOO"] },
        fields: { x: { label: "FOO:", stopLabel: "$END$" } },
        requiredFields: ["x"],
      },
      {
        name: "dup-b",
        sourceType: "email",
        direction: "expense",
        match: { contains: ["FOO"] },
        fields: { x: { label: "FOO:", stopLabel: "$END$" } },
        requiredFields: ["x"],
      },
    ];
    const app = await buildMockServer({ templates: duplicateTemplates });
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: "FOO: bar" },
    });

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(JSON.parse(response.body).error, "Ambiguous template match");
    await app.close();
  });

  it("returns 400 when the source account is not in this tenant's account map", async () => {
    const app = await buildMockServer({ accountMapJson: "{}" });
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Unknown source account");
    await app.close();
  });

  it("does not create a duplicate transaction for the same reference code within TTL", async () => {
    const app = await buildMockServer();
    const first = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(first.statusCode, 200);

    const second = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(JSON.parse(second.body).duplicate, true);
    assert.strictEqual(app.addedTransactions.length, 1);
    await app.close();
  });

  it("does NOT treat two different tenants' identical reference codes as duplicates of each other", async () => {
    const sharedDedupCache = createDedupCache();
    const appAlice = await buildMockServer({ tenantId: "alice", dedupCache: sharedDedupCache });
    const appBob = await buildMockServer({ tenantId: "bob", dedupCache: sharedDedupCache });

    const aliceResponse = await appAlice.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(aliceResponse.statusCode, 200);
    assert.strictEqual(JSON.parse(aliceResponse.body).duplicate, undefined);

    const bobResponse = await appBob.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(bobResponse.statusCode, 200);
    assert.strictEqual(
      JSON.parse(bobResponse.body).duplicate,
      undefined,
      "bob's transaction (same reference code as alice's) must not be treated as a duplicate"
    );

    assert.strictEqual(appAlice.addedTransactions.length, 1);
    assert.strictEqual(appBob.addedTransactions.length, 1);
    await appAlice.close();
    await appBob.close();
  });

  it("returns 500 when sync fails after the transaction is added", async () => {
    const app = await buildMockServer({ syncBehaviour: "fail" });
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(JSON.parse(response.body).error, "Sync failed");
    await app.close();
  });

  it("does not poison the dedup cache when the account is not found in Actual", async () => {
    const app = await buildMockServer({ accounts: [] });
    const first = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(first.statusCode, 400);
    assert.strictEqual(JSON.parse(first.body).error, "Invalid account");

    const second = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(second.statusCode, 400);
    assert.strictEqual(JSON.parse(second.body).error, "Invalid account");
    await app.close();
  });

  it("does not poison the dedup cache when addTransaction fails", async () => {
    const app = await buildMockServer();
    const brokenWorkerClient = {
      getAccounts: async () => [{ id: "acc-1", name: "BIDV Cash" }],
      addTransactions: async () => {
        throw new Error("Actual is down");
      },
    };
    app.addHook("preHandler", async (request) => {
      request.tenant.workerClient = brokenWorkerClient;
    });

    const first = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(first.statusCode, 500);
    assert.strictEqual(app.addedTransactions.length, 0);

    const workingWorkerClient = {
      getAccounts: async () => [{ id: "acc-1", name: "BIDV Cash" }],
      addTransactions: async (accountId, transactions) => {
        app.addedTransactions.push({ accountId, transactions });
        return "ok";
      },
    };
    app.addHook("preHandler", async (request) => {
      request.tenant.workerClient = workingWorkerClient;
    });

    const second = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(JSON.parse(second.body).duplicate, undefined);
    assert.strictEqual(app.addedTransactions.length, 1);
    await app.close();
  });
});
```

Note on the last test: Fastify runs `preHandler` hooks in registration order, so the two hooks added via `app.addHook` after the server was already built by `buildMockServer` run *after* the hook `buildMockServer` itself registered (which sets `request.tenant`) — each overwrites `request.tenant.workerClient` right before the route handler runs, exactly reproducing the original test's "swap the mock mid-test" behavior without needing to decorate `fastify.actual` directly.

- [ ] **Step 3: Run the test to verify it passes**

Run: `node --test test/vietqr-transaction.test.js`
Expected: PASS (10 tests)

- [ ] **Step 4: Commit**

```bash
git add src/routes/vietqrTransaction.js test/vietqr-transaction.test.js
git commit -m "Rewire /vietqr-transaction onto request.tenant, fix cross-tenant dedup collision"
```

---

### Task 9: Tenant lookup helper + wire everything together in `src/server.js`

**Files:**
- Create: `src/lib/tenantAuth.js`
- Test: `test/tenant-auth.test.js`
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `loadTenants` (Task 5), `spawnAll` (Task 4), `fastify.config.ACTUAL_URL`/`TENANTS_CONFIG_PATH` (Task 6)
- Produces: `buildTenantLookup(tenants: Array<{id, apiKey, templates, accountMapJson, keycloakSub}>, workerClients: Map<string, WorkerClient>) => { tenantsById: Map, tenantsByApiKey: Map }` and `resolveTenant(tenantsByApiKey: Map, apiKey: string) => tenant | null`.

The spec's testing plan (§8) explicitly calls for a routing/auth test: a valid API key resolves to the correct tenant, an unknown key doesn't, and two tenants' keys never cross-resolve to each other's data. The other route tests in this plan (Tasks 7-8) inject `request.tenant` directly via a test-local `preHandler`, which never exercises the real per-tenant API-key lookup that will run in production — so that lookup logic is extracted into its own small module here, specifically so it can be unit-tested without booting a real Fastify server or real tenant workers.

- [ ] **Step 1: Write the failing tests**

Create `test/tenant-auth.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/tenant-auth.test.js`
Expected: FAIL — `Cannot find module '../src/lib/tenantAuth'`

- [ ] **Step 3: Implement**

Create `src/lib/tenantAuth.js`:

```js
const buildTenantLookup = (tenants, workerClients) => {
  const tenantsById = new Map();
  for (const t of tenants) {
    tenantsById.set(t.id, {
      id: t.id,
      workerClient: workerClients.get(t.id),
      templates: t.templates,
      accountMapJson: t.accountMapJson,
      keycloakSub: t.keycloakSub,
    });
  }
  const tenantsByApiKey = new Map(tenants.map((t) => [t.apiKey, tenantsById.get(t.id)]));
  return { tenantsById, tenantsByApiKey };
};

const resolveTenant = (tenantsByApiKey, apiKey) => tenantsByApiKey.get(apiKey) || null;

module.exports = { buildTenantLookup, resolveTenant };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/tenant-auth.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/tenantAuth.js test/tenant-auth.test.js
git commit -m "Add tenant lookup helper (buildTenantLookup, resolveTenant) with routing/auth tests"
```

- [ ] **Step 6: Replace `registerModules()` and the shutdown wiring in `src/server.js`**

```js
const fastify = require("fastify")({
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
        ignore: "hostname,pid",
        singleLine: false,
        hideObject: false,
      },
    },
  },
  ajv: {
    customOptions: {
      allowUnionTypes: true,
    },
  },
  routerOptions: {
    ignoreTrailingSlash: true,
  },
  pluginTimeout: 120000, // 120 seconds to match Actual API initialization timeout and retries
});
const { version } = require("../package.json");

async function registerModules() {
  await fastify.register(require("./plugins/env"));

  const { loadTenants } = require("./lib/tenantRegistry");
  const tenants = loadTenants(fastify.config.TENANTS_CONFIG_PATH);
  fastify.log.info(`Loaded ${tenants.length} tenant(s) from ${fastify.config.TENANTS_CONFIG_PATH}`);

  const { spawnAll } = require("./worker/tenantWorkerPool");
  const { clients: workerClients, killAll } = await spawnAll(
    tenants.map((t) => ({
      id: t.id,
      actualUrl: fastify.config.ACTUAL_URL,
      actualPassword: t.actualPassword,
      actualSyncId: t.actualSyncId,
      actualEncryptionPassword: t.actualEncryptionPassword,
    }))
  );
  fastify.log.info(`All ${tenants.length} tenant worker(s) ready`);

  const { buildTenantLookup, resolveTenant } = require("./lib/tenantAuth");
  const { tenantsByApiKey } = buildTenantLookup(tenants, workerClients);

  fastify.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) {
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

  await fastify.register(require("@fastify/cors"), {
    methods: ["POST"],
  });

  await fastify.register(require("./routes/transaction"));
  await fastify.register(require("./routes/vietqrTransaction"));
  await fastify.register(require("./routes/health"));

  fastify.addHook("onClose", () => {
    killAll();
    fastify.log.info("All tenant workers shut down");
  });
}

// Global Error Handler
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);
  reply.status(error.statusCode || 500).send({ error: error.message || "An error occurred" });
});

// Start the server
const start = async () => {
  try {
    fastify.log.info(`Starting ActualTap v${version}`);
    await registerModules();
    try {
      await fastify.listen({ port: 3001, host: "::" });
    } catch (err) {
      if (err.code === 'EAFNOSUPPORT' || err.message.includes('address family not supported')) {
        fastify.log.warn('IPv6 not supported, falling back to IPv4');
        await fastify.listen({ port: 3001, host: "0.0.0.0" });
      } else {
        throw err;
      }
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
```

- [ ] **Step 7: Run the full test suite so far**

Run: `node --test test/*.test.js`
Expected: every sandbox-runnable test file passes (Tasks 1-8's new/modified files, plus this task's `tenant-auth.test.js`); `test/initialization.test.js`, `test/tenant-worker.test.js` still require real Actual credentials (unchanged requirement); `test/helpers.js`/`test/transaction.test.js` are updated in Task 10.

- [ ] **Step 8: Commit**

```bash
git add src/server.js
git commit -m "Wire tenant registry, worker pool, and per-tenant auth into server.js"
```

---

### Task 10: Delete `actualConnector.js`, update the real-Actual-server test helper

**Files:**
- Delete: `src/plugins/actualConnector.js`
- Modify: `test/helpers.js`
- Modify: `test/transaction.test.js` (only if it references anything `helpers.js` no longer exports — see Step 2)

**Interfaces:**
- Produces (from `test/helpers.js`): `buildServer() => Promise<FastifyInstance>` — now builds a single-tenant server by constructing an in-memory tenant array directly (bypassing `loadTenants`'s file I/O) from the same real env vars this file already required (`ACTUAL_URL`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`, `ACTUAL_ENCRYPTION_PASSWORD`).

- [ ] **Step 1: Delete the now-unused plugin**

```bash
git rm src/plugins/actualConnector.js
```

- [ ] **Step 2: Rewrite `test/helpers.js`**

```js
const fastify = require("fastify");
const { spawnAll } = require("../src/worker/tenantWorkerPool");

const TEST_TENANT_ID = "test-tenant";
const TEST_API_KEY = "test-key";

/**
 * Build a Fastify server instance for testing against a REAL Actual server.
 * Requires ACTUAL_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID (and optionally
 * ACTUAL_ENCRYPTION_PASSWORD) to be set in the environment.
 * Uses inject() - no port binding needed.
 */
async function buildServer() {
  const app = fastify({
    logger: false,
    pluginTimeout: 120000,
    ajv: {
      customOptions: {
        allowUnionTypes: true,
      },
    },
  });

  app.decorate("config", { API_KEY: TEST_API_KEY });

  const { clients, killAll } = await spawnAll([
    {
      id: TEST_TENANT_ID,
      actualUrl: process.env.ACTUAL_URL,
      actualPassword: process.env.ACTUAL_PASSWORD,
      actualSyncId: process.env.ACTUAL_SYNC_ID,
      actualEncryptionPassword: process.env.ACTUAL_ENCRYPTION_PASSWORD,
    },
  ]);
  const workerClient = clients.get(TEST_TENANT_ID);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) return;
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== app.config.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.tenant = { id: TEST_TENANT_ID, workerClient };
  });

  await app.register(require("@fastify/cors"), { methods: ["POST"] });
  await app.register(require("../src/routes/transaction"));
  await app.register(require("../src/routes/health"));

  app.addHook("onClose", () => killAll());

  return { app, workerClient };
}

/**
 * Delete transactions by IDs.
 * @param {object} actual - The actual API instance
 * @param {string} accountId - Account ID containing transactions
 * @param {string[]} transactionIds - Array of transaction IDs to delete
 */
async function cleanupTransactions(actual, accountId, transactionIds) {
  for (const id of transactionIds) {
    try {
      await actual.deleteTransaction(id);
    } catch (err) {
      console.error(`Failed to delete transaction ${id}: ${err.message}`);
    }
  }
}

/**
 * Get the first account ID from the budget.
 * @param {object} actual - The actual API instance
 * @returns {Promise<{id: string, name: string}>}
 */
async function getFirstAccount(actual) {
  const accounts = await actual.getAccounts();
  if (!accounts || accounts.length === 0) {
    throw new Error("No accounts found in budget");
  }
  return accounts[0];
}

module.exports = {
  buildServer,
  cleanupTransactions,
  getFirstAccount,
};
```

- [ ] **Step 3: Add the `deleteTransaction` passthrough (retroactive fix to Tasks 2-4)**

`test/transaction.test.js`'s cleanup calls `actual.deleteTransaction(id)`, which is not one of the `WorkerClient` methods Task 4 defined. Add it in all three worker files now:

Update `src/worker/workerProtocol.js`'s `METHODS` map (Task 2's file) to add:
```js
  deleteTransaction: (client, args) => client.deleteTransaction(...args),
```

Update `src/worker/tenantWorker.js`'s `actualClient` object (Task 3's file) to add:
```js
    deleteTransaction: (id) => actual.deleteTransaction(id),
```

Update `src/worker/tenantWorkerPool.js`'s `createWorkerClient` return object (Task 4's file) to add:
```js
    deleteTransaction: (id) => call("deleteTransaction", [id]),
```

- [ ] **Step 4: Update `test/transaction.test.js` to use `{ app, workerClient }` instead of `app.actual`**

The current file only touches the real Actual connection in two places — `before()` (`getFirstAccount(app.actual)`) and `after()` (`cleanupTransactions(app.actual, ...)`). Every other line (all the `it(...)` blocks) uses `app.inject(...)` and `app.config.API_KEY`, which are unaffected. Change just the `before`/`after` block:

```js
  before(async () => {
    ({ app, workerClient } = await buildServer());
    testAccount = await getFirstAccount(workerClient);
  });

  after(async () => {
    // If before() failed, app was never assigned - nothing to clean up
    if (!app) return;

    // Cleanup all created transactions
    if (createdTransactionIds.length > 0) {
      await cleanupTransactions(workerClient, testAccount.id, createdTransactionIds);
      console.log(`Cleaned up ${createdTransactionIds.length} test transaction(s)`);
    }

    // app.close() shuts down the tenant worker via the onClose hook in test/helpers.js
    await app.close();
  });
```

And add `workerClient` to the enclosing `describe`'s `let` declaration:

```js
describe("Transaction API", () => {
  let app;
  let workerClient;
  let testAccount;
  const createdTransactionIds = [];
```

(No other line in the file changes — every `it(...)` block keeps using `app.inject(...)` and `app.config.API_KEY` exactly as before.)

- [ ] **Step 5: Run the test (requires real Actual credentials — same requirement this file already had)**

Run: `node --test test/transaction.test.js`
Expected: PASS on a machine with real Actual credentials configured.

- [ ] **Step 6: Run the full suite one more time**

Run: `node --test test/*.test.js`
Expected: every file except `test/initialization.test.js`, `test/tenant-worker.test.js`, and `test/transaction.test.js` passes in this sandbox (all three need a real Actual server, consistent with this project's existing convention); no other regressions.

- [ ] **Step 7: Commit**

```bash
git add -A src/worker test/helpers.js test/transaction.test.js
git rm src/plugins/actualConnector.js 2>/dev/null || true
git commit -m "Delete actualConnector.js; rebuild real-Actual-server test helper on the worker pool"
```

---

### Task 11: README migration documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the Environment Variables section**

Find the existing Environment Variables table (it currently lists `API_KEY`, `ACTUAL_URL`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`, `ACTUAL_ENCRYPTION_PASSWORD`, `ACCOUNT_MAP`, `TEMPLATES_CONFIG_PATH`). Replace the rows for `API_KEY`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`, `ACTUAL_ENCRYPTION_PASSWORD`, `ACCOUNT_MAP`, `TEMPLATES_CONFIG_PATH` (all now per-tenant, not env vars) with a single new row:

```markdown
| `TENANTS_CONFIG_PATH`        | `config/tenants.json`                | _(optional)_ Path to the tenant registry (see Multi-Tenant Configuration below). Defaults to `config/tenants.json`. |
```

Keep the `TZ` and `ACTUAL_URL` rows as-is (both remain global env vars).

- [ ] **Step 2: Add a "Multi-Tenant Configuration" section**

Add a new section (near the existing "Template Configuration" section) documenting:
- `config/tenants.json` is a JSON array; each entry needs `id`, `apiKey`, `actualSyncId`, `actualPassword`, and optionally `actualEncryptionPassword`.
- Each tenant's `apiKey` is what Shortcuts/Tasker/etc. send as `X-API-KEY` for that tenant's own budget — every tenant needs their own key now, there is no longer one shared `API_KEY`.
- Per-tenant `config/tenants/<id>/account-map.json` (same shape the old `ACCOUNT_MAP` env var held) and `config/tenants/<id>/templates.json` (same shape the old `config/templates.json` held) are optional — a missing file behaves like `{}`/`[]` respectively.
- **Migration from a pre-multi-tenant deployment:** create `config/tenants.json` with one entry reusing the old `ACTUAL_SYNC_ID`/`ACTUAL_PASSWORD`/`ACTUAL_ENCRYPTION_PASSWORD`/`API_KEY` values (pick any `id`, e.g. `"default"`); move the old `ACCOUNT_MAP` JSON value into `config/tenants/default/account-map.json`; move the old `config/templates.json` into `config/tenants/default/templates.json` unchanged; remove `ACCOUNT_MAP`, `ACTUAL_SYNC_ID`, `ACTUAL_PASSWORD`, `ACTUAL_ENCRYPTION_PASSWORD`, `API_KEY`, `TEMPLATES_CONFIG_PATH` from the environment (they're no longer read).

Include one concrete example `config/tenants.json` in the docs, e.g.:

```json
[
  {
    "id": "default",
    "actualSyncId": "8B51B58D-3A0D-4B5B-A41F-DE574306A4F2",
    "actualPassword": "superSecretPassword",
    "apiKey": "527D6AAA-B22A-4D48-9DC8-C203139E5531"
  }
]
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document multi-tenant configuration and migration path"
```

---

### Task 12: Full regression run and final consistency check

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full suite**

Run: `node --test test/*.test.js`
Expected: every file passes except `test/initialization.test.js`, `test/tenant-worker.test.js`, `test/transaction.test.js` (all three require a real Actual server per this project's existing convention — run those on a VM/CI where `ACTUAL_URL`/`ACTUAL_PASSWORD`/`ACTUAL_SYNC_ID` are configured).

- [ ] **Step 2: Grep for any remaining reference to the removed env vars or the deleted plugin**

Run: `grep -rn "ACCOUNT_MAP\|ACTUAL_SYNC_ID\|ACTUAL_PASSWORD\|ACTUAL_ENCRYPTION_PASSWORD\|TEMPLATES_CONFIG_PATH\|actualConnector" src/ test/ --include="*.js"`
Expected: no output referencing the old global env vars or `src/plugins/actualConnector.js` outside of `src/lib/actualConnectorInit.js` (which legitimately still has the `ACTUAL_ENCRYPTION_PASSWORD`-shaped error message text, unrelated to the env var name) and `README.md`'s migration section (expected, historical reference).

- [ ] **Step 3: Confirm `config/templates.json` and `config/tenants.json` don't both exist as competing sources**

Run: `ls config/`
Expected: `config/templates.json` (the single-tenant Sub-project A artifact) has been superseded — if it's still present after following Task 11's migration steps for this repo's own real deployment config, that's fine (it's now unused by the app, since `TEMPLATES_CONFIG_PATH` no longer exists), but note in the PR description that it's dead weight an operator should remove once they've migrated their own `config/tenants/<id>/templates.json`.

- [ ] **Step 4: Re-read the spec's Goals/Non-goals (§2) and confirm each is met**

- Multiple tenants, each own Actual Budget file: ✅ Task 4 (one child process per tenant) + Task 9 (wiring).
- Each tenant's own account map + templates: ✅ Task 5 (`loadTenants`) + Task 8/9 (per-tenant lookup).
- Data-plane API-key identification: ✅ Task 9 (`tenantsByApiKey`).
- Config-file + restart provisioning: ✅ Task 5, no self-service UI added.
- Eager spawn, no idle eviction: ✅ Task 9 (`spawnAll` called once at startup, no lazy/eviction logic anywhere).
- Fail-fast on one tenant's connection failure: ✅ Task 4 (`spawnAll` rejects and kills every other worker).

No task left uncovered.
