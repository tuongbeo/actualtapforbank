# Notification Template Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the code-based BIDV adapter (`src/adapters/*`, merged in PR #3) with a config-driven template engine (`config/templates.json`) so a new bank/email format is added by editing configuration, not writing code.

**Architecture:** `POST /vietqr-transaction` normalizes `rawText`, calls `identify()` against an array of templates loaded once at startup from `config/templates.json`, then `extract()` on the matched template to pull fields via label-chain-based regex construction (or a manual `regex` override). All already-merged infrastructure (`accountResolver`, `dedupCache`, `actualAccounts`, `actualTransactions`) is reused unchanged.

**Tech Stack:** Node.js, Fastify 5, `@actual-app/api`, Node's built-in `node:test` + `assert` (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-05-notification-template-engine-design.md` (as amended — see the "Amendment" note in that file's §4: `label` accepts a chain/array of consecutive labels, and `stopLabel` is mandatory on every label-based field; there is no auto-detected boundary).

## Global Constraints

- `package.json`'s `test` script is `node --test test/*.test.js` — a **non-recursive** shell glob. Every new test file goes flat in `test/`, never in a subdirectory (fixtures are exempt — they aren't matched by this glob, so `test/fixtures/templates/*.json` is fine).
- No hot-reload of `config/templates.json` — read once at process startup; a config change requires a restart.
- `config/templates.json` is read via an optional env var `TEMPLATES_CONFIG_PATH` (default `"config/templates.json"`); if the file at that path doesn't exist, templates load as `[]` (matches nothing) rather than erroring — existing deployments that haven't adopted this feature are unaffected.
- A malformed (but present) `config/templates.json` makes the server **fail to start** with every validation problem listed at once — never silently ignored.
- `label` on a field is a string or an array of strings (a chain of consecutive labels matched and consumed in order — needed because real bank emails carry bilingual Vietnamese/English label pairs). `stopLabel` is **required** on every label-based field (no auto-detected boundary — see the spec's amendment rationale for why this was tried and rejected).
- A `regex`-based field must contain a named capture group `value`, and must not also declare `stopLabel` or `type`.
- `/vietqr-transaction`'s existing 6 integration test cases from PR #3 keep passing except one, whose expected status/error changes deliberately per the spec: a BIDV email missing the debit-account label ("Tài khoản nguồn") now returns `400 "Unrecognized bank format"` (it no longer matches the template at all) instead of `422 "Failed to parse transaction"`.
- `addTransaction`'s built transaction object gains one new field vs. PR #3: `imported_id: parsed.referenceCode` (Actual's own field for "a unique id usually given by the bank"). `cleared: false` is unchanged.
- `test/transaction.test.js` and `test/initialization.test.js` require a real Actual server (`ACTUAL_URL`, `ACTUAL_PASSWORD`, etc.) not available in a bare sandbox — run those on the VM/CI, don't block any task on them. Every other test file must pass in this sandbox.

---

## File Structure

```
src/lib/parseAmount.js              // NEW — extracted verbatim from transaction.js's inline parseAmount()
src/routes/transaction.js           // MODIFY — use the extracted parseAmount instead of a local copy
src/templates/dateFormat.js         // NEW — buildDateRegex(format), toISODate(rawValue, format)
src/templates/schema.js             // NEW — validateTemplates(templates)
src/templates/matcher.js            // NEW — identify(normalizedText, templates), AmbiguousMatchError
src/templates/extractor.js          // NEW — extract(normalizedText, template)
src/templates/index.js              // NEW — loadTemplates(configPath), normalize(rawText), re-exports identify/extract/AmbiguousMatchError
config/templates.json               // NEW — the bidv-expense template (migrated from src/adapters/bidv.js)
src/routes/vietqrTransaction.js     // MODIFY — use src/templates/* instead of src/adapters/*
src/plugins/env.js                  // MODIFY — add optional TEMPLATES_CONFIG_PATH
src/server.js                       // MODIFY — load templates at startup, pass to the route
src/adapters/bidv.js                // DELETE
src/adapters/index.js               // DELETE

test/parse-amount.test.js           // NEW
test/date-format.test.js            // NEW
test/template-schema.test.js        // NEW
test/template-matcher.test.js       // NEW
test/template-extractor.test.js     // NEW
test/templates-index.test.js        // NEW
test/fixtures/templates/valid-templates.json    // NEW
test/fixtures/templates/invalid-templates.json  // NEW
test/bidv-expense-template.test.js  // NEW
test/vietqr-transaction.test.js     // MODIFY — inject real config/templates.json instead of mocking ../adapters
test/bidv-adapter.test.js           // DELETE
test/adapter-registry.test.js       // DELETE
```

---

### Task 1: Extract `parseAmount` into a shared lib

**Files:**
- Create: `src/lib/parseAmount.js`
- Test: `test/parse-amount.test.js`
- Modify: `src/routes/transaction.js:1` (add import), `src/routes/transaction.js:36-54` (remove local `parseAmount`)

**Interfaces:**
- Produces: `parseAmount(raw: string) => number` (may be `NaN` if unparseable — same as today)

- [ ] **Step 1: Write the failing test**

