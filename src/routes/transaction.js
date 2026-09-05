const { randomUUID } = require("crypto");
const { parseAmount } = require("../lib/parseAmount");
const { getAccountByName } = require("../lib/actualAccounts");
const { addTransaction, syncBudget } = require("../lib/actualTransactions");

const transactionSchema = {
  schema: {
    body: {
      type: "object",
      properties: {
        amount: { type: ["number", "string"], default: 0 },
        payee: { type: "string", default: "Unknown" },
        account: { type: "string" },
        notes: { type: "string" },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        type: {
          type: "string",
          enum: ["payment", "deposit"],
          default: "payment",
        },
      },
      required: ["account"],
    },
  },
};

// The schema pattern guarantees YYYY-MM-DD shape; this catches impossible
// dates like 2026-02-31 that a Date round-trip silently rolls over
const isValidDate = (dateStr) => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const createTransaction = (request) => {
  const { payee, amount: rawAmount, notes, date, type = "payment" } = request.body;
  const amount = typeof rawAmount === "string" ? parseAmount(rawAmount) : rawAmount;
  const isDeposit = type === "deposit";
  const transactionAmount = amount !== undefined && !isNaN(amount) ? Math.round(amount * 100) * (isDeposit ? 1 : -1) : 0;

  return {
    id: randomUUID(),
    payee_name: payee || "Unknown",
    amount: transactionAmount,
    notes: notes || "",
    date: date || new Date().toLocaleDateString('en-CA'),
    cleared: false,
  };
};

const savePayeeLocation = async (fastify, payeeName, latitude, longitude) => {
  const payee = (await fastify.actual.getPayees()).find(
    ({ name }) => name.toLowerCase() === payeeName.trim().toLowerCase()
  );
  if (!payee) return;

  const nearby = await fastify.actualInternal.send("api/payees-get-nearby", {
    latitude,
    longitude,
    maxDistance: 500,
  });
  if (!nearby.some(({ location }) => location.payee_id === payee.id)) {
    await fastify.actualInternal.send("api/payee-location-create", { payeeId: payee.id, latitude, longitude });
  }
};

module.exports = async (fastify, opts) => {
  fastify.post("/transaction", transactionSchema, async (request, reply) => {
    request.log.info(`Received transaction request with body: ${JSON.stringify(request.body)}`);

    const hasLocation = request.body.latitude !== undefined || request.body.longitude !== undefined;
    if (hasLocation && (request.body.latitude === undefined || request.body.longitude === undefined)) {
      return reply.code(400).send({ error: "Invalid location", message: "latitude and longitude must be provided together" });
    }

    if (request.body.date && !isValidDate(request.body.date)) {
      return reply.code(400).send({
        error: "Invalid date",
        message: `"${request.body.date}" is not a valid calendar date. Expected format: YYYY-MM-DD`,
      });
    }

    const transaction = createTransaction(request);
    const accountName = request.body.account;
    const { accountId, accounts } = await getAccountByName(fastify, accountName);

    if (!accountId) {
      return reply.code(400).send({
        error: "Invalid account",
        message: `Account "${accountName}" not found. Available accounts: ${accounts.map((a) => a.name).join(", ")}`,
      });
    }

    await addTransaction(fastify, accountId, transaction);

    // Saving the payee location is best-effort: a failure here must not block
    // the transaction from syncing, so swallow and log rather than 500.
    if (hasLocation) {
      try {
        await savePayeeLocation(fastify, transaction.payee_name, request.body.latitude, request.body.longitude);
      } catch (locErr) {
        request.log.error(`Failed to save payee location: ${locErr.message}`);
      }
    }

    // Explicitly sync to the server so we catch errors (e.g. expired auth)
    // before responding, rather than returning 200 with a silent sync failure
    const syncResult = await syncBudget(fastify);
    if (!syncResult.ok) {
      return reply.code(500).send({
        error: "Sync failed",
        message: "Transaction was saved locally but failed to sync to the server. It may be lost on restart.",
      });
    }

    return reply.send(transaction);
  });
};
