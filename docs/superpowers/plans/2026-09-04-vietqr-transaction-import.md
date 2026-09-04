# VietQR/Bank-email Transaction Import (BIDV, expense) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /vietqr-transaction`, an adapter framework for detecting the source bank from raw email/OCR text, and a BIDV adapter (expense direction only) that turns a matched email into an Actual Budget transaction.

**Architecture:** A new Fastify route normalizes `rawText`, runs it through a small adapter registry (`match()`/`parse()` per bank), resolves the Actual account via a bank-account-number → account-name map, deduplicates via an in-memory TTL cache, then reuses (newly extracted) shared helpers to create and sync the transaction — the same helpers `/transaction` is refactored to use, so both routes share one code path for talking to Actual.

**Tech Stack:** Node.js, Fastify 5, `@actual-app/api`, Node's built-in `node:test` + `assert` (no new test framework).

**Spec:** `docs/superpowers/specs/2026-09-04-vietqr-transaction-import-design.md`

## Global Constraints

- `/vietqr-transaction` must not change the behavior of the existing `/transaction` route.
- No auto-categorization — Actual's rule engine handles categories.
- `ACCOUNT_MAP` env var is a JSON string, **optional**, default `"{}"` — must not break existing deployments that don't set it.
- Dedup cache TTL is 10 minutes; key is `` `${bank}:ref:${referenceCode}` `` when the adapter returns a reference code, else `` `${bank}:hash:${sha256(normalizedRawText)}` ``.
- BIDV adapter (this plan) supports **expense (outgoing) only**. If the email looks like BIDV but lacks the "Tài khoản nguồn" (debit account) label, `parse()` throws rather than guessing the direction.
- Tests use `node:test` + `assert`, matching the existing files under `test/`. `package.json`'s `test` script is `node --test test/*.test.js` — a **non-recursive** shell glob — so all new test files go flat in `test/`, not in subdirectories. Fixtures (non-test data) can go in `test/fixtures/`.
- Route-level tests use the mock-`fastify.actual` pattern from `test/sync-failure.test.js` (no real Actual server needed), not the live-server pattern from `test/transaction.test.js`/`test/helpers.js`.

---

## File Structure

```
src/lib/actualAccounts.js        // NEW — getAccountByName(), extracted from transaction.js
src/lib/actualTransactions.js    // NEW — addTransaction(), syncBudget(), extracted from transaction.js
src/lib/dedupCache.js            // NEW — createDedupCache()
src/lib/accountResolver.js       // NEW — resolveAccountName()
src/adapters/bidv.js             // NEW — BIDV match()/parse()
src/adapters/index.js            // NEW — normalize(), identify()
src/routes/vietqrTransaction.js  // NEW — POST /vietqr-transaction
src/routes/transaction.js        // MODIFY — use the extracted lib helpers instead of local copies
src/plugins/env.js               // MODIFY — add optional ACCOUNT_MAP
src/server.js                    // MODIFY — register the new route

test/actual-accounts.test.js       // NEW
test/actual-transactions.test.js   // NEW
test/dedup-cache.test.js           // NEW
test/account-resolver.test.js      // NEW
test/bidv-adapter.test.js          // NEW
test/adapter-registry.test.js      // NEW
test/vietqr-transaction.test.js    // NEW
test/fixtures/bidv-expense.txt     // NEW — real BIDV expense email, confirmed via two independent sources
```

---

### Task 1: Extract shared Actual helpers, refactor `/transaction` to use them

**Files:**
- Create: `src/lib/actualAccounts.js`
- Create: `src/lib/actualTransactions.js`
- Test: `test/actual-accounts.test.js`
- Test: `test/actual-transactions.test.js`
- Modify: `src/routes/transaction.js:1-2` (imports), `src/routes/transaction.js:70-74` (remove local `getAccountId`), `src/routes/transaction.js:110` (call site), `src/routes/transaction.js:119-149` (add+sync block)

