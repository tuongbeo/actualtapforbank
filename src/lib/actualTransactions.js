const addTransaction = async (fastify, accountId, transaction) => {
  const result = await fastify.actual.addTransactions(accountId, [transaction]);

  if (result !== "ok") {
    const errorMessage = result?.errors ? result.errors.join(", ") : JSON.stringify(result);
    throw new Error(`Failed to add transaction: ${errorMessage}`);
  }

  fastify.log.info("Transaction added successfully");
};

const syncBudget = async (fastify) => {
  try {
    await fastify.actual.sync();
    fastify.log.info("Sync completed successfully");
    return { ok: true };
  } catch (syncErr) {
    fastify.log.error(`Sync failed after adding transaction: ${syncErr.message}`);
    return { ok: false, error: syncErr };
  }
};

module.exports = { addTransaction, syncBudget };