Create `test/parse-amount.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { parseAmount } = require("../src/lib/parseAmount");

describe("parseAmount", () => {
  it("parses a plain integer string", () => {
    assert.strictEqual(parseAmount("10000"), 10000);
  });

  it("strips a currency symbol and trailing unit text", () => {
    assert.strictEqual(parseAmount("£12.34"), 12.34);
    assert.strictEqual(parseAmount("10,000 VND"), 10000);
  });

  it("treats a comma as a thousands separator when 3 digits follow it", () => {
    assert.strictEqual(parseAmount("10,000"), 10000);
  });

  it("treats a comma as a decimal separator when it isn't followed by exactly 3 digits", () => {
    assert.strictEqual(parseAmount("12,34"), 12.34);
  });

  it("treats the later of comma/dot as the decimal separator when both are present", () => {
    assert.strictEqual(parseAmount("1.234,56"), 1234.56);
    assert.strictEqual(parseAmount("1,234.56"), 1234.56);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/parse-amount.test.js`
Expected: FAIL — `Cannot find module '../src/lib/parseAmount'`

- [ ] **Step 3: Implement**

Create `src/lib/parseAmount.js`:

```js
// iOS Shortcuts passes the Tap-to-Pay amount as locale-formatted text, so the
// string may carry a currency symbol and use either "," or "." as the decimal
// separator (e.g. "£12.34", "12,34", "1.234,56 €")
const parseAmount = (raw) => {
  let value = raw.replace(/[^\d.,-]/g, "");
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // Both present: the later one is the decimal separator, the other is a thousands separator
    value =
      lastComma > lastDot ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
  } else if (lastComma > -1) {
    const isDecimalComma = value.indexOf(",") === lastComma && value.length - lastComma - 1 !== 3;
    value = isDecimalComma ? value.replace(",", ".") : value.replace(/,/g, "");
  }

  return parseFloat(value);
};

module.exports = { parseAmount };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/parse-amount.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Refactor `src/routes/transaction.js` to use the extracted function**

At the top of `src/routes/transaction.js`, after `const { randomUUID } = require("crypto");`, add:

```js
const { parseAmount } = require("../lib/parseAmount");
```

Delete the local `parseAmount` function and its leading comment (current lines 36-54):

```js
// iOS Shortcuts passes the Tap-to-Pay amount as locale-formatted text, so the
// string may carry a currency symbol and use either "," or "." as the decimal
// separator (e.g. "£12.34", "12,34", "1.234,56 €")
const parseAmount = (raw) => {
  let value = raw.replace(/[^\d.,-]/g, "");
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // Both present: the later one is the decimal separator, the other is a thousands separator
    value =
      lastComma > lastDot ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
  } else if (lastComma > -1) {
    const isDecimalComma = value.indexOf(",") === lastComma && value.length - lastComma - 1 !== 3;
    value = isDecimalComma ? value.replace(",", ".") : value.replace(/,/g, "");
  }

  return parseFloat(value);
};
```

This is a pure extraction — no behavior change.

- [ ] **Step 6: Verify no regression in the mock-based transaction tests**

Run: `node --test test/sync-failure.test.js`
Expected: PASS (all existing tests, unchanged)

- [ ] **Step 7: Commit**

```bash
git add src/lib/parseAmount.js src/routes/transaction.js test/parse-amount.test.js
git commit -m "Extract shared parseAmount helper from /transaction route"
```

---

### Task 2: Date-format parsing (`src/templates/dateFormat.js`)

**Files:**
- Create: `src/templates/dateFormat.js`
- Test: `test/date-format.test.js`

**Interfaces:**
- Produces: `buildDateRegex(format: string) => RegExp` (has named groups among `year`/`month`/`day`/`hour`/`minute`/`second`, one per recognized token present in `format`)
- Produces: `toISODate(rawValue: string, format: string) => string` (`"YYYY-MM-DD"`; throws `Error` if `rawValue` doesn't match, or if the built regex has no `year`/`month`/`day` group)

- [ ] **Step 1: Write the failing tests**

Create `test/date-format.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { buildDateRegex, toISODate } = require("../src/templates/dateFormat");

describe("buildDateRegex", () => {
  it("builds named groups for each recognized token and keeps other characters literal", () => {
    const regex = buildDateRegex("DD/MM/YYYY HH:mm:ss");
    const match = regex.exec("04/09/2026 08:41:29");
    assert.ok(match);
    assert.strictEqual(match.groups.day, "04");
    assert.strictEqual(match.groups.month, "09");
    assert.strictEqual(match.groups.year, "2026");
    assert.strictEqual(match.groups.hour, "08");
    assert.strictEqual(match.groups.minute, "41");
    assert.strictEqual(match.groups.second, "29");
  });

  it("supports a date-only format with no time tokens", () => {
    const regex = buildDateRegex("YYYY-MM-DD");
    const match = regex.exec("2026-09-04");
    assert.ok(match);
    assert.strictEqual(match.groups.year, "2026");
    assert.strictEqual(match.groups.month, "09");
    assert.strictEqual(match.groups.day, "04");
  });
});

