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
    deleteTransaction: (id) => actual.deleteTransaction(id),
    sync: () => actual.sync(),
    actualInternalSend: (method, params) => actualInternal.send(method, params),
  };
  const handleMessage = createMessageHandler(actualClient);

  process.send({ ready: true });

  process.on("message", async (message) => {
    const reply = await handleMessage(message);
    process.send(reply);
  });

  // The parent's killAll() sends SIGTERM to tear this worker down (e.g. on
  // server shutdown or restart). Without this handler the process dies
  // immediately, leaking whatever Actual has open/buffered -- mirrors the
  // onClose hook the deleted actualConnector.js plugin used to run.
  process.on("SIGTERM", async () => {
    try {
      await actual.shutdown();
      logger.info("Actual API shut down");
    } catch (err) {
      logger.error(`Cleanup error: ${err.message}`);
    }
    process.exit(0);
  });
});
