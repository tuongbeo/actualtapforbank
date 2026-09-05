const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const { resolveAdminUiConfig } = require("../src/lib/adminFeatureFlag");

async function buildApp(config) {
  const app = fastify({ logger: false });
  app.decorate("config", config);

  const adminUiConfig = resolveAdminUiConfig(app.config);
  if (adminUiConfig.enabled) {
    await app.register(require("@fastify/cookie"));
    await app.register(require("@fastify/session"), {
      secret: adminUiConfig.sessionSecret,
      cookie: { secure: false },
    });
    await app.register(require("../src/plugins/auth"), {
      oidcClient: {
        authorizationUrl: () => "https://keycloak.example.com/auth?mock=1",
        callback: async () => ({ claims: () => ({ sub: "sub-nobody" }) }),
        endSessionUrl: null,
      },
      tenantsByKeycloakSub: new Map(),
    });
    await app.register(require("../src/plugins/staticAdmin"));
    await app.register(require("../src/routes/adminTemplates"));
  }

  return app;
}

describe("admin UI conditional registration (mirrors server.js's registerModules())", () => {
  it("with none of the 5 Keycloak env vars set, /admin/ 404s and the app still starts", async () => {
    const app = await buildApp({});
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/admin/" });
    assert.strictEqual(response.statusCode, 404);
    await app.close();
  });

  it("with all 5 set, /admin/ is served (guard redirects to login instead of 404)", async () => {
    const app = await buildApp({
      KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual",
      KEYCLOAK_CLIENT_ID: "actualtap-admin",
      KEYCLOAK_CLIENT_SECRET: "secret",
      SESSION_SECRET: "a".repeat(32),
      APP_BASE_URL: "https://actualtap.example.com",
    });
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/admin/" });
    assert.strictEqual(response.statusCode, 302);
    await app.close();
  });

  it("with only some of the 5 set, the app fails to start with a clear error", async () => {
    await assert.rejects(
      () => buildApp({ KEYCLOAK_ISSUER_URL: "https://keycloak.example.com/realms/actual" }),
      /Partial admin UI configuration/
    );
  });
});
