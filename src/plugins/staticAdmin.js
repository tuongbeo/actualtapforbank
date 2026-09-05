const path = require("node:path");
const fastifyStatic = require("@fastify/static");

module.exports = async (fastify, opts) => {
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, "..", "..", "public", "admin"),
    prefix: "/admin/",
  });
};
