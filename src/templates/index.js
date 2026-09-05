const fs = require("node:fs");
const { validateTemplates } = require("./schema");
const { identify, AmbiguousMatchError } = require("./matcher");
const { extract } = require("./extractor");

const normalize = (rawText) => rawText.replace(/\s+/g, " ").trim();

const loadTemplates = (configPath) => {
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const templates = JSON.parse(raw);
  validateTemplates(templates);
  return templates;
};

module.exports = { loadTemplates, normalize, identify, extract, AmbiguousMatchError };
