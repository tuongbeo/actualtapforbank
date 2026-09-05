const fastify = require("fastify")({
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
        ignore: "hostname,pid",
        singleLine: false,
        hideObject: false,
      },
    },
  },
  ajv: {
    customOptions: {
      allowUnionTypes: true,
    },
  },
  routerOptions: {
    ignoreTrailingSlash: true,
  },
  pluginTimeout: 120000, // 120 seconds to match Actual API initialization timeout and retries
  // This app never terminates TLS itself -- an `https://` APP_BASE_URL (per the README's
  // documented deployment) implies a reverse proxy in front of it that sets
  // X-Forwarded-Proto. Without trustProxy, request.protocol is always "http", which makes
  // @fastify/session's cookie.secure=true check refuse to ever issue a Set-Cookie behind
  // such a proxy, breaking every admin login ("Invalid state" on /admin/callback).
  trustProxy: true,
});
const { version } = require("../package.json");

async function registerModules() {
  await fastify.register(require("./plugins/env"));

  const { loadTenants } = require("./lib/tenantRegistry");
  const tenants = loadTenants(fastify.config.TENANTS_CONFIG_PATH);
  fastify.log.info(`Loaded ${tenants.length} tenant(s) from ${fastify.config.TENANTS_CONFIG_PATH}`);

  const { spawnAll } = require("./worker/tenantWorkerPool");
  const { clients: workerClients, killAll, children } = await spawnAll(
    tenants.map((t) => ({
      id: t.id,
      actualUrl: fastify.config.ACTUAL_URL,
      password: t.actualPassword,
      syncId: t.actualSyncId,
      encryptionPassword: t.actualEncryptionPassword,
    }))
  );
  fastify.log.info(`All ${tenants.length} tenant worker(s) ready`);

  // Registered immediately once workers are up (rather than at the end of
  // this function) so that if anything below this point throws -- a route
  // registration failure, e.g. -- fastify.close() (called from start()'s
  // catch block, or from the SIGTERM/SIGINT handlers below) still reaches
  // this hook and tears down every already-spawned tenant worker. Without
  // this, a failure partway through registerModules() would orphan them.
  fastify.addHook("onClose", () => {
    killAll();
    fastify.log.info("All tenant workers shut down");
  });

  const { buildTenantLookup, resolveTenant } = require("./lib/tenantAuth");
  const { tenantsById, tenantsByApiKey, tenantsByKeycloakSub } = buildTenantLookup(tenants, workerClients);

  fastify.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?") || request.url.startsWith("/admin")) {
      return;
    }

    const apiKey = request.headers["x-api-key"];
    const tenant = resolveTenant(tenantsByApiKey, apiKey);
    if (!tenant) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    request.tenant = tenant;
  });

  const { resolveAdminUiConfig } = require("./lib/adminFeatureFlag");
  const adminUiConfig = resolveAdminUiConfig(fastify.config);

  if (adminUiConfig.enabled) {
    fastify.log.info("Admin UI enabled");
    await fastify.register(require("@fastify/cookie"));

    // Path-prefix aware: derives "" for a root-domain APP_BASE_URL (e.g.
    // "https://example.com") so the cookie path below becomes "/admin", and
    // e.g. "/app" for "https://example.com/app" so it becomes "/app/admin".
    const basePath = new URL(adminUiConfig.appBaseUrl).pathname.replace(/\/$/, "");
    await fastify.register(require("@fastify/session"), {
      secret: adminUiConfig.sessionSecret,
      // saveUninitialized: false + a cookie path scoped to the admin UI (below) scope
      // session handling to the admin UI only. @fastify/session's hooks otherwise run for
      // EVERY request (this plugin is registered globally), so without this every /health,
      // /transaction, /vietqr-transaction request would leak an unbounded, no-TTL
      // in-memory session and set an unrelated Set-Cookie header.
      saveUninitialized: false,
      cookie: {
        secure: adminUiConfig.appBaseUrl.startsWith("https://"),
        path: `${basePath}/admin`,
        sameSite: "lax",
      },
    });
    await fastify.register(require("./plugins/auth"), { tenantsByKeycloakSub });
    await fastify.register(require("./plugins/staticAdmin"));
    await fastify.register(require("./routes/adminTemplates"));
    await fastify.register(require("./routes/adminAccountMap"));

    const { createTenantProvisioner } = require("./lib/tenantProvisioning");
    const { registerTenant } = createTenantProvisioner({
      tenantsConfigPath: fastify.config.TENANTS_CONFIG_PATH,
      actualUrl: fastify.config.ACTUAL_URL,
      tenantsById,
      tenantsByApiKey,
      tenantsByKeycloakSub,
      onWorkerSpawned: (child) => children.push(child),
    });
    await fastify.register(require("./routes/adminRegister"), { registerTenant });
  } else {
    fastify.log.info("Admin UI disabled (Keycloak env vars not set)");
  }

  await fastify.register(require("@fastify/cors"), {
    methods: ["POST"],
  });

  await fastify.register(require("./routes/transaction"));
  await fastify.register(require("./routes/bankTransfer"));
  await fastify.register(require("./routes/health"));
}

// Global Error Handler
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);
  reply.status(error.statusCode || 500).send({ error: error.message || "An error occurred" });
});

// Graceful shutdown: ensures fastify.close() runs (and with it the onClose
// hook that calls killAll()) on a docker stop / Ctrl-C / systemd stop / PM2
// restart, so tenant worker processes are never left running as orphans.
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info(`Received ${signal}, shutting down`);
  try {
    await fastify.close();
  } catch (err) {
    fastify.log.error(`Error during shutdown: ${err.message}`);
  }
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start the server
const start = async () => {
  try {
    fastify.log.info(`Starting ActualTap v${version}`);
    await registerModules();
    try {
      await fastify.listen({ port: 3001, host: "::" });
    } catch (err) {
      if (err.code === 'EAFNOSUPPORT' || err.message.includes('address family not supported')) {
        fastify.log.warn('IPv6 not supported, falling back to IPv4');
        await fastify.listen({ port: 3001, host: "0.0.0.0" });
      } else {
        throw err;
      }
    }
  } catch (err) {
    fastify.log.error(err);
    // Anything past this point in the try block may have already spawned
    // tenant workers (registerModules() spawns them well before routes are
    // registered or listen() is called) -- go through fastify.close() so the
    // onClose hook's killAll() runs instead of leaking those processes via a
    // bare process.exit(1).
    try {
      await fastify.close();
    } catch (closeErr) {
      fastify.log.error(`Error during shutdown after startup failure: ${closeErr.message}`);
    }
    process.exit(1);
  }
};

start();
