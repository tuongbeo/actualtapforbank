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
});
const { version } = require("../package.json");

async function registerModules() {
  await fastify.register(require("./plugins/env"));

  const { loadTenants } = require("./lib/tenantRegistry");
  const tenants = loadTenants(fastify.config.TENANTS_CONFIG_PATH);
  fastify.log.info(`Loaded ${tenants.length} tenant(s) from ${fastify.config.TENANTS_CONFIG_PATH}`);

  const { spawnAll } = require("./worker/tenantWorkerPool");
  const { clients: workerClients, killAll } = await spawnAll(
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
  const { tenantsByApiKey, tenantsByKeycloakSub } = buildTenantLookup(tenants, workerClients);

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
    await fastify.register(require("@fastify/session"), {
      secret: adminUiConfig.sessionSecret,
      cookie: { secure: adminUiConfig.appBaseUrl.startsWith("https://") },
    });
    await fastify.register(require("./plugins/auth"), { tenantsByKeycloakSub });
    await fastify.register(require("./plugins/staticAdmin"));
    await fastify.register(require("./routes/adminTemplates"));
  } else {
    fastify.log.info("Admin UI disabled (Keycloak env vars not set)");
  }

  await fastify.register(require("@fastify/cors"), {
    methods: ["POST"],
  });

  await fastify.register(require("./routes/transaction"));
  await fastify.register(require("./routes/vietqrTransaction"));
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
