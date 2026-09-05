const bidv = require("./bidv");

const ADAPTERS = [bidv];

const normalize = (rawText) => rawText.replace(/\s+/g, " ").trim();

const identify = (normalizedText) => ADAPTERS.find((adapter) => adapter.match(normalizedText)) || null;

module.exports = { normalize, identify, ADAPTERS };
