const { describe, it } = require("node:test");
const assert = require("node:assert");
const actual = require("@actual-app/api");
const { connectToActual } = require("../src/lib/actualConnectorInit");

const logger = { info: () => {}, warn: () => {}, error: () => {} };

async function connectWithOverrides(overrides) {
  try {
    await connectToActual({
      actualUrl: process.env.ACTUAL_URL,
      password: process.env.ACTUAL_PASSWORD,
      syncId: process.env.ACTUAL_SYNC_ID,
      encryptionPassword: process.env.ACTUAL_ENCRYPTION_PASSWORD,
      logger,
      ...overrides,
    });
  } finally {
    try { await actual.shutdown(); } catch {}
  }
}

describe("Initialization failures", () => {
  it("should fail with invalid ACTUAL_URL", async () => {
    await assert.rejects(
      () => connectWithOverrides({ actualUrl: "not-a-valid-url" }),
      (err) => {
        assert.ok(
          err.message.includes("Invalid ACTUAL_URL") || err.message.includes("URL"),
          `Expected URL error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("should fail with wrong ACTUAL_PASSWORD", async () => {
    await assert.rejects(
      () => connectWithOverrides({ password: "definitely-wrong-password-12345" }),
      (err) => {
        assert.ok(
          err.message.includes("password") ||
            err.message.includes("Authentication") ||
            err.message.includes("auth"),
          `Expected auth error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("should fail with invalid ACTUAL_SYNC_ID", async () => {
    await assert.rejects(
      () => connectWithOverrides({ syncId: "00000000-0000-0000-0000-000000000000" }),
      (err) => {
        assert.ok(
          err.message.includes("not found") ||
          err.message.includes("Budget") ||
          err.message.toLowerCase().includes("budget"),
          `Expected budget-related error, got: ${err.message}`
        );
        return true;
      }
    );
  });
});
