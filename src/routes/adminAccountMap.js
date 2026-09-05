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

    // Validate shape: all keys and values must be strings
    if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
      return reply.code(400).send({ error: "Invalid account map", message: "Account map must be an object" });
    }

    for (const [key, value] of Object.entries(request.body)) {
      if (typeof key !== "string" || typeof value !== "string") {
        return reply.code(400).send({ error: "Invalid account map", message: "All keys and values must be strings" });
      }
    }

    try {
      request.tenant.accountMapStore.replaceAll(request.body);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid account map", message: err.message });
    }

    return JSON.parse(request.tenant.accountMapStore.getMapJson());
  });
};
