const path = require("node:path");
const fastifyStatic = require("@fastify/static");

module.exports = async (fastify, opts) => {
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, "..", "..", "public", "admin"),
    prefix: "/admin/",
  });

  // With the real server's routerOptions.ignoreTrailingSlash: true, @fastify/static's
  // directory-index behavior for its "/admin/" prefix does not correctly serve index.html for
  // a normalized "GET /admin/" (or "GET /admin") request -- both 404 without this, only
  // "GET /admin/index.html" works. This is the documented entry point and the default
  // post-login redirect target, so an explicit route is needed to actually serve it.
  fastify.get("/admin", (request, reply) => reply.sendFile("index.html"));
};
