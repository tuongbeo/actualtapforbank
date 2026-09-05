const { toISODate } = require("./dateFormat");
const { parseAmount } = require("../lib/parseAmount");

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const labelsOf = (field) => (Array.isArray(field.label) ? field.label : [field.label]);

const extractRawValue = (normalizedText, field) => {
  if (field.regex) {
    const regex = new RegExp(field.regex);
    const match = regex.exec(normalizedText);
    return match?.groups?.value;
  }

  const prefixPattern = labelsOf(field).map(escapeRegex).join("\\s*");
  const pattern = `${prefixPattern}\\s*(.+?)\\s*(?=${escapeRegex(field.stopLabel)}|$)`;
  const match = new RegExp(pattern, "i").exec(normalizedText);
  return match?.[1]?.trim();
};

const applyType = (rawValue, field) => {
  if (field.type === "amount") return parseAmount(rawValue);
  if (field.type === "date") return toISODate(rawValue, field.format);
  return rawValue;
};

const substitutePlaceholders = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");

const extract = (normalizedText, template) => {
  const parsed = {};

  for (const [fieldName, field] of Object.entries(template.fields)) {
    const rawValue = extractRawValue(normalizedText, field);

    if (rawValue === undefined) {
      if (template.requiredFields.includes(fieldName)) {
        throw new Error(`Could not find "${fieldName}" in rawText`);
      }
      continue;
    }

    parsed[fieldName] = applyType(rawValue, field);
  }

  if (template.descriptionSuffix) {
    const suffix = substitutePlaceholders(template.descriptionSuffix, parsed);
    parsed.description = parsed.description ? `${parsed.description} · ${suffix}` : suffix;
  }

  parsed.direction = template.direction;

  return parsed;
};

module.exports = { extract };
