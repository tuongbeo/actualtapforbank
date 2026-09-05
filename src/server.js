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

// Modular function registrations
async function registerModules() {
  await fastify.register(require("./plugins/env"));

  // Global authentication hook - registered after env to access fastify.config
  fastify.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) {
      return;
    }

    const apiKey = request.headers["x-api-key"];
    if (apiKey !== fastify.config.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
  });

  await fastify.register(require("@fastify/cors"), {
    methods: ["POST"],
  });
  // Load and validate templates before the (slow) Actual connection so a bad
  // config/templates.json fails fast instead of after the connector timeout.
  const { loadTemplates } = require("./templates");
  const templatesConfigPath = fastify.config.TEMPLATES_CONFIG_PATH;
  const templates = loadTemplates(templatesConfigPath);
  fastify.log.info(`Loaded ${templates.length} notification template(s) from ${templatesConfigPath}`);
  if (templates.length === 0) {
    fastify.log.warn(`No notification templates loaded from ${templatesConfigPath} - /vietqr-transaction will reject all requests`);
  }

  await fastify.register(require("./plugins/actualConnector"));
  await fastify.register(require("./routes/transaction"));
  await fastify.register(require("./routes/vietqrTransaction"), { templates });

  await fastify.register(require("./routes/health"));
}

// Global Error Handler
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);
  reply.status(error.statusCode || 500).send({ error: error.message || "An error occurred" });
});

// Start the server
const start = async () => {
  try {
    fastify.log.info(`Starting ActualTap v${version}`);
    await registerModules();
    try {
      // Try IPv6 dual-stack first
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
    process.exit(1);
  }
};

start();