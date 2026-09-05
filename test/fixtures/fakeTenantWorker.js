process.once("message", (config) => {
  if (config.failInit) {
    process.send({ ready: false, error: "simulated init failure" });
    process.exit(1);
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
