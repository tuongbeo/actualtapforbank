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