**Interfaces:**
- Produces: `getAccountByName(fastify, accountName) => Promise<{ accountId: string|undefined, accounts: Array<{id, name}> }>`
- Produces: `addTransaction(fastify, accountId, transaction) => Promise<void>` (throws `Error` if Actual's result isn't `"ok"`)
- Produces: `syncBudget(fastify) => Promise<{ ok: true } | { ok: false, error: Error }>`

- [ ] **Step 1: Write failing tests for the new lib functions**

Create `test/actual-accounts.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { getAccountByName } = require("../src/lib/actualAccounts");

describe("getAccountByName", () => {
  it("returns the account id for a case-insensitive name match", async () => {
    const fastify = { actual: { getAccounts: async () => [{ id: "acc-1", name: "Checking" }] } };
    const result = await getAccountByName(fastify, "checking");
    assert.strictEqual(result.accountId, "acc-1");
  });

  it("returns undefined accountId and the full account list when no match is found", async () => {
    const fastify = { actual: { getAccounts: async () => [{ id: "acc-1", name: "Checking" }] } };
    const result = await getAccountByName(fastify, "Savings");
    assert.strictEqual(result.accountId, undefined);
    assert.deepStrictEqual(result.accounts, [{ id: "acc-1", name: "Checking" }]);
  });
});
```

Create `test/actual-transactions.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { addTransaction, syncBudget } = require("../src/lib/actualTransactions");

function fakeFastify({ addResult = "ok", syncBehaviour = "success" } = {}) {
  return {
    actual: {
      addTransactions: async () => addResult,
      sync: async () => {
        if (syncBehaviour === "fail") throw new Error("PostError: unauthorized");
      },
    },
    log: { info: () => {}, error: () => {} },
  };
}

describe("addTransaction", () => {
  it('resolves without error when Actual returns "ok"', async () => {
    const fastify = fakeFastify();
    await assert.doesNotReject(() => addTransaction(fastify, "acc-1", { id: "t1" }));
  });

  it("throws when Actual returns an error result", async () => {
    const fastify = fakeFastify({ addResult: { errors: ["boom"] } });
    await assert.rejects(() => addTransaction(fastify, "acc-1", { id: "t1" }), /boom/);
  });
});

describe("syncBudget", () => {
  it("returns { ok: true } when sync succeeds", async () => {
    const fastify = fakeFastify({ syncBehaviour: "success" });
    const result = await syncBudget(fastify);
    assert.strictEqual(result.ok, true);
  });

  it("returns { ok: false, error } when sync fails", async () => {
    const fastify = fakeFastify({ syncBehaviour: "fail" });
    const result = await syncBudget(fastify);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error instanceof Error);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/actual-accounts.test.js test/actual-transactions.test.js`
Expected: FAIL — `Cannot find module '../src/lib/actualAccounts'` (and `actualTransactions`)

- [ ] **Step 3: Implement the lib modules**

Create `src/lib/actualAccounts.js`:

```js
const getAccountByName = async (fastify, accountName) => {
  const accounts = await fastify.actual.getAccounts();
  const account = accounts.find((acc) => acc.name.toLowerCase() === accountName.toLowerCase());
  return { accountId: account?.id, accounts };
};

module.exports = { getAccountByName };
```

Create `src/lib/actualTransactions.js`:

