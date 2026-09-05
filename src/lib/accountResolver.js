const resolveAccountName = (sourceAccountNumber, accountMapJson) => {
  let accountMap;
  try {
    accountMap = JSON.parse(accountMapJson || "{}");
  } catch (err) {
    throw new Error("ACCOUNT_MAP is not valid JSON");
  }

  return accountMap[sourceAccountNumber] || null;
};

module.exports = { resolveAccountName };
