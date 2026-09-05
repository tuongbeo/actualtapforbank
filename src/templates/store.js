const fs = require("node:fs");
const path = require("node:path");
const { validateTemplates } = require("./schema");

const createTemplatesStore = (configPath, initialTemplates) => {
  let templates = initialTemplates;

  const getTemplates = () => templates;

  const replaceAll = (newTemplates) => {
    validateTemplates(newTemplates); // throws on failure, leaving `templates` untouched
    fs.mkdirSync(path.dirname(configPath), { recursive: true }); // a tenant whose templates.json
      // never existed also never had its config/tenants/<id>/ directory created — both per-tenant
      // files are individually optional, so this directory may not exist yet on this store's first write
    fs.writeFileSync(configPath, JSON.stringify(newTemplates, null, 2));
    templates = newTemplates;
  };

  return { getTemplates, replaceAll };
};

module.exports = { createTemplatesStore };
