const buildTenantLookup = (tenants, workerClients) => {
  const tenantsById = new Map();
  for (const t of tenants) {
    tenantsById.set(t.id, {
      id: t.id,
      workerClient: workerClients.get(t.id),
      templates: t.templates,
      accountMapJson: t.accountMapJson,
      keycloakSub: t.keycloakSub,
    });
  }
  const tenantsByApiKey = new Map(tenants.map((t) => [t.apiKey, tenantsById.get(t.id)]));
  return { tenantsById, tenantsByApiKey };
};

const resolveTenant = (tenantsByApiKey, apiKey) => tenantsByApiKey.get(apiKey) || null;

module.exports = { buildTenantLookup, resolveTenant };
