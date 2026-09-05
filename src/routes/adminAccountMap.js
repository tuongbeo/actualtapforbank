// src/routes/adminAccountMap.js
module.exports = async (fastify, opts) => {
  fastify.get("/admin/api/account-map", async (request, reply) => {
    if (!request.tenant) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return JSON.parse(request.tenant.accountMapStore.getMapJson());
  });

  fastify.put("/admin/api/account-map", async (request, reply) => {
    if (!request.tenant) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      request.tenant.accountMapStore.replaceAll(request.body);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid account map", message: err.message });
    }

    return JSON.parse(request.tenant.accountMapStore.getMapJson());
  });
};
