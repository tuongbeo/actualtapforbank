const fastifyEnv = require("@fastify/env");
const fp = require("fastify-plugin");

const schema = {
  type: "object",
  required: ["ACTUAL_URL"],
  properties: {
    ACTUAL_URL: { type: "string" },
    TENANTS_CONFIG_PATH: { type: "string", default: "config/tenants.json" },
  },
};

const options = {
  schema: schema,
  data: process.env,
};

module.exports = fp(async (fastify, opts) => {
  try {
    await fastify.register(fastifyEnv, options);
  } catch (error) {
    fastify.log.error(`Failed to register environment variables: ${error.message}`);
    throw error;
  }
});
