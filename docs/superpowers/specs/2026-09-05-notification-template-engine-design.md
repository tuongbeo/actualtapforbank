# Notification Template Engine (config-driven bank-email/push parsing) — Design

Status: draft, awaiting user review
Scope: Sub-project A only — config-driven matching/extraction engine, replacing the code-based
BIDV adapter merged in PR #3. Sub-project B (Admin UI + Keycloak SSO for managing templates) is
a separate, later spec — see §9.

## 1. Context

`actualtapforbank` (fork of ActualTap) has `POST /transaction` (structured payload from iOS
Shortcuts Tap-to-Pay) and, as of PR #3 (merged, commit `050e5b6`), `POST /vietqr-transaction`
(raw bank-email text → transaction), which uses a **code-based adapter registry**:
`src/adapters/index.js` holds a hard-coded array `ADAPTERS = [bidv]`; adding a new bank or a new
email/push format means writing a new JS file with `match()`/`parse()` and registering it.

The goal of this feature: let a new notification format (a different bank's email, or later a
push notification) be added by **editing configuration**, not by writing code — while every
Shortcut/Tasker/Automate/Home Assistant automation on the client side keeps doing the same
simple thing it already does for `/vietqr-transaction`: capture raw text, POST it, unchanged.

This spec covers only the **engine** (matching + field extraction driven by a config file). A
web UI for authoring templates, and Keycloak SSO for that UI (reusing the same Keycloak instance
Actual Budget's own server already uses), are deferred to a separate spec (Sub-project B, §9) —
decomposed out because they roughly double the scope (a UI plus a new OIDC auth layer this
Fastify app doesn't have today) and depend on this engine existing first.

## 2. Goals / Non-goals

**Goals:**
- Replace `src/adapters/*` with a config file (`config/templates.json`) read once at startup.
- Each template declares: match criteria, field-extraction rules (label-based by default, regex
  override when needed), a fixed transaction `direction`, and which fields are required.
- Migrate the existing BIDV (expense) adapter into the first template, with no behavior change
  observable from `POST /vietqr-transaction`'s outside contract (same fixture, same expected
  response shapes) except the two explicitly-approved additions in §6 (`imported_id`) and §5
  (ambiguous-match becomes a distinct 500, see below).
- Keep 100% of the already-merged supporting infrastructure unchanged: `accountResolver`,
  `dedupCache`, `actualAccounts`, `actualTransactions`.
- Template schema carries a `sourceType: "email" | "push"` field now (informational only) so a
  future push-notification source needs no schema migration — see §8.

**Non-goals (this spec):**
- No admin UI, no CRUD API, no Keycloak/OIDC integration — see §9.
- No hot-reload of `config/templates.json` — edit file, restart process (same operational model
  as `ACCOUNT_MAP`).
- No new bank templates beyond BIDV expense (MB, Vietcombank, ACB, Techcombank, BIDV income all
  remain deferred, same as the original VietQR spec's non-goals).
- No actual push-notification ingestion path — only the schema is push-ready.

## 3. Architecture

```
config/templates.json           // NEW — array of templates, loaded once at server startup
src/templates/schema.js         // NEW — validate config shape; throws (crashes startup) on error
src/templates/matcher.js        // NEW — identify(normalizedText, templates) => template | null (throws if >1 match)
src/templates/extractor.js      // NEW — extract(normalizedText, template) => parsed fields (throws if a required field is missing)
src/templates/dateFormat.js     // NEW — buildDateRegex(format) / toISODate(rawMatch, format)
src/lib/parseAmount.js          // NEW — extracted from transaction.js's inline parseAmount(), reused by both routes and the extractor
src/templates/index.js          // NEW — loadTemplates(configPath), re-exports identify()/extract()
src/routes/vietqrTransaction.js // MODIFY — use src/templates/* instead of src/adapters/*
src/adapters/*                  // DELETE (bidv.js, index.js)
src/plugins/env.js              // MODIFY — add optional TEMPLATES_CONFIG_PATH (default "config/templates.json")
```

Config is loaded once at process startup (same operational model as `ACCOUNT_MAP`): read
`TEMPLATES_CONFIG_PATH` (optional env var, default `config/templates.json`); if the file doesn't
exist, `templates = []` (matches nothing — existing deployments that haven't adopted this feature
are unaffected, same soft-rollout pattern as `ACCOUNT_MAP`). If the file exists but fails schema
validation, the server **fails to start** with a clear error naming the template and the problem
— a broken config must never silently disable itself.

All of `accountResolver`, `dedupCache`, `actualAccounts`, `actualTransactions` are reused
unchanged from PR #3.

## 4. Template schema

> **Amendment (post-merge, found while writing the implementation plan):** the version below
> replaces the one originally merged. Tracing the extraction logic by hand against the real
> `bidv-expense` fixture surfaced two correctness bugs in the original §4/§6 — see the
> "Amendment rationale" box after the example. Both are fixed here: `label` may now be a chain
> (array) of consecutive labels, and `stopLabel` is mandatory for every label-based field (the
> auto-boundary-from-other-fields idea is dropped entirely).

```jsonc
{
  "name": "bidv-expense",              // unique across the config array; used in dedup key
  "sourceType": "email",               // "email" | "push" — descriptive only, no branching logic reads it yet
  "direction": "expense",              // "expense" | "income" — fixed per template, never inferred at parse time
  "match": {
    "contains": ["BIDV", "Số tham chiếu", "Số tiền giao dịch", "Tài khoản nguồn"]
    // ALL strings must appear (case-insensitive substring match) for this template to be selected
  },
  "fields": {
    "referenceCode":       { "label": ["Số tham chiếu:", "Reference number:"], "stopLabel": "Tài khoản nguồn:" },
    "sourceAccountNumber": { "label": ["Tài khoản nguồn:", "Debit account:"], "stopLabel": "Số tiền giao dịch:" },
    "amount":              { "label": ["Số tiền giao dịch:", "Transaction amount:"], "type": "amount", "stopLabel": "Phí giao dịch:" },
    "transactionDate":     { "label": ["Thời gian giao dịch:", "Transaction time:"], "type": "date", "format": "DD/MM/YYYY HH:mm:ss", "stopLabel": "Số tham chiếu:" },
    "counterpartyName":    { "label": ["Tên người thụ hưởng:", "Beneficiary name:"], "stopLabel": "Số tài khoản" },
    "description":         { "label": ["Nội dung giao dịch:", "Transaction remark:"], "stopLabel": "Kênh thực hiện giao dịch:" }
  },
  "requiredFields": ["referenceCode", "amount", "transactionDate", "sourceAccountNumber", "counterpartyName", "description"],
  "descriptionSuffix": "Ref: {referenceCode}"   // optional; {fieldName} placeholders filled from extracted fields
}
```

`label` is a string for a single label, or an **array of consecutive labels** when the raw text
carries more than one label in a row before the value (e.g. this bank's bilingual
Vietnamese-then-English label pairs: `"Số tham chiếu:\nReference number:\n6247..."`). All labels
in the array are matched consecutively (each separated by `\s*` in the built pattern) and
consumed; the value capture starts only after the last one.

`stopLabel` is **mandatory** on every label-based field (not optional) — see the amendment
rationale below for why. It is always a single string (a lookahead anchor, never consumed,
so it doesn't need chain semantics the way `label` does).

A field may instead declare a manual regex override, bypassing `label`/`stopLabel`/`type`
entirely:

```jsonc
"counterpartyName": { "regex": "Tên người thụ hưởng:\\s*(?:Beneficiary name:\\s*)?(?<value>[A-Z][A-Z\\s]*?)\\s*(?=Số tài khoản)" }
```

The regex **must** contain a named capture group `value`; config validation (§7) rejects a
`regex` field without one at startup.

### Amendment rationale (why `label` is a chain and `stopLabel` is mandatory)

Two bugs surfaced by tracing the extraction algorithm by hand against the real
`test/fixtures/bidv-expense.txt`, both invisible from the schema shape alone:

1. **Bilingual label pairs.** Every field in the real email is three lines — Vietnamese label,
   English label, value (e.g. `Số tham chiếu:` / `Reference number:` / `6247BIDVE2NEKZD1`). A
   schema with one `label` per field can't express "skip this second label too" without falling
   back to a manual `regex` for every field — which would defeat the whole point of label-based
   extraction being the default. Fixed by letting `label` be an array of consecutive labels.
2. **Auto-boundary broke on undeclared fields sitting between two declared ones.** The version
   of §6 originally merged said a field without an explicit `stopLabel` stops at whichever
   *other declared field's* label comes next. But the real email has fields the template has no
   reason to declare — e.g. `Phí giao dịch:` / `Transaction fee:` / `Miễn phí` sits between
   `amount` and `counterpartyName`. Under the old rule, `amount` (no `stopLabel`) would capture
   all the way through to `counterpartyName`'s label, swallowing `"10,000 VND Phí giao dịch:
   Transaction fee: Miễn phí"` as its raw value. This particular fixture still parses to the
   right number by luck (`parseAmount` strips everything but digits, and "Miễn phí" has none),
   but a bank charging a non-zero fee would corrupt the amount. Fixed by dropping the
   auto-boundary idea entirely: `stopLabel` is required on every label-based field, so a template
   author always states exactly where a field's value ends, regardless of what undeclared text
   sits after it.

### Key design decision: `match.contains` must include the direction-discriminating label

`match.contains` for `bidv-expense` includes `"Tài khoản nguồn"` (the debit-account label) —
**not just** the three generic BIDV-transaction markers. Consequence: a BIDV **income** email
(which lacks that label) does not match this template at all, and falls through to
`400 "Unrecognized bank format"`.

This differs from the merged PR #3 adapter, where `match()` used only the 3 generic markers and
`parse()` then explicitly threw a specific `422 "BIDV incoming-transfer format is not supported
yet"` when the debit-account label was absent. That specific message is lost under this design.
In exchange: **`match` becomes the single source of truth** for "is this a format I handle" —
once matched, all `requiredFields` are expected to extract successfully; a `parse()`/`extract()`
failure after a successful match now signals the bank changed its email format (a real bug to
investigate), not an expected income-vs-expense branch to special-case. Approved by user during
brainstorming (see conversation) as an acceptable tradeoff for a config-driven system where a
developer isn't writing a per-case `throw` for every known variant.

## 5. Matching semantics (`src/templates/matcher.js`)

```
identify(normalizedText, templates):
  matches = templates.filter(t => t.match.contains.every(s => normalizedText.toLowerCase().includes(s.toLowerCase())))
  if matches.length === 0: return null
  if matches.length > 1: throw AmbiguousMatchError(`Multiple templates matched: ${matches.map(t => t.name).join(", ")}`)
  return matches[0]
```

Two or more templates matching the same `rawText` is a **configuration error** (the user wrote
overlapping `match.contains` across two templates), not a business case — the route surfaces it
as `500 { error: "Ambiguous template match", message }` rather than silently picking the first
match. This is new relative to PR #3 (which had only one adapter, so ambiguity was structurally
impossible).

## 6. Extraction semantics (`src/templates/extractor.js`)

For each field in `template.fields`, in the order declared:

1. **If `regex` is present**: run it against `normalizedText`; take the named group `value`.
2. **Else (label-based)**: `field.stopLabel` is required (config validation, §7, rejects a
   label-based field without one — there is no auto-detected boundary; see the amendment
   rationale in §4 for why an auto-boundary from other declared fields' labels was tried and
   dropped).
   - Normalize `field.label` to an array (`Array.isArray(label) ? label : [label]`).
   - Prefix pattern: the array's labels chained with `\s*` between each
     (`labels.map(escapeRegex).join('\\s*')`) — matches and consumes all of them in order.
   - Pattern: `` `${prefixPattern}\s*(.+?)\s*(?=${escapeRegex(stopLabel)}|$)` ``,
     case-insensitive.
   - Result is trimmed.
3. If no match and the field is in `requiredFields` → `extract()` throws
   `Error('Could not find "<fieldName>" in rawText')`.
4. **Type conversion** (applied to the raw extracted string), based on the field's declared
   `type` — there is no implicit type inference; omitting `type` always means plain string:
   - `type: "amount"`: parsed via `src/lib/parseAmount.js` (extracted verbatim from
     `transaction.js`'s existing locale-aware comma/dot amount parser — reused by both routes,
     not reimplemented).
   - `type: "date"` + `format`: `src/templates/dateFormat.js` turns `format` (tokens `YYYY`,
     `MM`, `DD`, `HH`, `mm`, `ss`; any other character is literal) into a regex against the
     label-extracted raw string, then reassembles `YYYY-MM-DD` from the matched groups. No new
     date-library dependency.
   - no `type` declared: the trimmed string, used as-is.
5. After all fields are processed, `descriptionSuffix` (if present) has its `{fieldName}`
   placeholders substituted from the extracted values and is appended to `description` (joined
   with `" · "`) if a `description` field exists, otherwise used standalone.

`extract()` returns the same shape the BIDV adapter's `parse()` returned:
`{ direction, amount, transactionDate, referenceCode, sourceAccountNumber, counterpartyName, description }`
— `direction` is copied straight from `template.direction` (fixed, never inferred).

## 7. Config validation (`src/templates/schema.js`)

Runs once at startup against the full loaded array. Fails fast (throws, server does not start)
listing every problem found, not just the first:

- Top level must be an array.
- Each template: `name` (non-empty string, unique across the array), `sourceType` (`"email"` or
  `"push"`), `direction` (`"expense"` or `"income"`), `match.contains` (non-empty array of
  non-empty strings), `fields` (non-empty object), `requiredFields` (array; every entry must be a
  key of `fields`).
- Each field: exactly one of `regex` or `label`.
  - `regex` must compile and contain a named group `value`; `stopLabel` and `type` must not be
    present alongside it (the regex defines its own boundary and, if needed, its own type
    conversion is out of scope — a `regex` field's captured `value` is always used as-is).
  - `label` is a non-empty string, or a non-empty array of non-empty strings (a label chain);
    when `label` is present, `stopLabel` is **required** (non-empty string) — a label-based field
    without a `stopLabel` fails validation at startup.
  - `type`, if present, is `"amount"` or `"date"`; `type: "date"` requires `format`, itself
    composed only of the recognized tokens (`YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, literal
    characters) and containing at least `YYYY`, `MM`, and `DD` (the extractor always reassembles
    a `YYYY-MM-DD` string, so all three must be extractable).
- `descriptionSuffix`, if present, is a string whose `{fieldName}` placeholders all reference
  keys of `fields`.

## 8. Route flow & error handling (`POST /vietqr-transaction`)

```
POST /vietqr-transaction { rawText, capturedAt }
  → normalize(rawText)                              // unchanged from PR #3
  → identify(normalizedText, templates)
       no template matches                            → 400 { error: "Unrecognized bank format" }
       more than one template matches                 → 500 { error: "Ambiguous template match", message } (§5)
  → extract(normalizedText, template)
       a requiredField can't be extracted              → 422 { error: "Failed to parse transaction", message }
  → resolveAccountName(parsed.sourceAccountNumber, ACCOUNT_MAP)   // unchanged
       not mapped                                       → 400 { error: "Unknown source account" }
  → dedupCache.checkAndMark(`${template.name}:ref:${parsed.referenceCode}` | `${template.name}:hash:${sha256(normalizedText)}`)
       duplicate within TTL                              → 200 { duplicate: true, ...parsed }
  → getAccountByName()                              // unchanged
  → build transaction (see field-mapping table below)
  → addTransaction() + syncBudget()                 // unchanged
```

**Transaction field mapping** (`parsed.*` → Actual's `ImportTransactionEntity`, verified against
the installed `@actual-app/api@26.9.0` / `@actual-app/core` type definitions and the real
`addTransactions()` implementation — see conversation for the verification):

| `parsed.*` | → Actual field | Note |
|---|---|---|
| `amount` × sign from `direction` | `amount` (× 100) | unchanged from PR #3 |
| `counterpartyName` | `payee_name` | unchanged |
| `description` (+ `descriptionSuffix`) | `notes` | unchanged |
| `transactionDate` | `date` | unchanged |
| `referenceCode` | **`imported_id`** | **new** — `ImportTransactionEntity.imported_id` exists exactly for "a unique id usually given by the bank"; PR #3 only used `referenceCode` for the dedup key and discarded it otherwise |
| — | `cleared: false` | kept as-is (overrides `addTransactions`'s own default of `true` when omitted — confirmed by reading `addTransactions$1` in `@actual-app/api`'s dist code) |
| `sourceAccountNumber`, `direction`, `sourceType` | *(not stored)* | routing/dedup only |

Note: `addTransactions()` does **not** itself dedup by `imported_id` (confirmed by reading its
implementation — it always assigns a fresh id and inserts) — the in-memory `dedupCache` remains
necessary. `imported_id` is added purely for correctness/visibility in Actual (bank reference
number visible on the transaction), not as a dedup mechanism.

## 9. BIDV migration + file structure

- Delete `src/adapters/bidv.js`, `src/adapters/index.js`, `test/bidv-adapter.test.js`,
  `test/adapter-registry.test.js`.
- Add `config/templates.json` with exactly one template, `bidv-expense`, built from the schema
  in §4. Reuses the existing real-email fixture `test/fixtures/bidv-expense.txt` unchanged, so
  the migration is verifiable against the same input that validated the original adapter.
- New tests replacing the deleted ones:
  - `test/templates/matcher.test.js` — multiple templates in the registry, selects the correct
    one; two templates both matching → throws (§5).
  - `test/templates/extractor.test.js` — exercises `type: "string" | "amount" | "date"`,
    `stopLabel`, and `regex` override against small synthetic fixtures (not bank-specific), so
    the mechanism is tested independently of BIDV's data.
  - `test/templates/bidv-expense.template.test.js` — runs the real `bidv-expense` template
    against the real fixture, asserting the exact same field set the old `bidv-adapter.test.js`
    asserted — proves the migration is behavior-preserving.
  - `test/templates/schema.test.js` — malformed config (missing `name`/`match`, a field with
    neither `label` nor `regex`, `type: "date"` without `format`, etc.) → throws at load time.
- `test/vietqr-transaction.test.js` (integration, 6 existing cases from PR #3) is kept, only its
  setup changes: inject a `templates` array instead of mocking `../adapters`.

## 10. Out of scope — Sub-project B (separate spec, later)

- Web admin UI to create/edit/test templates (with a "paste sample rawText, see extracted
  fields" preview).
- Authentication for that UI via the same Keycloak instance/realm Actual Budget's own server
  already uses (real OIDC client integration in this Fastify app — redirect login, token
  verification, session handling; there is no OIDC code in this app today).
- Building B on top of the `config/templates.json` file this spec produces — B can start by
  reading/writing that same file, or migrate to a different storage backend; that decision
  belongs to B's own spec.

## 11. Other deferred items (carried over from the original VietQR spec, still deferred)

- BIDV income template (needs a real "Tài khoản nhận"/"Tài khoản đích" email sample).
- Templates for MB, Vietcombank, ACB, Techcombank.
- Actual push-notification ingestion (iOS 27) — schema is ready (`sourceType`), ingestion path is
  not.
