const { describe, it } = require("node:test");
const assert = require("node:assert");
const { resolveAdminUiConfig } = require("../src/lib/adminFeatureFlag");

const FULL_CONFIG = {
  KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
  KEYCLOAK_CLIENT_ID: "actualtap-admin",
  KEYCLOAK_CLIENT_SECRET: "s3cr3t",
  SESSION_SECRET: "a".repeat(32),
  APP_BASE_URL: "https://actualtap.example.com",
};

describe("resolveAdminUiConfig", () => {
  it("returns { enabled: false } when none of the 5 vars are set", () => {
    assert.deepStrictEqual(resolveAdminUiConfig({}), { enabled: false });
  });

  it("returns the full resolved config when all 5 vars are set", () => {
    const result = resolveAdminUiConfig(FULL_CONFIG);
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.issuerUrl, FULL_CONFIG.KEYCLOAK_ISSUER_URL);
    assert.strictEqual(result.clientId, FULL_CONFIG.KEYCLOAK_CLIENT_ID);
    assert.strictEqual(result.clientSecret, FULL_CONFIG.KEYCLOAK_CLIENT_SECRET);
    assert.strictEqual(result.sessionSecret, FULL_CONFIG.SESSION_SECRET);
    assert.strictEqual(result.appBaseUrl, FULL_CONFIG.APP_BASE_URL);
  });

  it("throws naming the missing vars when only some are set", () => {
    const partial = { ...FULL_CONFIG, KEYCLOAK_CLIENT_SECRET: undefined, APP_BASE_URL: undefined };
    assert.throws(
      () => resolveAdminUiConfig(partial),
      /KEYCLOAK_CLIENT_SECRET.*APP_BASE_URL|APP_BASE_URL.*KEYCLOAK_CLIENT_SECRET/
    );
  });

  it("throws when SESSION_SECRET is shorter than 32 characters", () => {
    const shortSecret = { ...FULL_CONFIG, SESSION_SECRET: "too-short" };
    assert.throws(() => resolveAdminUiConfig(shortSecret), /SESSION_SECRET/);
  });
});
