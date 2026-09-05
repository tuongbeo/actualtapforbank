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

  // Once the ready-handshake has completed (this function is only called
  // after that point), the child dying is no longer a startup failure for
  // spawnAll to reject -- it's a runtime failure for THIS client. Without
  // this, every in-flight call hangs forever (no reply is ever coming) and
  // every future call would hang too, since child.send() on a dead/
  // disconnected child never produces a reply either.
  child.once("exit", (code, signal) => {
    rejectAllPending(new Error(`Tenant worker process exited unexpectedly (code ${code}, signal ${signal})`));
  });
  child.once("disconnect", () => {
    rejectAllPending(new Error("Tenant worker process disconnected unexpectedly"));
  });
  // The startup-phase "error" handler (in spawnAll) no-ops post-handshake by
  // design; this is the post-handshake counterpart so a mid-operation IPC
  // error still surfaces as a rejection instead of a silent hang.
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

const spawnAll = (tenants, workerPath = DEFAULT_WORKER_PATH, forkOptions = {}) => {
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
      const child = fork(workerPath, [], forkOptions);
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

      child.once("exit", (code, signal) => {
        // Any exit before the ready handshake completes means this tenant
        // never became ready, regardless of its exit code (a clean code-0
        // exit before "ready" is just as much a failure as a crash).
        if (settled) return;
        settled = true;
        killAll();
        reject(
          new Error(`Tenant "${tenant.id}" worker exited before becoming ready (code ${code}, signal ${signal})`)
        );
      });

      child.on("error", (err) => {
        // Emitted e.g. when fork() itself fails to spawn the process, or the
        // IPC channel errors out. Never surfaces via "exit" in that case, so
        // it needs its own handler to preserve the no-leaked-processes
        // guarantee.
        if (settled) return;
        settled = true;
        killAll();
        reject(new Error(`Tenant "${tenant.id}" worker failed to spawn: ${err.message}`));
      });

      child.send(tenant);
    });
  });
};

module.exports = { spawnAll };
