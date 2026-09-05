const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
const isNonEmptyArrayOfStrings = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);

const DATE_TOKEN_REGEX = /YYYY|MM|DD|HH|mm|ss/g;

const validateDateFormat = (format, path, errors) => {
  if (!isNonEmptyString(format)) {
    errors.push(`${path}: "format" is required and must be a non-empty string when type is "date"`);
    return;
  }
  const tokensFound = format.match(DATE_TOKEN_REGEX) || [];
  for (const required of ["YYYY", "MM", "DD"]) {
    if (!tokensFound.includes(required)) {
      errors.push(`${path}: "format" must include ${required}`);
    }
  }
};

const validateField = (field, path, errors) => {
  if (field === null || typeof field !== "object" || Array.isArray(field)) {
    errors.push(`${path}: field must be a non-null object`);
    return;
  }

  const hasRegex = field.regex !== undefined;
  const hasLabel = field.label !== undefined;

  if (hasRegex === hasLabel) {
    errors.push(`${path}: must declare exactly one of "regex" or "label"`);
    return;
  }

  if (hasRegex) {
    if (!isNonEmptyString(field.regex)) {
      errors.push(`${path}: "regex" must be a non-empty string`);
    } else {
      try {
        const compiled = new RegExp(field.regex);
        if (!/\(\?<value>/.test(compiled.source)) {
          errors.push(`${path}: "regex" must contain a named capture group "value"`);
        }
      } catch (err) {
        errors.push(`${path}: "regex" does not compile: ${err.message}`);
      }
    }
    if (field.stopLabel !== undefined) {
      errors.push(`${path}: "stopLabel" is not allowed alongside "regex"`);
    }
    if (field.type !== undefined) {
      errors.push(`${path}: "type" is not allowed alongside "regex"`);
    }
    return;
  }

  const labelIsValid = isNonEmptyString(field.label) || isNonEmptyArrayOfStrings(field.label);
  if (!labelIsValid) {
    errors.push(`${path}: "label" must be a non-empty string or a non-empty array of non-empty strings`);
  }
  if (!isNonEmptyString(field.stopLabel)) {
    errors.push(`${path}: "stopLabel" is required (non-empty string) for a label-based field`);
  }
  if (field.type !== undefined && field.type !== "amount" && field.type !== "date") {
    errors.push(`${path}: "type" must be "amount" or "date" if present`);
  }
  if (field.type === "date") {
    validateDateFormat(field.format, path, errors);
  }
};

const validateTemplate = (template, index, errors) => {
  const path = `templates[${index}]`;

  if (template === null || typeof template !== "object" || Array.isArray(template)) {
    errors.push(`${path}: template must be a non-null object`);
    return;
  }

  if (!isNonEmptyString(template.name)) {
    errors.push(`${path}: "name" is required and must be a non-empty string`);
  }
  if (template.sourceType !== "email" && template.sourceType !== "push") {
    errors.push(`${path}: "sourceType" must be "email" or "push"`);
  }
  if (template.direction !== "expense" && template.direction !== "income") {
    errors.push(`${path}: "direction" must be "expense" or "income"`);
  }
  if (!template.match || !isNonEmptyArrayOfStrings(template.match.contains)) {
    errors.push(`${path}: "match.contains" is required and must be a non-empty array of non-empty strings`);
  }

  const fieldsIsObject =
    template.fields && typeof template.fields === "object" && !Array.isArray(template.fields);
  if (!fieldsIsObject || Object.keys(template.fields).length === 0) {
    errors.push(`${path}: "fields" is required and must be a non-empty object`);
    return;
  }
  for (const [fieldName, field] of Object.entries(template.fields)) {
    validateField(field, `${path}.fields.${fieldName}`, errors);
  }

  if (!Array.isArray(template.requiredFields)) {
    errors.push(`${path}: "requiredFields" must be an array`);
  } else {
    for (const name of template.requiredFields) {
      if (!(name in template.fields)) {
        errors.push(`${path}: "requiredFields" references unknown field "${name}"`);
      }
    }
  }

  if (template.descriptionSuffix !== undefined) {
    if (!isNonEmptyString(template.descriptionSuffix)) {
      errors.push(`${path}: "descriptionSuffix" must be a non-empty string if present`);
    } else {
      const placeholders = [...template.descriptionSuffix.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const key of placeholders) {
        if (!(key in template.fields)) {
          errors.push(`${path}: "descriptionSuffix" references unknown field "${key}"`);
        }
      }
    }
  }
};

const validateTemplates = (templates) => {
  if (!Array.isArray(templates)) {
    throw new Error('Templates config must be an array');
  }

  const errors = [];
  templates.forEach((template, index) => validateTemplate(template, index, errors));

  const names = templates
    .filter((t) => t !== null && typeof t === "object" && !Array.isArray(t))
    .map((t) => t.name)
    .filter((n) => typeof n === "string");
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length > 0) {
    errors.push(`Duplicate template name(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid templates config:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
};

module.exports = { validateTemplates };
