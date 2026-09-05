const { createTemplatesStore } = require("../templates/store");
const { createAccountMapStore } = require("./accountMapStore");

const buildTenantLookup = (tenants, workerClients) => {
  const tenantsById = new Map();
  const tenantsByKeycloakSub = new Map();

  for (const t of tenants) {
    const tenant = {
      id: t.id,
      workerClient: workerClients.get(t.id),
      templatesStore: createTemplatesStore(t.templatesPath, t.templates),
      accountMapStore: createAccountMapStore(t.accountMapPath, t.accountMapJson),
      keycloakSub: t.keycloakSub,
    };
    tenantsById.set(t.id, tenant);
    if (typeof t.keycloakSub === "string" && t.keycloakSub.length > 0) {
      tenantsByKeycloakSub.set(t.keycloakSub, tenant);
    }
  }

  const tenantsByApiKey = new Map(tenants.map((t) => [t.apiKey, tenantsById.get(t.id)]));
  return { tenantsById, tenantsByApiKey, tenantsByKeycloakSub };
};

const resolveTenant = (tenantsByApiKey, apiKey) => tenantsByApiKey.get(apiKey) || null;

const resolveTenantByKeycloakSub = (tenantsByKeycloakSub, sub) => tenantsByKeycloakSub.get(sub) || null;

module.exports = { buildTenantLookup, resolveTenant, resolveTenantByKeycloakSub };
