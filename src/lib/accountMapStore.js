const fs = require("node:fs");
const path = require("node:path");

const validateAccountMap = (map) => {
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new Error("Account map must be a JSON object");
  }
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Account map entry "${key}" must map to a non-empty string`);
    }
  }
};

const createAccountMapStore = (configPath, initialMapJson) => {
  let mapJson = initialMapJson;

  const getMapJson = () => mapJson;

  const replaceAll = (newMap) => {
    validateAccountMap(newMap); // throws on failure, leaving mapJson untouched
    const newMapJson = JSON.stringify(newMap, null, 2);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, newMapJson);
    mapJson = newMapJson;
  };

  return { getMapJson, replaceAll };
};

module.exports = { createAccountMapStore, validateAccountMap };
