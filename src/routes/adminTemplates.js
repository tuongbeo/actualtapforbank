const { normalize, identify, extract } = require("../templates");
const { validateTemplates } = require("../templates/schema");

module.exports = async (fastify, opts) => {
  fastify.get("/admin/api/templates", async (request, reply) => {
    if (!request.tenant) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return request.tenant.templatesStore.getTemplates();
  });

  fastify.post("/admin/api/templates", async (request, reply) => {
    if (!request.tenant) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const templates = request.tenant.templatesStore.getTemplates();
    const newTemplate = request.body;

    if (templates.some((t) => t.name === newTemplate.name)) {
      return reply.code(409).send({ error: "Template already exists" });
    }

    const next = [...templates, newTemplate];

    try {
      // Validate the full resulting array here (rather than trusting the store to
      // reject an invalid write) so a mock/store that never validates still surfaces
      // a 400 for an invalid template, same as the real templatesStore does internally.
      validateTemplates(next);
      request.tenant.templatesStore.replaceAll(next);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid template", message: err.message });
    }

    return newTemplate;
  });

  fastify.put("/admin/api/templates/:name", async (request, reply) => {
    if (!request.tenant) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const templates = request.tenant.templatesStore.getTemplates();
    const index = templates.findIndex((t) => t.name === request.params.name);
    if (index === -1) {
      return reply.code(404).send({ error: "Template not found" });
    }

    const next = [...templates];
    next[index] = request.body;

    try {
      // Validating the full array (not just the one edited entry) catches a rename
      // that collides with another existing entry's name, in addition to a shape error.
      validateTemplates(next);
      request.tenant.templatesStore.replaceAll(next);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid template", message: err.message });
    }

    return request.body;
  });

  fastify.delete("/admin/api/templates/:name", async (request, reply) => {
    if (!request.tenant) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const templates = request.tenant.templatesStore.getTemplates();
    const index = templates.findIndex((t) => t.name === request.params.name);
    if (index === -1) {
      return reply.code(404).send({ error: "Template not found" });
    }

    const next = templates.filter((_, i) => i !== index);
    request.tenant.templatesStore.replaceAll(next); // removing an entry can't introduce a new validation error

    return { ok: true };
  });

  fastify.post("/admin/api/preview", async (request, reply) => {
    const { rawText, template } = request.body;

    try {
      validateTemplates([template]);
    } catch (err) {
      return reply.code(400).send({ error: "Invalid template", message: err.message });
    }

    const normalizedText = normalize(rawText);
    const matched = identify(normalizedText, [template]); // single-element array: never throws AmbiguousMatchError

    if (!matched) {
      return { matched: false };
    }

    try {
      const parsed = extract(normalizedText, matched);
      return { matched: true, parsed };
    } catch (err) {
      return { matched: true, error: err.message };
    }
  });
};
