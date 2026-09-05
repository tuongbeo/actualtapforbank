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
