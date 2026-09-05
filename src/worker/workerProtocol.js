const METHODS = {
  getAccounts: (client) => client.getAccounts(),
  getPayees: (client) => client.getPayees(),
  addTransactions: (client, args) => client.addTransactions(...args),
  deleteTransaction: (client, args) => client.deleteTransaction(...args),
  sync: (client) => client.sync(),
  actualInternalSend: (client, args) => client.actualInternalSend(...args),
};

const createMessageHandler = (actualClient) => async (message) => {
  const { requestId, method, args = [] } = message;
  const handler = METHODS[method];

  if (!handler) {
    return { requestId, error: { message: `Unknown method "${method}"` } };
  }

  try {
    const result = await handler(actualClient, args);
    return { requestId, result };
  } catch (err) {
    return { requestId, error: { message: err.message } };
  }
};

module.exports = { createMessageHandler };
