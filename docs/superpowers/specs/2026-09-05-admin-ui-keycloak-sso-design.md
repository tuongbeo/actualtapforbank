# Admin UI + Keycloak SSO for Notification Templates — Design

Status: draft, awaiting user review
Scope: Sub-project B — a web admin UI for authoring the notification templates introduced
in Sub-project A (`docs/superpowers/specs/2026-09-05-notification-template-engine-design.md`,
merged), authenticated via the same Keycloak instance/realm Actual Budget's own server
already uses.

## 1. Context

Sub-project A replaced the code-based BIDV adapter with a config-driven template engine:
`config/templates.json`, validated and loaded **once at process startup**
(`src/templates/index.js`'s `loadTemplates`), consumed by `POST /vietqr-transaction`. Adding
or editing a template today means hand-editing that JSON file and restarting the container.

This spec adds a browser-based admin page to create, edit, delete, and test-preview templates
without hand-editing JSON or (per §5) without restarting the server. Access is gated by OIDC
login against the same Keycloak instance/realm that already protects Actual Budget's own
server — there is no OIDC/session code anywhere in this app today (confirmed: `package.json`
has no session, cookie, static-file, or OIDC-related dependency).

## 2. Goals / Non-goals

**Goals:**
- A single static HTML/CSS/vanilla-JS admin page (no build step, no frontend framework) served
  by this Fastify app, gated behind Keycloak login.
- CRUD over the templates in `config/templates.json`: list, create, update, delete.
- A "test-parse" preview: paste sample `rawText` against a draft (possibly unsaved) template
  and see the match/extract result, without creating a real transaction.
- Changes made through the UI take effect on `POST /vietqr-transaction` **immediately** — no
  container restart required (this is a deliberate change from Sub-project A's "restart
  required" model, scoped to this feature).
- The whole feature is **off by default**: if the Keycloak/session environment variables
  aren't configured, none of `/admin/*` is registered (404), so an existing deployment that
  hasn't adopted this feature is completely unaffected — same soft-rollout pattern as
  `ACCOUNT_MAP`/`TEMPLATES_CONFIG_PATH` in Sub-project A.
- Anyone who successfully authenticates against the configured Keycloak realm gets full
  template-admin access — no additional role/claim check.

**Non-goals:**
- No new persistence backend (database, etc.) — `config/templates.json` remains the source of
  truth; the UI reads and writes that same file.
- No multi-user roles/permissions beyond "authenticated or not."
- No audit log / version history of template edits.
- No changes to Sub-project A's matching/extraction semantics — this spec only adds a way to
  author `config/templates.json` through a browser instead of by hand, plus the minimal plumbing
  needed for those edits to take effect without a restart.
- No push-notification-specific admin features (still out of scope per Sub-project A's §11).

## 3. Architecture

```
src/plugins/env.js              // MODIFY — add optional KEYCLOAK_ISSUER_URL, KEYCLOAK_CLIENT_ID,
                                 //   KEYCLOAK_CLIENT_SECRET, SESSION_SECRET, APP_BASE_URL
src/templates/store.js          // NEW — in-memory templates + config/templates.json read/write,
                                 //   the single source both /vietqr-transaction and the admin
                                 //   API read/write through
src/plugins/auth.js             // NEW — OIDC login/callback/logout, session, /admin/* guard
src/plugins/staticAdmin.js      // NEW — serves public/admin/index.html under /admin/
src/routes/adminTemplates.js    // NEW — CRUD + preview JSON API under /admin/api/
public/admin/index.html         // NEW — the one-page admin UI (HTML + inline CSS/JS)
src/routes/vietqrTransaction.js // MODIFY — read templates from the shared store instead of a
                                 //   closed-over array (see §6)
src/server.js                   // MODIFY — construct the templates store once; only register
                                 //   auth/staticAdmin/adminTemplates when Keycloak env vars are
                                 //   fully configured
package.json                    // MODIFY — add openid-client, @fastify/session,
                                 //   @fastify/cookie, @fastify/static
```

**Feature flag:** `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`,
`SESSION_SECRET`, and `APP_BASE_URL` are all optional in the env schema (no defaults — absence
means "off"). `server.js` checks whether all five are present; if not, `/admin/*` is never
registered. If some but not all are set, the server fails to start with a clear error naming
which ones are missing (partial configuration is almost certainly a mistake, not an intentional
"off" state — silently ignoring it would hide a misconfiguration).

`/admin/*` is excluded from the existing global `X-API-KEY` `preHandler` hook in `server.js`
(the same way `/health` already is) — it is guarded by the session check in `auth.js` instead.

## 4. Auth flow (OIDC — Authorization Code + PKCE)

```
Any GET /admin/* request without a valid authenticated session
  → 302 redirect to /admin/login?returnTo=<original path>

GET /admin/login
  → generate PKCE code_verifier + state, stash in the (unauthenticated) session
  → 302 redirect to the Keycloak authorization endpoint (discovered via KEYCLOAK_ISSUER_URL)

GET /admin/callback?code=...&state=...
  → verify state matches the session's stashed value
  → exchange code for tokens (with code_verifier) via openid-client
  → openid-client verifies the ID token (issuer, audience, signature)
  → store { sub, preferred_username/email } in the now-authenticated session
  → 302 redirect to returnTo (default /admin/)

POST /admin/logout
  → destroy the session
  → 302 redirect to the Keycloak end-session endpoint if the issuer advertises one, else to /admin/login
```

**Library:** `openid-client` (the standard, spec-compliant Node OIDC client) for discovery,
PKCE, code exchange, and ID token verification. `@fastify/cookie` + `@fastify/session` for the
session cookie, signed with `SESSION_SECRET` (required, validated at startup to be a non-empty
string of at least 32 characters — same validate-at-startup pattern Sub-project A used for
`ACCOUNT_MAP`'s JSON shape). Session store is the in-memory default (no Redis) — acceptable for
a single-instance self-hosted deployment; a restart requires re-authentication, which is
expected self-hosted-admin-panel behavior, not a defect.

**Authorization:** a valid, successfully-verified session is sufficient — no role or group
claim is checked, per the confirmed access-scope decision.

**`APP_BASE_URL`** (new, required alongside the other four): the externally-reachable base URL
of this deployment (e.g. `https://actualtap.yourdomain.com`), used to build the OIDC
`redirect_uri` (`${APP_BASE_URL}/admin/callback`) and the post-logout redirect. The operator
must register this exact `redirect_uri` in the Keycloak client they create for this app.

## 5. Templates store + hot-reload (`src/templates/store.js`)

Sub-project A's `server.js` calls `loadTemplates()` once and passes the resulting array into
`vietqrTransaction`'s route registration as `opts.templates` — the route handler closes over
that array for the lifetime of the process. For admin edits to take effect without a restart,
both `/vietqr-transaction` and the new admin API must read through one shared, mutable
reference instead.

```js
// src/templates/store.js
createTemplatesStore(configPath) => {
  getTemplates() => Array                     // current in-memory templates
  replaceAll(newTemplates) => void             // throws (does NOT write or mutate state) if
                                                //   validateTemplates(newTemplates) fails;
                                                //   otherwise: write configPath, then update
                                                //   the in-memory array
}
```

`replaceAll` always validates the **entire** resulting array (not just the one template being
added/edited) — this is what catches a duplicate `name` across templates, exactly as
`validateTemplates` was designed to in Sub-project A. On validation failure, neither the file
nor the in-memory array is touched — the store is left exactly as it was.

**Required change to already-shipped Sub-project A code** (`src/routes/vietqrTransaction.js`):
replace the closed-over `const templates = opts.templates || [];` with reading through a passed
store:
```js
const templatesStore = opts.templatesStore; // { getTemplates(): Array }
// inside the request handler, where `templates` was previously used:
const templates = templatesStore.getTemplates();
```
`server.js` constructs one `templatesStore` (via `createTemplatesStore`) and passes the same
instance as `opts.templatesStore` to both `vietqrTransaction` and the new `adminTemplates`
route. A CRUD write via the admin API calls `replaceAll()`; the very next `/vietqr-transaction`
request reads the updated array — no restart, no polling, no file-watching needed, since both
routes go through the same in-memory object.

This changes `vietqrTransaction.js`'s registration option name from `templates` to
`templatesStore` — `test/vietqr-transaction.test.js` (Sub-project A) must be updated to inject
a store object instead of a raw array; see §8.

## 6. CRUD API (`src/routes/adminTemplates.js`, under `/admin/api/`, guarded by `auth.js`)

| Method + path | Behavior |
|---|---|
| `GET /admin/api/templates` | Returns `templatesStore.getTemplates()` as JSON. |
| `POST /admin/api/templates` | Body is one template object. Appends it to the current array and calls `replaceAll()`. A `name` that already exists in the current array → `409 { error: "Template already exists" }` before even attempting `replaceAll` (a clearer message than the generic duplicate-name validation error). |
| `PUT /admin/api/templates/:name` | Body is one template object that fully replaces the existing entry whose `name` equals the `:name` path param (the body's own `name` may differ, effectively renaming it). No existing entry matches `:name` → `404`. If the body's `name` collides with a *different* existing entry, `replaceAll`'s whole-array validation catches it (duplicate name) and returns `400` — no separate collision check is needed for this route. |
| `DELETE /admin/api/templates/:name` | Removes the entry whose `name` equals `:name`, then `replaceAll()`. No match → `404`. |

Any `replaceAll()` validation failure (from any of the three mutating routes) → `400` with the
same aggregated error message `validateTemplates` already produces (reused verbatim, not
reimplemented).

## 7. Preview endpoint (`POST /admin/api/preview`)

```
Body: { rawText: string, template: <draft template object, not yet persisted> }

→ validateTemplates([template])            // schema-check the draft alone
     invalid                                  → 400 { error: "Invalid template", message }
→ normalizedText = normalize(rawText)
→ identify(normalizedText, [template])     // reused as-is from src/templates/matcher.js —
                                            //   with a single-element array it can never
                                            //   throw AmbiguousMatchError, so it only ever
                                            //   returns the template itself or null
     returns null (no match)                  → 200 { matched: false }
→ extract(normalizedText, template)        // reused as-is from src/templates/extractor.js
     throws                                    → 200 { matched: true, error: "<message>" }
     succeeds                                  → 200 { matched: true, parsed: {...} }
```

Reuses `identify`/`extract` verbatim from Sub-project A rather than reimplementing matching —
calling `identify` with a single-element array is exactly "does *this* draft template match
*this* sample text", with no risk of `AmbiguousMatchError` since there is nothing else in the
array to conflict with. This bypasses the full-registry ambiguous-match check that would apply
at `/vietqr-transaction`, which is the point: preview must work for a template that isn't saved
yet (and might, once saved, turn out to overlap with another template — that's `/vietqr-transaction`'s
concern, not preview's). No transaction is created; no call to `fastify.actual` is made.

## 8. Admin UI (`public/admin/index.html`)

One static HTML file (inline `<style>`/`<script>`, no bundler, no framework), served via
`@fastify/static` under `/admin/`. Three sections:

1. **Template list** — name, `sourceType`, `direction` for each entry from
   `GET /admin/api/templates`; clicking one loads it into the editor.
2. **Editor** — a raw JSON textarea for the template object (not a field-by-field form — the
   schema is technical enough, and the operator is the same person who already hand-authored
   `config/templates.json` in Sub-project A, that a JSON textarea plus the preview panel below
   is sufficient and far simpler to build than a structured form). Save calls
   `POST`/`PUT /admin/api/templates`; validation errors from the API are shown inline.
3. **Preview panel** — a `rawText` textarea plus a "Test" button that calls
   `POST /admin/api/preview` with the editor's current (unsaved) JSON and displays
   `matched`/`parsed`/`error`.

## 9. Testing plan

- **`src/templates/store.js`**: `replaceAll` rejects an invalid array without writing the file
  or mutating in-memory state (assert both the file's mtime/content and `getTemplates()` are
  unchanged after a rejected call); a valid `replaceAll` updates both.
- **`src/routes/adminTemplates.js`**: CRUD happy paths (create/list/update/delete) plus
  `404`/`409`/`400` cases, using a fake `templatesStore` (mirroring the existing mock-server
  pattern from `test/vietqr-transaction.test.js`).
- **`src/routes/adminTemplates.js` preview**: matched+parsed, not-matched, invalid-draft-schema,
  and extract-throws cases.
- **Hot-reload, end-to-end**: register both `vietqrTransaction` and `adminTemplates` against the
  *same* `templatesStore` instance in one test server; `POST /admin/api/templates` a new
  template, then immediately `POST /vietqr-transaction` with matching `rawText` and assert it is
  recognized — this is the test that proves the central "no restart required" requirement.
- **`src/plugins/auth.js`**: unit-testable pieces (state/PKCE verifier generation and matching,
  session shape after a simulated callback) without a real Keycloak — use a minimal fake issuer
  or mock `openid-client`'s discovery/token-exchange calls. `test/vietqr-transaction.test.js` is
  updated for the `templatesStore` option rename (§5) but otherwise unchanged.
- **Feature-flag off**: with none of the five Keycloak env vars set, `/admin/` returns `404` and
  the server starts normally (regression check against Sub-project A's existing test suite).

## 10. Out of scope (carried over, still deferred)

- Audit trail / version history for template edits.
- Role-based access within the admin UI.
- A structured (non-JSON-textarea) template editor.
- Any of Sub-project A's own deferred items (additional bank templates, push-notification
  ingestion, BIDV income direction).
