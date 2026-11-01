# Contributing to Credora

Thank you for looking at Credora. It is a small project, so the rules are short.

## Before you start

All data in Credora is synthetic. Sapphire Bank, its customers and their records are invented by the generator in `mocks/generator`. Never add real customer, company or bank data, and never commit a filled-in `.env.<name>` file or anything from `deployments/`.

## Run the checks

Everything below runs without AWS, Exasol or Docker. The same jobs run in GitHub Actions on every push and pull request (`.github/workflows/ci.yml`). You need Python 3.12 and Node.js 22.

```bash
# Backend
pip install -r backend/requirements-dev.txt
cd backend && python -m pytest -q && cd ..

# Exasol UDFs, run in exasol/udf-mock-python without a database
pip install -r tests/udf/requirements.txt
cd tests/udf && python -m pytest -q && cd ../..

# Mock data generator
pip install -r mocks/generator/requirements-dev.txt
cd mocks/generator && python -m pytest -q tests && cd ../..

# Web app, type check and build
cd frontend && npm ci && npm run build && cd ..
```

To click through the web app without a backend, run `npm run dev:fixtures` in `frontend/` and open http://localhost:5173. The README section "Running pieces locally on the starter kit" says what else runs on a laptop with the Exasol Personal Local Starter Kit, and what needs AWS.

## Branches and pull requests

- Branch from `develop`. Name the branch after the change, for example `fix/purge-skip-while-running`.
- Keep a pull request to one change. Describe what it does and how you checked it, using the template.
- Pull requests go to `main`. CI must pass before merge.
- If the change touches an Exasol object, a screen or a deploy step, update the docs in the same pull request (`README.md`, `docs/`, the diagrams and the docs site), because the docs describe the live system.
- A change to a UDF or a Lua script should come with a test in `tests/udf` or `backend/tests` where one can run without a database.

## Wording

Plain English, short sentences, no marketing words, and the terms the project already uses, such as "companies analysed", "credit need on file" and "pre-approved offer".

## Questions

Open an issue. For anything security-related, read [SECURITY.md](SECURITY.md) first.
