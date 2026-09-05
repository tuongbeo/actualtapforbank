const { describe, it } = require("node:test");
const assert = require("node:assert");
const fastify = require("fastify");
const adminTemplatesPlugin = require("../src/routes/adminTemplates");

const TEMPLATE_A = {
  name: "a",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["Foo"] },
  fields: { x: { label: "Foo:", stopLabel: "$END$" } },
  requiredFields: ["x"],
};

function fakeTemplatesStore(initial) {
  let templates = initial;
  return {
    getTemplates: () => templates,
    replaceAll: (next) => {
      templates = next;
    },
  };
}

async function buildApp({ templates = [TEMPLATE_A], setTenant = true } = {}) {
  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });
  const templatesStore = fakeTemplatesStore(templates);
  if (setTenant) {
    app.addHook("preHandler", async (request) => {
      request.tenant = { id: "alice", templatesStore };
    });
  }
  await app.register(adminTemplatesPlugin);
  return { app, templatesStore };
}

describe("GET /admin/api/templates", () => {
  it("returns the tenant's current templates", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/admin/api/templates" });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), [TEMPLATE_A]);
    await app.close();
  });
});

describe("POST /admin/api/templates", () => {
  it("appends a new template", async () => {
    const { app, templatesStore } = await buildApp({ templates: [] });
    const newTemplate = { ...TEMPLATE_A, name: "b" };
    const response = await app.inject({ method: "POST", url: "/admin/api/templates", payload: newTemplate });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(templatesStore.getTemplates(), [newTemplate]);
    await app.close();
  });

  it("returns 409 when the name already exists", async () => {
    const { app } = await buildApp({ templates: [TEMPLATE_A] });
    const response = await app.inject({ method: "POST", url: "/admin/api/templates", payload: TEMPLATE_A });
    assert.strictEqual(response.statusCode, 409);
    assert.strictEqual(JSON.parse(response.body).error, "Template already exists");
    await app.close();
  });

  it("returns 400 with the validation message when the new template is invalid", async () => {
    const { app } = await buildApp({ templates: [] });
    const response = await app.inject({ method: "POST", url: "/admin/api/templates", payload: { name: "bad" } });
    assert.strictEqual(response.statusCode, 400);
    await app.close();
  });
});

describe("PUT /admin/api/templates/:name", () => {
  it("replaces the existing entry", async () => {
    const { app, templatesStore } = await buildApp({ templates: [TEMPLATE_A] });
    const updated = { ...TEMPLATE_A, direction: "income" };
    const response = await app.inject({ method: "PUT", url: "/admin/api/templates/a", payload: updated });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(templatesStore.getTemplates(), [updated]);
    await app.close();
  });

  it("returns 404 when :name doesn't match any existing entry", async () => {
    const { app } = await buildApp({ templates: [TEMPLATE_A] });
    const response = await app.inject({ method: "PUT", url: "/admin/api/templates/nonexistent", payload: TEMPLATE_A });
    assert.strictEqual(response.statusCode, 404);
    await app.close();
  });

  it("returns 400 when renaming to a name that collides with a different entry", async () => {
    const templateB = { ...TEMPLATE_A, name: "b" };
    const { app } = await buildApp({ templates: [TEMPLATE_A, templateB] });
    const renamed = { ...TEMPLATE_A, name: "b" }; // renaming "a" to the already-existing "b"
    const response = await app.inject({ method: "PUT", url: "/admin/api/templates/a", payload: renamed });
    assert.strictEqual(response.statusCode, 400);
    await app.close();
  });
});

describe("DELETE /admin/api/templates/:name", () => {
  it("removes the matching entry", async () => {
    const { app, templatesStore } = await buildApp({ templates: [TEMPLATE_A] });
    const response = await app.inject({ method: "DELETE", url: "/admin/api/templates/a" });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(templatesStore.getTemplates(), []);
    await app.close();
  });

  it("returns 404 when :name doesn't match any existing entry", async () => {
    const { app } = await buildApp({ templates: [TEMPLATE_A] });
    const response = await app.inject({ method: "DELETE", url: "/admin/api/templates/nonexistent" });
    assert.strictEqual(response.statusCode, 404);
    await app.close();
  });
});

describe("unauthenticated request (no request.tenant set)", () => {
  it("GET /admin/api/templates returns 401", async () => {
    const { app } = await buildApp({ setTenant: false });
    const response = await app.inject({ method: "GET", url: "/admin/api/templates" });
    assert.strictEqual(response.statusCode, 401);
    assert.strictEqual(JSON.parse(response.body).error, "Unauthorized");
    await app.close();
  });

  it("POST /admin/api/templates returns 401", async () => {
    const { app } = await buildApp({ setTenant: false });
    const response = await app.inject({ method: "POST", url: "/admin/api/templates", payload: TEMPLATE_A });
    assert.strictEqual(response.statusCode, 401);
    assert.strictEqual(JSON.parse(response.body).error, "Unauthorized");
    await app.close();
  });

  it("PUT /admin/api/templates/:name returns 401", async () => {
    const { app } = await buildApp({ setTenant: false });
    const response = await app.inject({ method: "PUT", url: "/admin/api/templates/a", payload: TEMPLATE_A });
    assert.strictEqual(response.statusCode, 401);
    assert.strictEqual(JSON.parse(response.body).error, "Unauthorized");
    await app.close();
  });

  it("DELETE /admin/api/templates/:name returns 401", async () => {
    const { app } = await buildApp({ setTenant: false });
    const response = await app.inject({ method: "DELETE", url: "/admin/api/templates/a" });
    assert.strictEqual(response.statusCode, 401);
    assert.strictEqual(JSON.parse(response.body).error, "Unauthorized");
    await app.close();
  });
});