describe("toISODate", () => {
  it("reassembles YYYY-MM-DD from a matched raw value", () => {
    assert.strictEqual(toISODate("04/09/2026 08:41:29", "DD/MM/YYYY HH:mm:ss"), "2026-09-04");
  });

  it("throws when the raw value doesn't match the format", () => {
    assert.throws(
      () => toISODate("not a date", "DD/MM/YYYY HH:mm:ss"),
      /Could not parse date/
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/date-format.test.js`
Expected: FAIL — `Cannot find module '../src/templates/dateFormat'`

- [ ] **Step 3: Implement**

Create `src/templates/dateFormat.js`:

```js
const TOKEN_PATTERNS = {
  YYYY: "(?<year>\\d{4})",
  MM: "(?<month>\\d{2})",
  DD: "(?<day>\\d{2})",
  HH: "(?<hour>\\d{2})",
  mm: "(?<minute>\\d{2})",
  ss: "(?<second>\\d{2})",
};

const TOKEN_REGEX = /YYYY|MM|DD|HH|mm|ss/g;

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildDateRegex = (format) => {
  let pattern = "";
  let lastIndex = 0;
  TOKEN_REGEX.lastIndex = 0;

  let match;
  while ((match = TOKEN_REGEX.exec(format)) !== null) {
    pattern += escapeRegex(format.slice(lastIndex, match.index));
    pattern += TOKEN_PATTERNS[match[0]];
    lastIndex = TOKEN_REGEX.lastIndex;
  }
  pattern += escapeRegex(format.slice(lastIndex));

  return new RegExp(pattern);
};

const toISODate = (rawValue, format) => {
  const regex = buildDateRegex(format);
  const match = regex.exec(rawValue);

  if (!match?.groups?.year || !match.groups.month || !match.groups.day) {
    throw new Error(`Could not parse date "${rawValue}" using format "${format}"`);
  }

  return `${match.groups.year}-${match.groups.month}-${match.groups.day}`;
};

module.exports = { buildDateRegex, toISODate };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/date-format.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/templates/dateFormat.js test/date-format.test.js
git commit -m "Add date-format parsing for template date fields"
```

---

### Task 3: Template config validation (`src/templates/schema.js`)

**Files:**
- Create: `src/templates/schema.js`
- Test: `test/template-schema.test.js`

**Interfaces:**
- Consumes: nothing (pure module)
- Produces: `validateTemplates(templates: unknown) => void` (throws `Error` listing every problem found, joined with newlines, if `templates` is invalid; returns nothing on success)

- [ ] **Step 1: Write the failing tests**

Create `test/template-schema.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { validateTemplates } = require("../src/templates/schema");

const validTemplate = () => ({
  name: "test-template",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["Foo"] },
  fields: {
    code: { label: "Code:", stopLabel: "Amount:" },
  },
  requiredFields: ["code"],
});

describe("validateTemplates", () => {
  it("accepts a well-formed template array", () => {
    assert.doesNotThrow(() => validateTemplates([validTemplate()]));
  });

  it("throws when the top level isn't an array", () => {
    assert.throws(() => validateTemplates({}), /must be an array/);
  });

  it("throws when name is missing", () => {
    const template = validTemplate();
    delete template.name;
    assert.throws(() => validateTemplates([template]), /"name" is required/);
  });

  it("throws when sourceType is not email or push", () => {
    const template = { ...validTemplate(), sourceType: "sms" };
    assert.throws(() => validateTemplates([template]), /"sourceType" must be "email" or "push"/);
  });

  it("throws when direction is not expense or income", () => {
    const template = { ...validTemplate(), direction: "transfer" };
    assert.throws(() => validateTemplates([template]), /"direction" must be "expense" or "income"/);
  });

  it("throws when match.contains is empty", () => {
    const template = { ...validTemplate(), match: { contains: [] } };
    assert.throws(() => validateTemplates([template]), /"match.contains" is required/);
  });

  it("throws when a field declares neither regex nor label", () => {
    const template = validTemplate();
    template.fields.code = {};
    assert.throws(() => validateTemplates([template]), /must declare exactly one of "regex" or "label"/);
  });

  it("throws when a field declares both regex and label", () => {
    const template = validTemplate();
    template.fields.code = { label: "Code:", regex: "Code:\\s*(?<value>.+)" };
    assert.throws(() => validateTemplates([template]), /must declare exactly one of "regex" or "label"/);
  });

  it("throws when a regex field has no named group value", () => {
    const template = validTemplate();
    template.fields.code = { regex: "Code:\\s*(.+)" };
    assert.throws(() => validateTemplates([template]), /named capture group "value"/);
  });

  it("throws when a regex field also declares stopLabel", () => {
    const template = validTemplate();
    template.fields.code = { regex: "Code:\\s*(?<value>.+)", stopLabel: "End:" };
    assert.throws(() => validateTemplates([template]), /"stopLabel" is not allowed alongside "regex"/);
  });

  it("throws when a label-based field has no stopLabel", () => {
    const template = validTemplate();
    template.fields.code = { label: "Code:" };
    assert.throws(() => validateTemplates([template]), /"stopLabel" is required/);
  });

  it("accepts an array label (a label chain)", () => {
    const template = validTemplate();
    template.fields.code = { label: ["Code:", "Ref:"], stopLabel: "Amount:" };
    assert.doesNotThrow(() => validateTemplates([template]));
  });

  it("throws when type is 'date' without a format", () => {
    const template = validTemplate();
    template.fields.code = { label: "Code:", stopLabel: "Amount:", type: "date" };
    assert.throws(() => validateTemplates([template]), /"format" is required/);
  });

  it("throws when a date format is missing a required token", () => {
    const template = validTemplate();
    template.fields.code = { label: "Code:", stopLabel: "Amount:", type: "date", format: "HH:mm:ss" };
    assert.throws(() => validateTemplates([template]), /must include YYYY/);
  });

  it("throws when requiredFields references an unknown field", () => {
    const template = { ...validTemplate(), requiredFields: ["code", "missing"] };
    assert.throws(() => validateTemplates([template]), /references unknown field "missing"/);
  });

  it("throws when descriptionSuffix references an unknown field", () => {
    const template = { ...validTemplate(), descriptionSuffix: "Ref: {missing}" };
    assert.throws(() => validateTemplates([template]), /"descriptionSuffix" references unknown field "missing"/);
  });

  it("throws when two templates share the same name", () => {
    assert.throws(
      () => validateTemplates([validTemplate(), validTemplate()]),
      /Duplicate template name/
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/template-schema.test.js`
Expected: FAIL — `Cannot find module '../src/templates/schema'`

- [ ] **Step 3: Implement**

Create `src/templates/schema.js`:

```js
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
        if (!compiled.source.includes("?<value>")) {
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

  const names = templates.map((t) => t.name).filter((n) => typeof n === "string");
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length > 0) {
    errors.push(`Duplicate template name(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid templates config:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
};

module.exports = { validateTemplates };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/template-schema.test.js`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add src/templates/schema.js test/template-schema.test.js
git commit -m "Add template config validation (validateTemplates)"
```

---

### Task 4: Template matcher (`src/templates/matcher.js`)

**Files:**
- Create: `src/templates/matcher.js`
- Test: `test/template-matcher.test.js`

**Interfaces:**
- Produces: `identify(normalizedText: string, templates: Array) => template|null` (throws `AmbiguousMatchError` if more than one template's `match.contains` is satisfied)
- Produces: `AmbiguousMatchError` (an `Error` subclass, `.name === "AmbiguousMatchError"`)

- [ ] **Step 1: Write the failing tests**

Create `test/template-matcher.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { identify, AmbiguousMatchError } = require("../src/templates/matcher");

const template = (name, contains) => ({ name, match: { contains } });

describe("identify", () => {
  it("returns the template whose match.contains are all present (case-insensitive)", () => {
    const templates = [template("a", ["FOO", "bar"]), template("b", ["baz"])];
    const result = identify("something foo and BAR here", templates);
    assert.strictEqual(result.name, "a");
  });

  it("returns null when no template matches", () => {
    const templates = [template("a", ["FOO"])];
    assert.strictEqual(identify("nothing relevant", templates), null);
  });

  it("returns null when only some of a template's contains are present", () => {
    const templates = [template("a", ["FOO", "MISSING"])];
    assert.strictEqual(identify("foo is here", templates), null);
  });

  it("throws AmbiguousMatchError when more than one template matches", () => {
    const templates = [template("a", ["FOO"]), template("b", ["FOO"])];
    assert.throws(() => identify("foo appears here", templates), AmbiguousMatchError);
    assert.throws(() => identify("foo appears here", templates), /a, b/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/template-matcher.test.js`
Expected: FAIL — `Cannot find module '../src/templates/matcher'`

- [ ] **Step 3: Implement**

Create `src/templates/matcher.js`:

```js
class AmbiguousMatchError extends Error {
  constructor(templateNames) {
    super(`Multiple templates matched: ${templateNames.join(", ")}`);
    this.name = "AmbiguousMatchError";
  }
}

const identify = (normalizedText, templates) => {
  const lowerText = normalizedText.toLowerCase();
  const matches = templates.filter((template) =>
    template.match.contains.every((needle) => lowerText.includes(needle.toLowerCase()))
  );

  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new AmbiguousMatchError(matches.map((t) => t.name));
  }
  return matches[0];
};

module.exports = { identify, AmbiguousMatchError };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/template-matcher.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/templates/matcher.js test/template-matcher.test.js
git commit -m "Add template matcher (identify) with ambiguous-match detection"
```

---

### Task 5: Field extractor (`src/templates/extractor.js`)

**Files:**
- Create: `src/templates/extractor.js`
- Test: `test/template-extractor.test.js`

**Interfaces:**
- Consumes: `parseAmount` (Task 1, `../lib/parseAmount`), `toISODate` (Task 2, `./dateFormat`)
- Produces: `extract(normalizedText: string, template: Object) => Object` — one key per field in `template.fields` that was found (fields that can't be found and aren't in `requiredFields` are simply omitted), plus `direction` (copied from `template.direction`) and, when `template.descriptionSuffix` is set, a `description` key with the suffix substituted in and appended. Throws `Error` if a field in `requiredFields` can't be found.

- [ ] **Step 1: Write the failing tests**

Create `test/template-extractor.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { extract } = require("../src/templates/extractor");

const baseTemplate = () => ({
  name: "test-template",
  sourceType: "email",
  direction: "expense",
  match: { contains: ["Code:"] },
  fields: {
    code: { label: ["Code:", "Ref:"], stopLabel: "Amount:" },
    amount: { label: "Amount:", type: "amount", stopLabel: "Date:" },
    txnDate: { label: "Date:", type: "date", format: "DD-MM-YYYY", stopLabel: "Name:" },
    name: { regex: "Name:\\s*(?<value>[A-Za-z ]+)$" },
  },
  requiredFields: ["code", "amount", "txnDate", "name"],
  descriptionSuffix: "Ref: {code}",
});

const TEXT = "Code: Ref: ABC123 Amount: 1234.56 Date: 05-09-2026 Name: John Doe";

describe("extract", () => {
  it("extracts a label chain, an amount field, a date field, and a regex-override field", () => {
    const result = extract(TEXT, baseTemplate());
    assert.strictEqual(result.code, "ABC123");
    assert.strictEqual(result.amount, 1234.56);
    assert.strictEqual(result.txnDate, "2026-09-05");
    assert.strictEqual(result.name, "John Doe");
  });

  it("copies template.direction onto the parsed result", () => {
    const result = extract(TEXT, baseTemplate());
    assert.strictEqual(result.direction, "expense");
  });

  it("builds description from descriptionSuffix when no description field is declared", () => {
    const result = extract(TEXT, baseTemplate());
    assert.strictEqual(result.description, "Ref: ABC123");
  });

  it("appends descriptionSuffix to an existing description field with a middot separator", () => {
    const template = baseTemplate();
    template.fields.description = { label: "Name:", stopLabel: "$END$" };
    // "Name:" value runs to end of string since "$END$" never appears
    const result = extract(TEXT, template);
    assert.strictEqual(result.description, "John Doe · Ref: ABC123");
  });

  it("omits an optional field that can't be found instead of throwing", () => {
    const template = baseTemplate();
    template.fields.optional = { label: "Missing:", stopLabel: "$END$" };
    const result = extract(TEXT, template);
    assert.strictEqual("optional" in result, false);
  });

  it("throws when a required field can't be found", () => {
    const template = baseTemplate();
    template.fields.missingRequired = { label: "Nope:", stopLabel: "$END$" };
    template.requiredFields.push("missingRequired");
    assert.throws(() => extract(TEXT, template), /Could not find "missingRequired"/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/template-extractor.test.js`
Expected: FAIL — `Cannot find module '../src/templates/extractor'`

- [ ] **Step 3: Implement**

Create `src/templates/extractor.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/template-extractor.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/templates/extractor.js test/template-extractor.test.js
git commit -m "Add field extractor (label chains, regex override, amount/date types)"
```

---

### Task 6: Templates public API (`src/templates/index.js`)

**Files:**
- Create: `src/templates/index.js`
- Test: `test/templates-index.test.js`
- Create: `test/fixtures/templates/valid-templates.json`
- Create: `test/fixtures/templates/invalid-templates.json`

**Interfaces:**
- Consumes: `validateTemplates` (Task 3), `identify`/`AmbiguousMatchError` (Task 4), `extract` (Task 5)
- Produces: `loadTemplates(configPath: string) => Array` (returns `[]` if the file doesn't exist; throws if it exists but fails validation), `normalize(rawText: string) => string`, plus re-exports `identify`, `extract`, `AmbiguousMatchError`

- [ ] **Step 1: Create the fixtures**

Create `test/fixtures/templates/valid-templates.json`:

```json
[
  {
    "name": "test-valid",
    "sourceType": "email",
    "direction": "expense",
    "match": { "contains": ["Foo"] },
    "fields": {
      "code": { "label": "Code:", "stopLabel": "$END$" }
    },
    "requiredFields": ["code"]
  }
]
```

Create `test/fixtures/templates/invalid-templates.json` (missing required `"name"`):

```json
[
  {
    "sourceType": "email",
    "direction": "expense",
    "match": { "contains": ["Foo"] },
    "fields": {
      "code": { "label": "Code:", "stopLabel": "$END$" }
    },
    "requiredFields": ["code"]
  }
]
```

- [ ] **Step 2: Write the failing tests**

Create `test/templates-index.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { loadTemplates, normalize, identify, extract, AmbiguousMatchError } = require("../src/templates");

describe("loadTemplates", () => {
  it("returns an empty array when the config file doesn't exist", () => {
    const result = loadTemplates(path.join(__dirname, "fixtures/templates/does-not-exist.json"));
    assert.deepStrictEqual(result, []);
  });

  it("loads and validates a well-formed config file", () => {
    const result = loadTemplates(path.join(__dirname, "fixtures/templates/valid-templates.json"));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "test-valid");
  });

  it("throws when the config file fails validation", () => {
    assert.throws(
      () => loadTemplates(path.join(__dirname, "fixtures/templates/invalid-templates.json")),
      /"name" is required/
    );
  });
});

describe("normalize", () => {
  it("collapses newlines and repeated whitespace into single spaces", () => {
    assert.strictEqual(normalize("Số tham chiếu:\n\n  6247BIDVE2NEKZD1  "), "Số tham chiếu: 6247BIDVE2NEKZD1");
  });
});

describe("re-exports", () => {
  it("re-exports identify, extract, and AmbiguousMatchError", () => {
    assert.strictEqual(typeof identify, "function");
    assert.strictEqual(typeof extract, "function");
    assert.strictEqual(typeof AmbiguousMatchError, "function");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/templates-index.test.js`
Expected: FAIL — `Cannot find module '../src/templates'`

- [ ] **Step 4: Implement**

Create `src/templates/index.js`:

```js
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/templates-index.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/templates/index.js test/templates-index.test.js test/fixtures/templates
git commit -m "Add templates public API (loadTemplates, normalize, re-exports)"
```

---

### Task 7: Migrate BIDV to `config/templates.json`

**Files:**
- Create: `config/templates.json`
- Test: `test/bidv-expense-template.test.js`

**Interfaces:**
- Consumes: `normalize`, `identify`, `extract` (Task 6, `../src/templates`)

- [ ] **Step 1: Create the template config**

Create `config/templates.json`. Every field's `label` and `stopLabel` below was chosen by tracing the real fixture `test/fixtures/bidv-expense.txt` by hand (see the spec's amendment rationale, §4):

```json
[
  {
    "name": "bidv-expense",
    "sourceType": "email",
    "direction": "expense",
    "match": {
      "contains": ["BIDV", "Số tham chiếu", "Số tiền giao dịch", "Tài khoản nguồn"]
    },
    "fields": {
      "referenceCode": { "label": ["Số tham chiếu:", "Reference number:"], "stopLabel": "Tài khoản nguồn:" },
      "sourceAccountNumber": { "label": ["Tài khoản nguồn:", "Debit account:"], "stopLabel": "Số tiền giao dịch:" },
      "amount": { "label": ["Số tiền giao dịch:", "Transaction amount:"], "type": "amount", "stopLabel": "Phí giao dịch:" },
      "transactionDate": { "label": ["Thời gian giao dịch:", "Transaction time:"], "type": "date", "format": "DD/MM/YYYY HH:mm:ss", "stopLabel": "Số tham chiếu:" },
      "counterpartyName": { "label": ["Tên người thụ hưởng:", "Beneficiary name:"], "stopLabel": "Số tài khoản" },
      "description": { "label": ["Nội dung giao dịch:", "Transaction remark:"], "stopLabel": "Kênh thực hiện giao dịch:" }
    },
    "requiredFields": ["referenceCode", "amount", "transactionDate", "sourceAccountNumber", "counterpartyName", "description"],
    "descriptionSuffix": "Ref: {referenceCode}"
  }
]
```

- [ ] **Step 2: Write the failing test**

Create `test/bidv-expense-template.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { normalize, identify, extract } = require("../src/templates");

const TEMPLATES = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/templates.json"), "utf8"));
const FIXTURE = normalize(fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8"));

describe("bidv-expense template (config/templates.json)", () => {
  it("matches the real BIDV expense email fixture", () => {
    const template = identify(FIXTURE, TEMPLATES);
    assert.strictEqual(template?.name, "bidv-expense");
  });

  it("extracts all fields from the real fixture", () => {
    const template = identify(FIXTURE, TEMPLATES);
    const result = extract(FIXTURE, template);
    assert.deepStrictEqual(result, {
      referenceCode: "6247BIDVE2NEKZD1",
      sourceAccountNumber: "8820966012",
      amount: 10000,
      transactionDate: "2026-09-04",
      counterpartyName: "PHAM MANH TUONG",
      description: "PHAM MANH TUONG Chuyen tien · Ref: 6247BIDVE2NEKZD1",
      direction: "expense",
    });
  });

  it("does not match unrelated text", () => {
    assert.strictEqual(identify(normalize("Your OTP code is 123456"), TEMPLATES), null);
  });

  it("does not match a BIDV email lacking the debit-account label (e.g. an income variant)", () => {
    const incomeText = FIXTURE.replace("Tài khoản nguồn:", "Tài khoản đích:");
    assert.strictEqual(identify(incomeText, TEMPLATES), null);
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `node --test test/bidv-expense-template.test.js`
Expected: PASS (4 tests) — this proves the config migration is behavior-preserving against the same real-email fixture that validated the original `bidv.js` adapter.

- [ ] **Step 4: Commit**

```bash
git add config/templates.json test/bidv-expense-template.test.js
git commit -m "Migrate BIDV expense adapter to config/templates.json"
```

---

### Task 8: Rewire `/vietqr-transaction` to the template engine

**Files:**
- Modify: `src/routes/vietqrTransaction.js` (full rewrite of the adapter-based logic)
- Modify: `src/plugins/env.js:13` (add `TEMPLATES_CONFIG_PATH`)
- Modify: `src/server.js:46-47` (load templates, pass to the route)
- Modify: `test/vietqr-transaction.test.js` (inject real `config/templates.json`, update the one behavior-changed case, add the ambiguous-match case)

**Interfaces:**
- Consumes: `normalize`/`identify`/`extract`/`AmbiguousMatchError` (Task 6, `../templates`), `resolveAccountName` (existing), `createDedupCache` (existing), `getAccountByName` (existing), `addTransaction`/`syncBudget` (existing)
- Produces: `POST /vietqr-transaction` registered as a Fastify plugin accepting `opts.templates` (defaults to `[]`) and `opts.dedupCache` (defaults to a fresh `createDedupCache()`, unchanged from PR #3)

- [ ] **Step 1: Add `TEMPLATES_CONFIG_PATH` to the env schema**

In `src/plugins/env.js`, in the `properties` object, after `ACCOUNT_MAP: { type: "string", default: "{}" },`, add:

```js
    TEMPLATES_CONFIG_PATH: { type: "string", default: "config/templates.json" },
```

Do **not** add it to the `required` array — it must stay optional.

- [ ] **Step 2: Rewrite `src/routes/vietqrTransaction.js`**

Replace the entire file with:

```js
const { randomUUID, createHash } = require("crypto");
const { normalize, identify, extract, AmbiguousMatchError } = require("../templates");
const { resolveAccountName } = require("../lib/accountResolver");
const { createDedupCache } = require("../lib/dedupCache");
const { getAccountByName } = require("../lib/actualAccounts");
const { addTransaction, syncBudget } = require("../lib/actualTransactions");

const vietqrTransactionSchema = {
  schema: {
    body: {
      type: "object",
      properties: {
        rawText: { type: "string", minLength: 1 },
        capturedAt: { type: "string" },
      },
      required: ["rawText"],
    },
  },
};

const buildDedupKey = (templateName, parsed, normalizedText) => {
  if (parsed.referenceCode) {
    return `${templateName}:ref:${parsed.referenceCode}`;
  }
  const hash = createHash("sha256").update(normalizedText).digest("hex");
  return `${templateName}:hash:${hash}`;
};

module.exports = async (fastify, opts) => {
  const dedupCache = opts.dedupCache || createDedupCache();
  const templates = opts.templates || [];

  fastify.post("/vietqr-transaction", vietqrTransactionSchema, async (request, reply) => {
    const normalizedText = normalize(request.body.rawText);

    let template;
    try {
      template = identify(normalizedText, templates);
    } catch (err) {
      if (err instanceof AmbiguousMatchError) {
        return reply.code(500).send({ error: "Ambiguous template match", message: err.message });
      }
      throw err;
    }

    if (!template) {
      return reply.code(400).send({
        error: "Unrecognized bank format",
        message: "No template matched the provided rawText",
      });
    }

    let parsed;
    try {
      parsed = extract(normalizedText, template);
    } catch (err) {
      return reply.code(422).send({
        error: "Failed to parse transaction",
        message: err.message,
      });
    }

    const accountName = resolveAccountName(parsed.sourceAccountNumber, fastify.config.ACCOUNT_MAP);
    if (!accountName) {
      return reply.code(400).send({
        error: "Unknown source account",
        message: `Source account "${parsed.sourceAccountNumber}" is not mapped in ACCOUNT_MAP`,
      });
    }

    const { accountId, accounts } = await getAccountByName(fastify, accountName);
    if (!accountId) {
      return reply.code(400).send({
        error: "Invalid account",
        message: `Account "${accountName}" not found in Actual. Available accounts: ${accounts.map((a) => a.name).join(", ")}`,
      });
    }

    const dedupKey = buildDedupKey(template.name, parsed, normalizedText);
    if (dedupCache.checkAndMark(dedupKey)) {
      return reply.send({ duplicate: true, ...parsed });
    }

    const signedAmount = parsed.direction === "expense" ? -Math.abs(parsed.amount) : Math.abs(parsed.amount);
    const transaction = {
      id: randomUUID(),
      payee_name: parsed.counterpartyName,
      amount: signedAmount * 100,
      notes: parsed.description,
      date: parsed.transactionDate,
      imported_id: parsed.referenceCode,
      cleared: false,
    };

    try {
      await addTransaction(fastify, accountId, transaction);
    } catch (err) {
      dedupCache.unmark(dedupKey);
      throw err;
    }

    const syncResult = await syncBudget(fastify);
    if (!syncResult.ok) {
      return reply.code(500).send({
        error: "Sync failed",
        message: "Transaction was saved locally but failed to sync to the server. It may be lost on restart.",
      });
    }

    return reply.send(transaction);
  });
};
```

- [ ] **Step 3: Wire template loading into `src/server.js`**

In `src/server.js`, replace:

```js
  await fastify.register(require("./plugins/actualConnector"));
  await fastify.register(require("./routes/transaction"));
  await fastify.register(require("./routes/vietqrTransaction"));
  await fastify.register(require("./routes/health"));
```

with:

```js
  await fastify.register(require("./plugins/actualConnector"));
  await fastify.register(require("./routes/transaction"));

  const { loadTemplates } = require("./templates");
  const templates = loadTemplates(fastify.config.TEMPLATES_CONFIG_PATH);
  await fastify.register(require("./routes/vietqrTransaction"), { templates });

  await fastify.register(require("./routes/health"));
```

- [ ] **Step 4: Update `test/vietqr-transaction.test.js`**

Replace the entire file with:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const fastify = require("fastify");
const { createDedupCache } = require("../src/lib/dedupCache");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures/bidv-expense.txt"), "utf8");
const TEMPLATES = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/templates.json"), "utf8"));

async function buildMockServer({
  accountMap = '{"8820966012":"BIDV Cash"}',
  accounts = [{ id: "acc-1", name: "BIDV Cash" }],
  syncBehaviour = "success",
  templates = TEMPLATES,
} = {}) {
  const app = fastify({ logger: false, ajv: { customOptions: { allowUnionTypes: true } } });

  app.decorate("config", { API_KEY: "test-key", ACCOUNT_MAP: accountMap });

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/health?")) return;
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== app.config.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  const addedTransactions = [];
  app.decorate("actual", {
    getAccounts: async () => accounts,
    addTransactions: async (accountId, transactions) => {
      addedTransactions.push({ accountId, transactions });
      return "ok";
    },
    sync: async () => {
      if (syncBehaviour === "fail") {
        throw new Error("PostError: unauthorized");
      }
    },
  });
  app.decorate("addedTransactions", addedTransactions);

  await app.register(require("../src/routes/vietqrTransaction"), { dedupCache: createDedupCache(), templates });

  return app;
}

describe("POST /vietqr-transaction", () => {
  it("creates an expense transaction from a matching BIDV email", async () => {
    const app = await buildMockServer();
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });

    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.amount, -1000000);
    assert.strictEqual(body.payee_name, "PHAM MANH TUONG");
    assert.strictEqual(body.date, "2026-09-04");
    assert.strictEqual(body.imported_id, "6247BIDVE2NEKZD1");
    assert.ok(body.notes.includes("6247BIDVE2NEKZD1"));
    assert.strictEqual(app.addedTransactions.length, 1);
    assert.strictEqual(app.addedTransactions[0].accountId, "acc-1");
    await app.close();
  });

  it("returns 400 when no template matches", async () => {
    const app = await buildMockServer();
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: "Your OTP code is 123456" },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Unrecognized bank format");
    await app.close();
  });

  it("returns 400 for a BIDV email lacking the debit-account label (e.g. an income variant)", async () => {
    const app = await buildMockServer();
    const incomeText = FIXTURE.replace("Tài khoản nguồn:", "Tài khoản đích:");
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: incomeText },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Unrecognized bank format");
    await app.close();
  });

  it("returns 500 when more than one template matches the same rawText", async () => {
    const duplicateTemplates = [
      {
        name: "dup-a",
        sourceType: "email",
        direction: "expense",
        match: { contains: ["FOO"] },
        fields: { x: { label: "FOO:", stopLabel: "$END$" } },
        requiredFields: ["x"],
      },
      {
        name: "dup-b",
        sourceType: "email",
        direction: "expense",
        match: { contains: ["FOO"] },
        fields: { x: { label: "FOO:", stopLabel: "$END$" } },
        requiredFields: ["x"],
      },
    ];
    const app = await buildMockServer({ templates: duplicateTemplates });
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: "FOO: bar" },
    });

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(JSON.parse(response.body).error, "Ambiguous template match");
    await app.close();
  });

  it("returns 400 when the source account is not in ACCOUNT_MAP", async () => {
    const app = await buildMockServer({ accountMap: "{}" });
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(JSON.parse(response.body).error, "Unknown source account");
    await app.close();
  });

  it("does not create a duplicate transaction for the same reference code within TTL", async () => {
    const app = await buildMockServer();
    const first = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(first.statusCode, 200);

    const second = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(JSON.parse(second.body).duplicate, true);
    assert.strictEqual(app.addedTransactions.length, 1);
    await app.close();
  });

  it("returns 500 when sync fails after the transaction is added", async () => {
    const app = await buildMockServer({ syncBehaviour: "fail" });
    const response = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(JSON.parse(response.body).error, "Sync failed");
    await app.close();
  });

  it("does not poison the dedup cache when the account is not found in Actual", async () => {
    const app = await buildMockServer({ accounts: [] });
    const first = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(first.statusCode, 400);
    assert.strictEqual(JSON.parse(first.body).error, "Invalid account");

    const second = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(second.statusCode, 400);
    assert.strictEqual(JSON.parse(second.body).error, "Invalid account");
    await app.close();
  });

  it("does not poison the dedup cache when addTransaction fails", async () => {
    const app = await buildMockServer();
    app.actual.addTransactions = async () => {
      throw new Error("Actual is down");
    };

    const first = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(first.statusCode, 500);
    assert.strictEqual(app.addedTransactions.length, 0);

    app.actual.addTransactions = async (accountId, transactions) => {
      app.addedTransactions.push({ accountId, transactions });
      return "ok";
    };

    const second = await app.inject({
      method: "POST",
      url: "/vietqr-transaction",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      payload: { rawText: FIXTURE },
    });
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(JSON.parse(second.body).duplicate, undefined);
    assert.strictEqual(app.addedTransactions.length, 1);
    await app.close();
  });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/vietqr-transaction.test.js`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add src/routes/vietqrTransaction.js src/plugins/env.js src/server.js test/vietqr-transaction.test.js
git commit -m "Rewire /vietqr-transaction onto the template engine"
```

---

### Task 9: Delete the code-based adapter and run full regression

**Files:**
- Delete: `src/adapters/bidv.js`, `src/adapters/index.js`
- Delete: `test/bidv-adapter.test.js`, `test/adapter-registry.test.js`

- [ ] **Step 1: Delete the adapter files and their tests**

```bash
git rm src/adapters/bidv.js src/adapters/index.js test/bidv-adapter.test.js test/adapter-registry.test.js
```

- [ ] **Step 2: Confirm nothing else references `src/adapters`**

Run: `grep -rn "adapters" src/ test/ --include="*.js" | grep -v "src/templates" | grep -v "node_modules"`
Expected: no output (only `src/templates/*` files, if any, would mention "adapter" in comments — none currently do, so expect a fully empty result)

- [ ] **Step 3: Run the full test suite**

Run: `node --test test/*.test.js`
Expected: every test file passes except `test/transaction.test.js` and `test/initialization.test.js`, which require a real Actual server (`ACTUAL_URL`, `ACTUAL_PASSWORD`, etc.) not available in this sandbox — run those on the VM/CI before merging, per Global Constraints.

- [ ] **Step 4: Commit**

```bash
git commit -m "Remove code-based BIDV adapter, superseded by config/templates.json"
```
