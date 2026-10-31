# Thin wrappers around deploy/credora.py. Usage: make deploy ENV=credora
PY := deploy/.venv/bin/python
ifeq ($(OS),Windows_NT)
PY := deploy/.venv/Scripts/python
endif

.PHONY: setup deploy ship exasol generate status destroy

setup:
	uv venv deploy/.venv && uv pip install -p deploy/.venv -r deploy/requirements.txt

deploy ship exasol generate status destroy:
	$(PY) deploy/credora.py $@ --env $(ENV)
