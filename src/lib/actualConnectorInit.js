const actual = require("@actual-app/api");
const os = require("os");
const path = require("path");
const fs = require("fs");

const validateUrl = (url) => {
  if (!url || typeof url !== "string") {
    throw new Error("ACTUAL_URL is not a valid string");
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("ACTUAL_URL must use http:// or https:// protocol");
    }
    return url.replace(/\/+$/, "");
  } catch (err) {
    throw new Error(`Invalid ACTUAL_URL format: ${err.message}`);
  }
};

const verifyConnectivity = async (url) => {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (response.status < 200 || response.status >= 400) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new Error("Connection timed out - check if server is accessible");
    }
    if (err.cause?.code === "ENOTFOUND") {
      throw new Error("Cannot resolve hostname - check if ACTUAL_URL is correct");
    }
    if (err.cause?.code === "ECONNREFUSED") {
      throw new Error("Connection refused - check if server is running");
    }
    throw new Error(`Network error: ${err.message}`);
  }
};

const initializeActual = async (serverURL, password, timeoutMs) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "actualtap-"));

  try {
    return await Promise.race([
      actual.init({ dataDir, serverURL, password }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs)),
    ]);
  } catch (err) {
    if (err.message === "TIMEOUT") {
      throw new Error(`Initialization timed out after ${timeoutMs / 1000} seconds`);
    }
    throw new Error(`Failed to initialize Actual API: ${err.message}`);
  }
};

const verifyAuthentication = async () => {
  try {
    const budgets = await actual.getBudgets();
    if (!budgets || budgets.length === 0) {
      throw new Error("ACTUAL_PASSWORD is incorrect (no budgets found)");
    }
    return budgets;
  } catch (err) {
    throw new Error(`Authentication failed: ${err.message}`);
  }
};

const verifyBudgetExists = (budgets, syncId) => {
  const budget = budgets.find((b) => b.groupId === syncId);
  if (!budget) {
    const availableIds = budgets.map((b) => b.groupId).join(", ");
    throw new Error(`Budget '${syncId}' not found. Available: ${availableIds}`);
  }
  return budget;
};

const downloadBudget = async (syncId, encryptionPassword, logger, maxRetries, retryDelay) => {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`Downloading budget (attempt ${attempt}/${maxRetries})`);

      if (encryptionPassword) {
        await actual.downloadBudget(syncId, { password: encryptionPassword });
      } else {
        await actual.downloadBudget(syncId);
      }

      return;
    } catch (err) {
      lastError = err;

      if (err.message?.includes("decrypt") || err.message?.includes("encryption")) {
        throw new Error(`ACTUAL_ENCRYPTION_PASSWORD is incorrect: ${err.message}`);
      }

      logger.warn(`Budget download attempt ${attempt}/${maxRetries} failed: ${err.message || err.reason || err}`);

      if (attempt < maxRetries) {
        logger.info(`Retrying in ${retryDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  throw new Error(
    `Failed to download budget after ${maxRetries} attempts: ${lastError.message || lastError.reason || lastError}`
  );
};

const verifyBudgetOpen = async () => {
  try {
    await actual.getAccounts();
  } catch (err) {
    if (err.message?.includes("No budget file is open")) {
      throw new Error(
        "Budget failed to open. This is likely due to a version mismatch between ActualTap and your Actual Budget server. " +
          "Please ensure ActualTap is updated to match your Actual Budget server version."
      );
    }
    throw new Error(`Failed to verify budget: ${err.message}`);
  }
};

const connectToActual = async ({ actualUrl, password, syncId, encryptionPassword, logger }) => {
  const TIMEOUT = 30000;
  const RETRY_COUNT = 3;
  const RETRY_DELAY = 2000;

  logger.info("Initializing Actual connector");

  const url = validateUrl(actualUrl);
  logger.info(`Connecting to: ${url}`);

  await verifyConnectivity(url);
  logger.info("Server is reachable");

  const actualInternal = await initializeActual(url, password, TIMEOUT);
  logger.info("Actual API initialized");

  const budgets = await verifyAuthentication();
  logger.info(`Authenticated - found ${budgets.length} budget(s)`);

  const budget = verifyBudgetExists(budgets, syncId);
  logger.info(`Budget found: ${budget.name || budget.groupId}`);

  await downloadBudget(syncId, encryptionPassword, logger, RETRY_COUNT, RETRY_DELAY);

  await verifyBudgetOpen();
  logger.info("Budget downloaded and verified successfully");

  return { actualInternal };
};

module.exports = { connectToActual };
