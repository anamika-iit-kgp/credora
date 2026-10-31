# Credora web app

The browser front end of Credora, built with React 18, TypeScript, Vite, React Router and TanStack Query. It talks only to the Credora backend under the relative path `/api/...` (see [`docs/API.md`](../docs/API.md)), so the same build works on any domain.

## Run

```sh
cd frontend
npm install

npm run dev            # http://localhost:5173, /api proxied to the FastAPI backend on http://localhost:8000
npm run dev:fixtures   # no backend needed: /api is answered in the browser with synthetic fixtures
npm run build          # type-checks, then writes static files to frontend/dist
npm run preview        # serves dist locally
```

`npm run build` produces plain static files. Caddy serves `frontend/dist` at the site root and sends `/api/*` to the backend. Every unknown path must fall back to `index.html` so that deep links such as `/companies/C000042/report` work:

```caddyfile
{$DOMAIN} {
	handle /api/* {
		reverse_proxy api:8000
	}
	handle {
		root * /srv/frontend
		try_files {path} /index.html
		file_server
	}
}
```

## Fixture mode

`npm run dev:fixtures` (Vite mode `fixtures`), or any build with `VITE_USE_FIXTURES=1`, installs an in-browser stand-in for the API (`src/fixtures/`). It follows `docs/API.md` and answers every endpoint the screens use, with deterministic synthetic data.

- 1,000 companies with 2–5 partners each, accounts and transactions, the credit need on file, CIBIL reports, 2–10 years of GST returns and Account Aggregator accounts, all generated from a seed.
- A decision engine that mirrors `CREDORA.DECIDE` for PD, grade, offer, negotiation limit, RAROC, rank, Top 50 and what-if.
- Jobs (generate, analysis, train) that progress step by step when polled, and offers that move through propose, escalate, verify, sanction and reject.

In fixture mode any password works, the demo-user buttons on the sign-in page sign in at once, and `?as=admin|datasci|loanops|rm` on any URL signs in as that role. State such as the seed, runs, models and offer changes is kept in `localStorage` under `credora.fixtures.v2`. Clear it to start over.

The fixture code is loaded with a dynamic `import()` behind a condition that Vite replaces at build time, so a normal `npm run build` contains none of it.

## Roles

Navigation and actions follow the Roles column of `docs/API.md` (`src/lib/roles.ts`). The backend enforces access, and the UI only hides what a role cannot use.

| Role | Screens |
|---|---|
| `admin` | Overview, data explorer, offer pipeline, analysis runs, decisions, Top 50, risk models, Ask Credora, data generation, sources, audit and purge |
| `datasci` | Overview, data explorer, analysis runs, decisions, Top 50, risk models (train, activate), what-if, Ask Credora, sources |
| `loanops` | Overview, data explorer (bank data only), approval queue (verify, sanction, reject), run analysis, decisions, Top 50, reports, Ask Credora |
| `rm` | Overview, data explorer (own companies, masked IDs), my pipeline, negotiation, Top 50, reports, Ask Credora |

The backend reads Exasol as the signed-in role's own Exasol user (`CREDORA_ADMIN`, `CREDORA_DATASCI`, `CREDORA_LOANOPS`, `CREDORA_RM`), and Ask Credora's MCP server logs in as the same user, so Exasol's grants decide what each screen and each AI answer can contain. The demo logins are `admin`, `datasci`, `loanops` and `rm`, all with password `Demo@123`, and the sign-in page has one-click buttons for each.

## Provenance

Every record carries the `source` field from the API. `src/lib/sources.ts` maps it to a label, and `SourceTag` draws it the same way everywhere.

| Kind | Sources | Mark |
|---|---|---|
| Sapphire Bank data | `bank.oracle`, `bank.mysql`, `bank.postgres` | sapphire, solid border, bank (landmark) icon |
| 3rd party API (mock), fetched on demand | `api.cibil`, `api.gstn`, `api.aa` | plum, dashed border, globe icon |
| Computed in Exasol | `exasol` | teal, processor icon |

Shape and text carry the meaning as well as colour, so the tags still read in greyscale and for colour-blind users.

## Structure

```
src/
├─ main.tsx              boot; installs fixtures in fixture mode
├─ App.tsx               routes and role gates
├─ api/                  client (bearer token, errors), types, TanStack Query hooks
├─ auth/                 sign-in state
├─ explain/              Explain mode: glossary, page and action content, hints, popover, action notes, Exasol console, badges
├─ components/           shell, source tags, provenance tree, record panel, job progress, code block, UI parts
├─ lib/                  Indian number formatting, roles, sources, SQL/Lua/Python highlighter
├─ pages/
│  ├─ Login.tsx, Overview.tsx
│  ├─ admin/             data generation, sources, audit and purge
│  ├─ explorer/          company list, company tree and records
│  ├─ report/            Exasol report: decision, offer and limit, SHAP reasons, steps with code
│  ├─ analysis/          runs, decisions, Top 50
│  ├─ models/            risk models, what-if
│  ├─ ask/               Ask Credora: questions, answers and the SQL each MCP tool call ran
│  ├─ exasol/            Exasol control room: the database as the signed-in role's Exasol user sees it
│  ├─ glossary/          every Explain mode term, searchable
│  └─ offers/            pipeline, negotiation, approval queue
├─ fixtures/             synthetic API for fixture mode (not in production builds), incl. a simulated Exasol console and control room
└─ styles/               design tokens (light and dark), base, components, pages
```

## API assumptions

`docs/API.md` fixes the paths and the main fields. Where it leaves a shape open, the app expects what `src/api/types.ts` describes.

- Lists may be a bare array or `{items: [...]}`. `/companies` and `/decisions` return `{items, total, page, size}`.
- `/overview` returns `{counts:{companies, partners, applications, accounts}, last_generation:{seed, generated_at}|null, last_analysis:{run_id, finished_at, duration_ms, model_version}|null, decision_mix:{APPROVE, REFER, DECLINE}|null, sources:[...]}` with `sources` in the `/admin/sources` shape.
- `/runs` items are `{run_id, status, started_at, finished_at, started_by, model_version, companies, approve, refer, decline, stages:[{name, ms}]}`.
- `/companies/{cif}/report` returns `{decision, grade, pd (0–1), rank_no, rank_of, raroc (%), offer:{amount, roi, tenure}|null, limit:{max_amount, floor_roi, max_tenure}|null, requested, offer_id, reasons:[{feature, text, contribution, source}], features:[{name, label, value, unit, source}], steps:[{n, name, what, engine, object, language: sql|lua|python, code, sources, ms}], sources_used}`. A positive `contribution` raises the risk of default. `404` means no analysis has run yet.
- In `/nodes/{id}`, `columns` are column names and `meta` may carry `table` and `database` (bank) or `endpoint` (3rd party API) to say where the records were read.
- `/ml/models` items are `{version, algorithm, trained_at, trained_by, train_rows, auc, gini, active, feature_importance:[{feature, importance}]}`.
- `/whatif` returns `{params, baseline, before, after}`, where `before` and `after` are decision counts.
- `/offers` items carry the `crm.offer` columns plus `legal_name`. An offer with agreed terms at stage `NEGOTIATING` counts as proposed and waits for verification. `ESCALATED` waits too, and `VERIFIED` waits for sanction.
- `/admin/audit` items are `{at, username, role, action, target, detail}`. `/admin/purge-log` items are `{purged_at, table_name, source, rows, sha256, purge_due}`.
