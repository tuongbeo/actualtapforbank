const { randomUUID, createHash } = require("crypto");
const { normalize, identify, extract, AmbiguousMatchError } = require("../templates");
const { resolveAccountName } = require("../lib/accountResolver");
const { createDedupCache } = require("../lib/dedupCache");
const { getAccountByName } = require("../lib/actualAccounts");
const { addTransaction, syncBudget } = require("../lib/actualTransactions");

const vietqrTransactionSchema = {
  schema: {
    body: {
      type: "object",
      properties: {
        rawText: { type: "string", minLength: 1 },
        capturedAt: { type: "string" },
      },
      required: ["rawText"],
    },
  },
};

const buildDedupKey = (templateName, parsed, normalizedText) => {
  if (parsed.referenceCode) {
    return `${templateName}:ref:${parsed.referenceCode}`;
  }
  const hash = createHash("sha256").update(normalizedText).digest("hex");
  return `${templateName}:hash:${hash}`;
};

module.exports = async (fastify, opts) => {
  const dedupCache = opts.dedupCache || createDedupCache();
  const templates = opts.templates || [];

  fastify.post("/vietqr-transaction", vietqrTransactionSchema, async (request, reply) => {
    const normalizedText = normalize(request.body.rawText);

    let template;
    try {
      template = identify(normalizedText, templates);
    } catch (err) {
      if (err instanceof AmbiguousMatchError) {
        return reply.code(500).send({ error: "Ambiguous template match", message: err.message });
      }
      throw err;
    }

    if (!template) {
      return reply.code(400).send({
        error: "Unrecognized bank format",
        message: "No template matched the provided rawText",
      });
    }

    let parsed;
    try {
      parsed = extract(normalizedText, template);
    } catch (err) {
      return reply.code(422).send({
        error: "Failed to parse transaction",
        message: err.message,
      });
    }

    const accountName = resolveAccountName(parsed.sourceAccountNumber, fastify.config.ACCOUNT_MAP);
    if (!accountName) {
      return reply.code(400).send({
        error: "Unknown source account",
        message: `Source account "${parsed.sourceAccountNumber}" is not mapped in ACCOUNT_MAP`,
      });
    }

    const { accountId, accounts } = await getAccountByName(fastify, accountName);
    if (!accountId) {
      return reply.code(400).send({
        error: "Invalid account",
        message: `Account "${accountName}" not found in Actual. Available accounts: ${accounts.map((a) => a.name).join(", ")}`,
      });
    }

    const dedupKey = buildDedupKey(template.name, parsed, normalizedText);
    if (dedupCache.checkAndMark(dedupKey)) {
      return reply.send({ duplicate: true, ...parsed });
    }

    const signedAmount = parsed.direction === "expense" ? -Math.abs(parsed.amount) : Math.abs(parsed.amount);
    const transaction = {
      id: randomUUID(),
      payee_name: parsed.counterpartyName,
      amount: signedAmount * 100,
      notes: parsed.description,
      date: parsed.transactionDate,
      imported_id: parsed.referenceCode,
      cleared: false,
    };

    try {
      await addTransaction(fastify, accountId, transaction);
    } catch (err) {
      dedupCache.unmark(dedupKey);
      throw err;
    }

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
