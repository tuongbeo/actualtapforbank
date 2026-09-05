const actual = require("@actual-app/api");
const fp = require("fastify-plugin");
const { connectToActual } = require("../lib/actualConnectorInit");

const actualConnector = fp(async (fastify) => {
  const { ACTUAL_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID, ACTUAL_ENCRYPTION_PASSWORD } = fastify.config;

  const { actualInternal } = await connectToActual({
    actualUrl: ACTUAL_URL,
    password: ACTUAL_PASSWORD,
    syncId: ACTUAL_SYNC_ID,
    encryptionPassword: ACTUAL_ENCRYPTION_PASSWORD,
    logger: fastify.log,
  });

  fastify.decorate("actual", actual);
  fastify.decorate("actualInternal", actualInternal);

  fastify.addHook("onClose", async () => {
    try {
      await actual.shutdown();
      fastify.log.info("Actual API shut down");
    } catch (err) {
      fastify.log.error(`Cleanup error: ${err.message}`);
    }
  });
});

module.exports = actualConnector;
