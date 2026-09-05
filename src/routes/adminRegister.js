// src/routes/adminRegister.js
module.exports = async (fastify, opts) => {
  const { registerTenant } = opts;

  fastify.get("/admin/api/me", async (request) => {
    return { registered: Boolean(request.tenant) };
  });

  fastify.post("/admin/api/register", async (request, reply) => {
    if (request.tenant) {
      return reply.code(409).send({ error: "Tenant already exists" });
    }

    const { actualSyncId, actualPassword, actualEncryptionPassword } = request.body || {};
    if (!actualSyncId || !actualPassword) {
      return reply.code(400).send({ error: "actualSyncId and actualPassword are required" });
    }

    const result = await registerTenant({
      keycloakSub: request.session.userSub,
      actualSyncId,
      actualPassword,
      actualEncryptionPassword,
    });

    if (!result.ok) {
      return reply.code(result.code).send({ error: result.error, message: result.message });
    }

    return reply.code(201).send({ id: result.id, apiKey: result.apiKey });
  });
};