```js
const addTransaction = async (fastify, accountId, transaction) => {
  const result = await fastify.actual.addTransactions(accountId, [transaction]);

  if (result !== "ok") {
    const errorMessage = result?.errors ? result.errors.join(", ") : JSON.stringify(result);
    throw new Error(`Failed to add transaction: ${errorMessage}`);
  }

  fastify.log.info("Transaction added successfully");
};

const syncBudget = async (fastify) => {
  try {
    await fastify.actual.sync();
    fastify.log.info("Sync completed successfully");
    return { ok: true };
  } catch (syncErr) {
    fastify.log.error(`Sync failed after adding transaction: ${syncErr.message}`);
    return { ok: false, error: syncErr };
  }
};

module.exports = { addTransaction, syncBudget };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/actual-accounts.test.js test/actual-transactions.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Refactor `src/routes/transaction.js` to use the extracted helpers**

At the top of `src/routes/transaction.js` (after the existing `const { randomUUID } = require("crypto");` on line 1), add:

```js
const { getAccountByName } = require("../lib/actualAccounts");
const { addTransaction, syncBudget } = require("../lib/actualTransactions");
```

Delete the local `getAccountId` function (current lines 70-74):

```js
const getAccountId = async (fastify, accountName) => {
  const accounts = await fastify.actual.getAccounts();
  const account = accounts.find((acc) => acc.name.toLowerCase() === accountName.toLowerCase());
  return { accountId: account?.id, accounts };
};
```

Update the call site (current line 110) from:

```js
  const { accountId, accounts } = await getAccountId(fastify, accountName);
```

to:

```js
  const { accountId, accounts } = await getAccountByName(fastify, accountName);
```

Replace the add+sync block (current lines 119-149):

```js
    const result = await fastify.actual.addTransactions(accountId, [transaction]);

    if (result !== "ok") {
      const errorMessage = result?.errors ? result.errors.join(", ") : JSON.stringify(result);
      throw new Error(`Failed to add transaction: ${errorMessage}`);
    }

    fastify.log.info("Transaction added successfully");

    // Saving the payee location is best-effort: a failure here must not block
    // the transaction from syncing, so swallow and log rather than 500.
    if (hasLocation) {
      try {
        await savePayeeLocation(fastify, transaction.payee_name, request.body.latitude, request.body.longitude);
      } catch (locErr) {
        request.log.error(`Failed to save payee location: ${locErr.message}`);
      }
    }

    // Explicitly sync to the server so we catch errors (e.g. expired auth)
    // before responding, rather than returning 200 with a silent sync failure
    try {
      await fastify.actual.sync();
      fastify.log.info("Sync completed successfully");
    } catch (syncErr) {
      fastify.log.error(`Sync failed after adding transaction: ${syncErr.message}`);
      return reply.code(500).send({
        error: "Sync failed",
        message: "Transaction was saved locally but failed to sync to the server. It may be lost on restart.",
      });
    }

    return reply.send(transaction);
```

with:

```js
    await addTransaction(fastify, accountId, transaction);

    // Saving the payee location is best-effort: a failure here must not block
    // the transaction from syncing, so swallow and log rather than 500.
    if (hasLocation) {
      try {
        await savePayeeLocation(fastify, transaction.payee_name, request.body.latitude, request.body.longitude);
      } catch (locErr) {
        request.log.error(`Failed to save payee location: ${locErr.message}`);
      }
    }

    // Explicitly sync to the server so we catch errors (e.g. expired auth)
    // before responding, rather than returning 200 with a silent sync failure
    const syncResult = await syncBudget(fastify);
    if (!syncResult.ok) {
      return reply.code(500).send({
        error: "Sync failed",
        message: "Transaction was saved locally but failed to sync to the server. It may be lost on restart.",
      });
    }

    return reply.send(transaction);
```

This is a pure extraction — no behavior or response-shape change.

- [ ] **Step 6: Verify no regression in the mock-based transaction tests**

Run: `node --test test/sync-failure.test.js`
Expected: PASS (all existing tests, unchanged)

Note: `test/transaction.test.js` and `test/initialization.test.js` require a real Actual server (`ACTUAL_URL`, `ACTUAL_PASSWORD`, etc.) which isn't available in a bare sandbox — run those on the VM/CI before merging, but don't block this task on them.

- [ ] **Step 7: Commit**

```bash
git add src/lib/actualAccounts.js src/lib/actualTransactions.js src/routes/transaction.js test/actual-accounts.test.js test/actual-transactions.test.js
git commit -m "Extract shared Actual account/transaction helpers from /transaction route"
```

---

### Task 2: Dedup cache

**Files:**
- Create: `src/lib/dedupCache.js`
- Test: `test/dedup-cache.test.js`

**Interfaces:**
- Produces: `createDedupCache(ttlMs = 600000) => { checkAndMark(key: string) => boolean }` — returns `true` if `key` was already marked within the TTL (duplicate), `false` otherwise (and marks it).

- [ ] **Step 1: Write the failing tests**

Create `test/dedup-cache.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createDedupCache } = require("../src/lib/dedupCache");

