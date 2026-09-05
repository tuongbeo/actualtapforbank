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
