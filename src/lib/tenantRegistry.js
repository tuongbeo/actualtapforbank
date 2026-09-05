const fs = require("node:fs");
const path = require("node:path");
const { validateTemplates } = require("../templates/schema");

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

const loadTenants = (tenantsConfigPath) => {
  if (!fs.existsSync(tenantsConfigPath)) {
    throw new Error(`Tenants config not found at "${tenantsConfigPath}"`);
  }

  let rawTenants;
  try {
    rawTenants = JSON.parse(fs.readFileSync(tenantsConfigPath, "utf8"));
  } catch (err) {
    throw new Error(`Tenants config is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(rawTenants) || rawTenants.length === 0) {
    throw new Error("Tenants config must be a non-empty array");
  }

  const errors = [];
  const seenIds = new Set();
  const seenApiKeys = new Set();
  const tenantsRootDir = path.dirname(tenantsConfigPath);

  const tenants = rawTenants.map((raw, index) => {
    const tPath = `tenants[${index}]`;

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${tPath}: entry must be an object`);
      return null;
    }

    if (!isNonEmptyString(raw.id)) errors.push(`${tPath}: "id" is required and must be a non-empty string`);
    if (!isNonEmptyString(raw.apiKey)) errors.push(`${tPath}: "apiKey" is required and must be a non-empty string`);
    if (!isNonEmptyString(raw.actualSyncId)) errors.push(`${tPath}: "actualSyncId" is required and must be a non-empty string`);
    if (!isNonEmptyString(raw.actualPassword)) errors.push(`${tPath}: "actualPassword" is required and must be a non-empty string`);

    if (isNonEmptyString(raw.id)) {
      if (seenIds.has(raw.id)) errors.push(`${tPath}: duplicate tenant id "${raw.id}"`);
      seenIds.add(raw.id);
    }
    if (isNonEmptyString(raw.apiKey)) {
      if (seenApiKeys.has(raw.apiKey)) errors.push(`${tPath}: duplicate apiKey (tenant "${raw.id}")`);
      seenApiKeys.add(raw.apiKey);
    }

    if (!isNonEmptyString(raw.id)) return null;

    const accountMapPath = path.join(tenantsRootDir, "tenants", raw.id, "account-map.json");
    const templatesPath = path.join(tenantsRootDir, "tenants", raw.id, "templates.json");

    let accountMapJson = "{}";
    if (fs.existsSync(accountMapPath)) {
      accountMapJson = fs.readFileSync(accountMapPath, "utf8");
      try {
        JSON.parse(accountMapJson);
      } catch (err) {
        errors.push(`${tPath}: account-map.json is not valid JSON: ${err.message}`);
      }
    }

    let templates = [];
    if (fs.existsSync(templatesPath)) {
      try {
        templates = JSON.parse(fs.readFileSync(templatesPath, "utf8"));
        validateTemplates(templates);
      } catch (err) {
        errors.push(`${tPath}: templates.json is invalid: ${err.message}`);
      }
    }

    return {
      id: raw.id,
      actualSyncId: raw.actualSyncId,
      actualPassword: raw.actualPassword,
      actualEncryptionPassword: raw.actualEncryptionPassword || "",
      apiKey: raw.apiKey,
      keycloakSub: raw.keycloakSub || null,
      accountMapJson,
      templates,
      templatesPath,
    };
  });

  if (errors.length > 0) {
    throw new Error(`Invalid tenants config:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return tenants;
};

module.exports = { loadTenants };
