const getAccountByName = async (fastify, accountName) => {
  const accounts = await fastify.actual.getAccounts();
  const account = accounts.find((acc) => acc.name.toLowerCase() === accountName.toLowerCase());
  return { accountId: account?.id, accounts };
};

module.exports = { getAccountByName };
