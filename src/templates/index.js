const fs = require("node:fs");
const path = require("node:path");
const { validateTemplates } = require("./schema");
const { identify, AmbiguousMatchError } = require("./matcher");
const { extract } = require("./extractor");

const normalize = (rawText) => rawText.replace(/\s+/g, " ").trim();

const loadTemplates = (configPath) => {
  // Resolve against the app root so a relative default (config/templates.json)
  // works regardless of the process CWD. Absolute paths pass through unchanged.
  const resolvedPath = path.resolve(__dirname, "..", "..", configPath);

  if (!fs.existsSync(resolvedPath)) {
    return [];
  }

  const raw = fs.readFileSync(resolvedPath, "utf8");
  const templates = JSON.parse(raw);
  validateTemplates(templates);
  return templates;
};

module.exports = { loadTemplates, normalize, identify, extract, AmbiguousMatchError };