describe("createDedupCache", () => {
  it("returns false (not duplicate) the first time a key is seen", () => {
    const cache = createDedupCache();
    assert.strictEqual(cache.checkAndMark("key-1"), false);
  });

  it("returns true (duplicate) when the same key is checked again within the TTL", () => {
    const cache = createDedupCache();
    cache.checkAndMark("key-1");
    assert.strictEqual(cache.checkAndMark("key-1"), true);
  });

  it("treats different keys independently", () => {
    const cache = createDedupCache();
    cache.checkAndMark("key-1");
    assert.strictEqual(cache.checkAndMark("key-2"), false);
  });

  it("returns false again once the TTL has expired", async () => {
    const cache = createDedupCache(10); // 10ms TTL for the test
    cache.checkAndMark("key-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(cache.checkAndMark("key-1"), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/dedup-cache.test.js`
Expected: FAIL — `Cannot find module '../src/lib/dedupCache'`

- [ ] **Step 3: Implement**

Create `src/lib/dedupCache.js`:

```js
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

const createDedupCache = (ttlMs = DEFAULT_TTL_MS) => {
  const expiryByKey = new Map();

  return {
    checkAndMark(key) {
      const now = Date.now();
      const expiresAt = expiryByKey.get(key);

      if (expiresAt !== undefined && expiresAt > now) {
        return true;
      }

      expiryByKey.set(key, now + ttlMs);
      return false;
    },
  };
};

module.exports = { createDedupCache, DEFAULT_TTL_MS };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/dedup-cache.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/dedupCache.js test/dedup-cache.test.js
git commit -m "Add in-memory TTL dedup cache"
```

---

### Task 3: Account resolver

**Files:**
- Create: `src/lib/accountResolver.js`
- Test: `test/account-resolver.test.js`

**Interfaces:**
- Produces: `resolveAccountName(sourceAccountNumber: string, accountMapJson: string|undefined) => string|null` — throws `Error` if `accountMapJson` is not valid JSON.

- [ ] **Step 1: Write the failing tests**

Create `test/account-resolver.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { resolveAccountName } = require("../src/lib/accountResolver");

describe("resolveAccountName", () => {
  it("returns the mapped account name for a known source account number", () => {
    const result = resolveAccountName("8820966012", '{"8820966012":"BIDV Cash"}');
    assert.strictEqual(result, "BIDV Cash");
  });

  it("returns null for an unmapped source account number", () => {
    const result = resolveAccountName("0000000000", '{"8820966012":"BIDV Cash"}');
    assert.strictEqual(result, null);
  });

  it("treats a missing ACCOUNT_MAP as an empty map", () => {
    const result = resolveAccountName("8820966012", undefined);
    assert.strictEqual(result, null);
  });

  it("throws a clear error when ACCOUNT_MAP is not valid JSON", () => {
    assert.throws(() => resolveAccountName("8820966012", "{not json"), /ACCOUNT_MAP is not valid JSON/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/account-resolver.test.js`
Expected: FAIL — `Cannot find module '../src/lib/accountResolver'`

- [ ] **Step 3: Implement**

Create `src/lib/accountResolver.js`:

```js
const resolveAccountName = (sourceAccountNumber, accountMapJson) => {
  let accountMap;
  try {
    accountMap = JSON.parse(accountMapJson || "{}");
  } catch (err) {
    throw new Error(`ACCOUNT_MAP is not valid JSON: ${err.message}`);
  }

  return accountMap[sourceAccountNumber] || null;
};

module.exports = { resolveAccountName };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/account-resolver.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/accountResolver.js test/account-resolver.test.js
git commit -m "Add ACCOUNT_MAP-based account resolver"
```

---

### Task 4: BIDV adapter (expense) + fixture

**Files:**
- Create: `src/adapters/bidv.js`
- Create: `test/fixtures/bidv-expense.txt`
- Test: `test/bidv-adapter.test.js`

**Interfaces:**
- Consumes: nothing (pure module)
- Produces: `bidv = { name: "bidv", match(normalizedText: string) => boolean, parse(normalizedText: string) => { direction: "expense", amount: number, transactionDate: string, referenceCode: string, sourceAccountNumber: string, counterpartyName: string, description: string } }` (`parse` throws `Error` if a required field can't be found, or if the email lacks "Tài khoản nguồn").
- Note: `parse()`/`match()` expect **already-normalized** text (whitespace collapsed to single spaces) — normalization is Task 5's job, not this adapter's.

- [ ] **Step 1: Create the fixture**

Create `test/fixtures/bidv-expense.txt` (real BIDV "Chuyển tiền ngoài BIDV" email, confirmed identical via two independent sources — pasted raw email and exported PDF):

```
Thông báo giao dịch thành công!
Notice of successful transaction
Kính gửi quý khách: PHAM MANH TUONG
Dear Valued Customer: PHAM MANH TUONG
BIDV xin trân trọng cảm ơn Quý khách đã tin tưởng lựa chọn và sử dụng dịch vụ SmartBanking
BIDV thanks you for your trust and using SmartBanking service
BIDV xin thông báo giao dịch của Quý khách đã thực hiện cụ thể như sau:
BIDV is pleased to announce your transaction in details as below:
Loại giao dịch:
Transaction type:
Chuyển tiền ngoài BIDV
Interbank transfer
Thời gian giao dịch:
Transaction time:
04/09/2026 08:41:29
Số tham chiếu:
Reference number:
6247BIDVE2NEKZD1
Tài khoản nguồn:
Debit account:
8820966012
Số tiền giao dịch:
Transaction amount:
10,000 VND
Phí giao dịch:
Transaction fee:
Miễn phí
Tên người thụ hưởng:
Beneficiary name:
PHAM MANH TUONG
Số tài khoản/Số thẻ thụ hưởng:
Beneficiary account/ Card number:
5342999999
Tên ngân hàng thụ hưởng:
Beneficiary bank:
NHTMCP Kỹ Thương Việt Nam (TCB)
Số tiền ghi có:
Credit amount:
10,000 VND
Nội dung giao dịch:
Transaction remark:
PHAM MANH TUONG Chuyen tien
Kênh thực hiện giao dịch:
Channel:
MB
Hệ điều hành:
Operating System:
IOS
IP: 58.187.177.35
Trân trọng!
Regards!
```

- [ ] **Step 2: Write the failing tests**

Create `test/bidv-adapter.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const bidv = require("../src/adapters/bidv");

// The adapter expects normalized (single-spaced) text — inline the same
// collapse logic Task 5 will centralize in src/adapters/index.js, so this
// test doesn't depend on that task's existence.
const normalize = (text) => text.replace(/\s+/g, " ").trim();

const FIXTURE = normalize(fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8"));

describe("BIDV adapter", () => {
  describe("match", () => {
    it("matches a genuine BIDV transaction email", () => {
      assert.strictEqual(bidv.match(FIXTURE), true);
    });

    it("does not match unrelated text", () => {
      assert.strictEqual(bidv.match("Your OTP code is 123456"), false);
    });

    it("does not match a BIDV email missing the reference number label", () => {
      const text = FIXTURE.replace("Số tham chiếu:", "");
      assert.strictEqual(bidv.match(text), false);
    });
  });

  describe("parse", () => {
    it("extracts all fields from a real BIDV expense email", () => {
      const result = bidv.parse(FIXTURE);
      assert.deepStrictEqual(result, {
        direction: "expense",
        amount: 10000,
        transactionDate: "2026-09-04",
        referenceCode: "6247BIDVE2NEKZD1",
        sourceAccountNumber: "8820966012",
        counterpartyName: "PHAM MANH TUONG",
        description: "PHAM MANH TUONG Chuyen tien · Ref: 6247BIDVE2NEKZD1",
      });
    });

    it("throws when Tài khoản nguồn is missing (unsupported income format)", () => {
      const text = FIXTURE.replace("Tài khoản nguồn:", "Tài khoản đích:");
      assert.throws(() => bidv.parse(text), /not supported yet/);
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/bidv-adapter.test.js`
Expected: FAIL — `Cannot find module '../src/adapters/bidv'`

- [ ] **Step 4: Implement**

Create `src/adapters/bidv.js`:

```js
const REQUIRED_MARKERS = [/bidv/i, /Số tham chiếu/, /Số tiền giao dịch/];

const match = (normalizedText) => REQUIRED_MARKERS.every((pattern) => pattern.test(normalizedText));

const extract = (normalizedText, pattern, fieldName) => {
  const found = normalizedText.match(pattern);
  if (!found) {
    throw new Error(`BIDV adapter: could not find "${fieldName}" in rawText`);
  }
  return found;
};

const parse = (normalizedText) => {
  if (!/Tài khoản nguồn/.test(normalizedText)) {
    throw new Error("BIDV incoming-transfer format is not supported yet");
  }

  const referenceCode = extract(
    normalizedText,
    /Số tham chiếu:\s*(?:Reference number:\s*)?([A-Za-z0-9]+)/i,
    "referenceCode"
  )[1];

  const amountMatch = extract(
    normalizedText,
    /Số tiền giao dịch:\s*(?:Transaction amount:\s*)?([\d,.]+)\s*VND/i,
    "amount"
  );
  const amount = parseInt(amountMatch[1].replace(/[.,]/g, ""), 10);

  const [, day, month, year] = extract(
    normalizedText,
    /Thời gian giao dịch:\s*(?:Transaction time:\s*)?(\d{2})\/(\d{2})\/(\d{4})/i,
    "transactionDate"
  );
  const transactionDate = `${year}-${month}-${day}`;

  const sourceAccountNumber = extract(
    normalizedText,
    /Tài khoản nguồn:\s*(?:Debit account:\s*)?(\d+)/i,
    "sourceAccountNumber"
  )[1];

  const counterpartyName = extract(
    normalizedText,
    /Tên người thụ hưởng:\s*(?:Beneficiary name:\s*)?([A-Z][A-Z\s]*?)\s*(?=Số tài khoản)/,
    "counterpartyName"
  )[1].trim();

  const remark = extract(
    normalizedText,
    /Nội dung giao dịch:\s*(?:Transaction remark:\s*)?(.+?)\s*(?=Kênh thực hiện giao dịch)/i,
    "description"
  )[1].trim();

  return {
    direction: "expense",
    amount,
    transactionDate,
    referenceCode,
    sourceAccountNumber,
    counterpartyName,
    description: `${remark} · Ref: ${referenceCode}`,
  };
};

module.exports = { name: "bidv", match, parse };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/bidv-adapter.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/adapters/bidv.js test/bidv-adapter.test.js test/fixtures/bidv-expense.txt
git commit -m "Add BIDV adapter (expense direction) with real-email fixture"
```

---

### Task 5: Adapter registry (`normalize` + `identify`)

**Files:**
- Create: `src/adapters/index.js`
- Test: `test/adapter-registry.test.js`

**Interfaces:**
- Consumes: `require("./bidv")` (Task 4's `{ name, match, parse }`)
- Produces: `normalize(rawText: string) => string`; `identify(normalizedText: string) => adapter|null`

- [ ] **Step 1: Write the failing tests**

Create `test/adapter-registry.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { normalize, identify } = require("../src/adapters");
const bidv = require("../src/adapters/bidv");

const RAW_FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8");

describe("adapters/index", () => {
  describe("normalize", () => {
    it("collapses newlines and repeated whitespace into single spaces", () => {
      assert.strictEqual(normalize("Số tham chiếu:\n\n  6247BIDVE2NEKZD1  "), "Số tham chiếu: 6247BIDVE2NEKZD1");
    });
  });

  describe("identify", () => {
    it("returns the BIDV adapter for a BIDV email", () => {
      const adapter = identify(normalize(RAW_FIXTURE));
      assert.strictEqual(adapter, bidv);
    });

    it("returns null when no adapter matches", () => {
      const adapter = identify(normalize("Your OTP code is 123456"));
      assert.strictEqual(adapter, null);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/adapter-registry.test.js`
Expected: FAIL — `Cannot find module '../src/adapters'`

- [ ] **Step 3: Implement**

Create `src/adapters/index.js`:

```js
const bidv = require("./bidv");

const ADAPTERS = [bidv];

const normalize = (rawText) => rawText.replace(/\s+/g, " ").trim();

const identify = (normalizedText) => ADAPTERS.find((adapter) => adapter.match(normalizedText)) || null;

module.exports = { normalize, identify, ADAPTERS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/adapter-registry.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/index.js test/adapter-registry.test.js
git commit -m "Add adapter registry (normalize + identify)"
```

---

### Task 6: `POST /vietqr-transaction` route

**Files:**
- Create: `src/routes/vietqrTransaction.js`
- Modify: `src/plugins/env.js:11` (add `ACCOUNT_MAP`)
- Modify: `src/server.js:46` (register the route)
- Test: `test/vietqr-transaction.test.js`

**Interfaces:**
- Consumes: `getAccountByName` (Task 1), `addTransaction`/`syncBudget` (Task 1), `createDedupCache` (Task 2), `resolveAccountName` (Task 3), `normalize`/`identify` (Task 5)
- Produces: `POST /vietqr-transaction` route, registered as a Fastify plugin accepting `opts.dedupCache` (defaults to a fresh `createDedupCache()` if not passed — lets tests inject an isolated cache per server instance)

- [ ] **Step 1: Add `ACCOUNT_MAP` to the env schema**

In `src/plugins/env.js`, in the `properties` object (after `ACTUAL_ENCRYPTION_PASSWORD`), add:

```js
    ACCOUNT_MAP: { type: "string", default: "{}" },
```

Do **not** add `ACCOUNT_MAP` to the `required` array — it must stay optional so existing deployments that don't set it keep working.

- [ ] **Step 2: Write the failing route tests**

Create `test/vietqr-transaction.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const fastify = require("fastify");
const { createDedupCache } = require("../src/lib/dedupCache");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8");

async function buildMockServer({
  accountMap = '{"8820966012":"BIDV Cash"}',
  accounts = [{ id: "acc-1", name: "BIDV Cash" }],
  syncBehaviour = "success",
} = {}) {
  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });

  app.decorate("config", { API_KEY: "test-key", ACCOUNT_MAP: accountMap });

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) return;
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== app.config.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  const addedTransactions = [];
  app.decorate("actual", {
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
  });
  app.decorate("addedTransactions", addedTransactions);

  await app.register(require("../src/routes/vietqrTransaction"), { dedupCache: createDedupCache() });

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
    assert.ok(body.notes.includes("6247BIDVE2NEKZD1"));
    assert.strictEqual(app.addedTransactions.length, 1);
    assert.strictEqual(app.addedTransactions[0].accountId, "acc-1");
    await app.close();
  });

  it("returns 400 when no adapter matches", async () => {
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

  it("returns 422 for a BIDV email missing Tài khoản nguồn (unsupported income format)", async () => {
    const app = await buildMockServer();
    const incomeText = FIXTURE.replace("Tài khoản nguồn:", "Tài khoản đích:");
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: incomeText },
    });

    assert.strictEqual(response.statusCode, 422);
    assert.strictEqual(JSON.parse(response.body).error, "Failed to parse transaction");
    await app.close();
  });

  it("returns 400 when the source account is not in ACCOUNT_MAP", async () => {
    const app = await buildMockServer({ accountMap: "{}" });
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
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/vietqr-transaction.test.js`
Expected: FAIL — `Cannot find module '../src/routes/vietqrTransaction'`

- [ ] **Step 4: Implement the route**

Create `src/routes/vietqrTransaction.js`:

```js
const { randomUUID, createHash } = require("crypto");
const { normalize, identify } = require("../adapters");
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

const buildDedupKey = (adapterName, parsed, normalizedText) => {
  if (parsed.referenceCode) {
    return `${adapterName}:ref:${parsed.referenceCode}`;
  }
  const hash = createHash("sha256").update(normalizedText).digest("hex");
  return `${adapterName}:hash:${hash}`;
};

module.exports = async (fastify, opts) => {
  const dedupCache = opts.dedupCache || createDedupCache();

  fastify.post("/vietqr-transaction", vietqrTransactionSchema, async (request, reply) => {
    const normalizedText = normalize(request.body.rawText);

    const adapter = identify(normalizedText);
    if (!adapter) {
      return reply.code(400).send({
        error: "Unrecognized bank format",
        message: "No adapter matched the provided rawText",
      });
    }

    let parsed;
    try {
      parsed = adapter.parse(normalizedText);
    } catch (err) {
      return reply.code(422).send({
        error: "Failed to parse transaction",
        message: err.message,
      });
    }

    const accountName = resolveAccountName(parsed.sourceAccountNumber, fastify.config.ACCOUNT_MAP);
    if (!accountName) {
      return reply.code(400).send({
        error: "Unknown source account",
        message: `Source account "${parsed.sourceAccountNumber}" is not mapped in ACCOUNT_MAP`,
      });
    }

    const dedupKey = buildDedupKey(adapter.name, parsed, normalizedText);
    if (dedupCache.checkAndMark(dedupKey)) {
      return reply.send({ duplicate: true, ...parsed });
    }

    const { accountId, accounts } = await getAccountByName(fastify, accountName);
    if (!accountId) {
      return reply.code(400).send({
        error: "Invalid account",
        message: `Account "${accountName}" not found in Actual. Available accounts: ${accounts.map((a) => a.name).join(", ")}`,
      });
    }

    const signedAmount = parsed.direction === "expense" ? -Math.abs(parsed.amount) : Math.abs(parsed.amount);
    const transaction = {
      id: randomUUID(),
      payee_name: parsed.counterpartyName,
      amount: signedAmount * 100,
      notes: parsed.description,
      date: parsed.transactionDate,
      cleared: false,
    };

    await addTransaction(fastify, accountId, transaction);

    const syncResult = await syncBudget(fastify);
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/vietqr-transaction.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Register the route in the server**

In `src/server.js`, in `registerModules()`, after `await fastify.register(require("./routes/transaction"));`, add:

```js
  await fastify.register(require("./routes/vietqrTransaction"));
```

(before the `./routes/health` registration).

- [ ] **Step 7: Run the full test suite**

Run: `node --test test/*.test.js`
Expected: all new/mock-based tests PASS. `test/transaction.test.js` and `test/initialization.test.js` will fail/skip locally without a real `ACTUAL_URL` — that's expected in a sandbox; run those on the VM/CI where Actual credentials are configured.

- [ ] **Step 8: Commit**

```bash
git add src/routes/vietqrTransaction.js src/plugins/env.js src/server.js test/vietqr-transaction.test.js
git commit -m "Add POST /vietqr-transaction route wiring adapters, account resolution, and dedup"
```

---

## Follow-ups (not in this plan)

- BIDV income adapter (needs a real "Tài khoản nhận"/"Tài khoản đích" email sample).
- Adapters for MB, Vietcombank, ACB, Techcombank.
- Building and testing the iOS Shortcuts Email Trigger end-to-end against the deployed route.
- Verifying the fixture text against rawText captured directly from Shortcuts on-device (noted as a known gap in the spec, §9).
