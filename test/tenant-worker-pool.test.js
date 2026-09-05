const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnAll, spawnOne } = require("../src/worker/tenantWorkerPool");

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

  it("rejects spawnAll and kills every other worker when a tenant exits cleanly (code 0) before reporting ready", async () => {
    await assert.rejects(
      () =>
        spawnAll(
          [
            { id: "alice", tenantId: "alice" },
            { id: "bob", tenantId: "bob", exitCleanBeforeReady: true },
          ],
          FAKE_WORKER_PATH
        ),
      /bob.*exited before becoming ready|exited before becoming ready.*bob/i
    );
  });

  it("rejects spawnAll and kills every other worker when a child process fails to spawn", async () => {
    // Force fork() itself to fail (spawn ENOENT) by pointing execPath at a
    // non-existent binary, which Node surfaces via the child's "error" event
    // rather than "exit" -- the case the exit-code handler alone cannot catch.
    await assert.rejects(
      () =>
        spawnAll(
          [
            { id: "alice", tenantId: "alice" },
            { id: "bob", tenantId: "bob" },
          ],
          FAKE_WORKER_PATH,
          { execPath: "/no/such/node-binary-xyz" }
        ),
      /failed to spawn/i
    );
  });

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
});

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

  // Spec §12: a spawnOne failure must never touch another tenant's already-running worker.
  // This is what makes dynamic self-service registration safe on a live server: a stranger's
  // bad credentials cannot disturb an existing tenant's process (unlike spawnAll, which is
  // deliberately all-or-nothing and kills the whole batch).
  it("a failing spawnOne never touches another tenant's already-running worker", async () => {
    // Two INDEPENDENT spawnOne calls, not one spawnAll batch.
    const { child: aliceChild, client: aliceClient } = await spawnOne(
      { id: "alice", tenantId: "alice" },
      FAKE_WORKER_PATH
    );
    assert.deepStrictEqual(await aliceClient.getAccounts(), [{ id: "acc-alice", name: "Fake" }]);

    await assert.rejects(
      () => spawnOne({ id: "bob", tenantId: "bob", failInit: true }, FAKE_WORKER_PATH),
      /bob.*failed to initialize/i
    );

    // Alice's worker is still alive and still answering real calls.
    assert.strictEqual(aliceChild.exitCode, null);
    assert.strictEqual(aliceChild.signalCode, null);
    assert.strictEqual(aliceChild.connected, true);
    assert.deepStrictEqual(await aliceClient.getAccounts(), [{ id: "acc-alice", name: "Fake" }]);

    aliceChild.kill();
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
