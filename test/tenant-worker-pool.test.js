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
});
