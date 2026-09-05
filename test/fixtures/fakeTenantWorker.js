process.once("message", (config) => {
  if (config.failInit) {
    process.send({ ready: false, error: "simulated init failure" });
    process.exit(1);
    return;
  }

  if (config.hangForever) {
    // Simulates an Actual connection that never completes (e.g. downloadBudget never
    // resolves): the process stays alive and healthy but never reports ready OR failure, so
    // spawnOne's promise never settles on its own. Keeps a handle open so the child does not
    // exit on its own and end the hang prematurely.
    setInterval(() => {}, 1 << 30);
    return;
  }

  if (config.exitCleanBeforeReady) {
    // Simulates a worker that exits normally (code 0) without ever sending
    // { ready: true } or { ready: false } -- e.g. a malformed worker script
    // or an early clean return. This must still be treated as a failure to
    // become ready.
    process.exit(0);
    return;
  }

  process.send({ ready: true });

  process.on("message", (msg) => {
    // The pool's actualInternalSend() wraps the inner method as
    // { method: "actualInternalSend", args: [innerMethod, params] },
    // mirroring the real workerProtocol.js dispatch (Task 3). Unwrap it
    // here so this fake responds to the same effective method the real
    // worker would.
    const effectiveMethod = msg.method === "actualInternalSend" ? msg.args[0] : msg.method;

    if (effectiveMethod === "getAccounts") {
      process.send({ requestId: msg.requestId, result: [{ id: `acc-${config.tenantId}`, name: "Fake" }] });
    } else if (effectiveMethod === "boom") {
      process.send({ requestId: msg.requestId, error: { message: "simulated failure" } });
    } else {
      process.send({ requestId: msg.requestId, result: null });
    }
  });
});
