# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Router (`9router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `9router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `9router`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `npm test`):
```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> The committed `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — a shared-install workaround from upstream. On Windows (or anywhere), ignore it and use the `npx vitest` form above; `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **The suite is NOT expected to be all-green on a plain checkout.** ~938 pass, ~64 fail. Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run. Expected red:
> - 26 catalogued in `tests/__baseline__/known-fails.txt` (rtk, oauth-cursor-auto-import, translator-request-normalization, …).
> - `unit/embeddings.cloud.test.js` imports `cloud/src/handlers/embeddings.js` — the `cloud/` worker dir is **not in this repo**, so it always fails here.
> - `unit/xai-oauth-service.test.js` times out (5s) when the xAI endpoint-discovery fetch isn't reachable/mocked.
> - `real/*.real.test.js` make live provider calls — need credentials, skip otherwise.
- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`).
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- **Schema changes are declarative, not migration files** (this corrects the "Schema/migrations" line above): adding a table/column/index = edit `TABLES` in `src/lib/db/schema.js` + bump `SCHEMA_VERSION`; `syncSchemaFromTables()` then auto-applies `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` at startup, including on existing DBs. Only *destructive* changes (drop/rename/type change) need a file under `src/lib/db/migrations/`.
- **DB table names are camelCase — the usual "Model class name → snake_case plural" habit does NOT apply here.** Read `TABLES` in `src/lib/db/schema.js` before writing any SQL against the app DB. So the connection table is `providerConnections` (not `connections`, not `provider_connections`); there is no `connections` table. Per-entity business fields are not columns — they live in that table's `data` JSON blob. Querying the live DB at `%APPDATA%/9router/db/data.sqlite` via `node:sqlite` is documented in `[[9router-db-query]]` memory.
- **`node --check` passing does NOT mean the build passes.** Turbopack enforces more than Node's parser — e.g. `await` inside a non-`async` arrow function inside an object literal passes `--check` but fails `next build` ("await isn't allowed in non-async function"). Always run a real build before declaring code good; `--check` is a fast pre-filter only.
- **`src/instrumentation.js` `register()` can run BEFORE Next loads `.env`** (notably under the standalone custom server). Any env read there sees `undefined` and fails silently. It now calls `loadEnvConfig(process.cwd(), false)` (`@next/env`) first. Symptom of this class of bug: a variable passed on the command line works, the same variable only in `.env` does not.
- **Never hand-build an object literal when forwarding a shared context object** (e.g. `traceContext` from `chat.js` into `handleChatCore`). Listing fields explicitly silently drops newly-added ones — this bit twice in one session (`attemptSpanContext`, then `rootSpan`). Pass the shared object itself and mutate per-call fields on it, so writes made downstream (`langfuseGen`, `streamingPending`) are visible to the caller too.
- **Executors must not mutate the caller's request body.** `transformRequest` receives a private copy (`copyForTransform` from `executors/base.js`) and may edit it freely — but an executor that defines its **own `execute()`** and calls `this.transformRequest(model, body, …)` directly must pass `copyForTransform(body)` itself, or it will leak gateway edits back into `chatCore`'s body (skewing what observability records as the "client request" and re-transforming on retry). Every executor belongs to one of those two shapes; check which before adding one. Verify by comparing a trace's Client Request vs Provider Request — they must differ when the gateway injects anything.
- Local build/verify gotchas:
  - The `@/*` alias resolves only inside Next's build and vitest (`tests/vitest.config.js`). Plain `node -e "import … from './src/…'"` fails with `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'` — exercise DB-layer code through a vitest file in `tests/` instead.
  - This vitest has no `basic` reporter: `--reporter=basic` fails to load. Use `--reporter=json --outputFile=<path>` for machine-readable results.
  - Rebuilding `.next/standalone` fails with `EBUSY … rmdir '.next/standalone'` while a 9router instance is running from this repo (port 20130) — stop it first.
  - The running service executes Next's **bundled** server chunks, not the loose files under `.next/standalone/open-sse/**` — editing those copies to probe behavior has no effect (observed: injected `console.log` never fired).
  - When A/B-ing against pre-change behavior via `git stash push -- <files>`, untracked new dirs (e.g. a new `src/app/api/*` route) still get compiled and break the build because their imports are gone — move them aside for the control build.
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).
