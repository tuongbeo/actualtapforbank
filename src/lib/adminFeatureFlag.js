const REQUIRED_KEYS = [
  "KEYCLOAK_ISSUER_URL",
  "KEYCLOAK_CLIENT_ID",
  "KEYCLOAK_CLIENT_SECRET",
  "SESSION_SECRET",
  "APP_BASE_URL",
];

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

const resolveAdminUiConfig = (config) => {
  const present = REQUIRED_KEYS.filter((k) => isNonEmptyString(config[k]));

  if (present.length === 0) {
    return { enabled: false };
  }

  if (present.length < REQUIRED_KEYS.length) {
    const missing = REQUIRED_KEYS.filter((k) => !isNonEmptyString(config[k]));
    throw new Error(
      `Partial admin UI configuration: missing ${missing.join(", ")}. ` +
        `Set all of ${REQUIRED_KEYS.join(", ")} to enable the admin UI, or none to leave it disabled.`
    );
  }

  if (config.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters long");
  }

  return {
    enabled: true,
    issuerUrl: config.KEYCLOAK_ISSUER_URL,
    clientId: config.KEYCLOAK_CLIENT_ID,
    clientSecret: config.KEYCLOAK_CLIENT_SECRET,
    sessionSecret: config.SESSION_SECRET,
    appBaseUrl: config.APP_BASE_URL,
  };
};

module.exports = { resolveAdminUiConfig, REQUIRED_KEYS };
