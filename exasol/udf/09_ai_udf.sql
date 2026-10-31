-- CREDORA.CREDIT_MEMO: generative AI inside Exasol. For each company it sends the decision, the
-- numbers and the model's top risk drivers to Claude and returns a short credit memo in plain
-- English for the relationship manager. The API key lives in the CONNECTION object AI_LLM, which
-- the deploy tool creates only when an Anthropic API key is configured.
--
-- Usage (the web app runs this as CREDORA_SVC from the Credit memo panel of the Exasol report and
-- stores the result in CREDORA.MEMOS):
--   SELECT CREDORA.CREDIT_MEMO('AI_LLM', 'claude-sonnet-5-5', d.CIF_ID, <facts as JSON>) ...

CREATE OR REPLACE PYTHON3 SCALAR SCRIPT CREDORA.CREDIT_MEMO(
  conn_name VARCHAR(100), model VARCHAR(80), cif_id VARCHAR(8), facts VARCHAR(20000))
EMITS (cif_id VARCHAR(8), memo VARCHAR(20000)) AS
import requests

SYSTEM = (
    "You are a senior credit officer at an Indian bank writing for a relationship manager. "
    "The bank approaches existing corporate customers with pre-approved loan offers; the facts describe one "
    "company, its indicated credit need and the pre-approved offer. "
    "Write a credit memo of at most 120 words in four short labelled lines: Decision, Why, Watch, Negotiate. "
    "Use only the facts given. Amounts are in Indian rupees; write them in lakh or crore. "
    "Do not invent numbers. Plain words, no markdown."
)

def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    r = requests.post(
        f"{conn.address}/v1/messages",
        headers={"x-api-key": conn.password, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": ctx.model, "max_tokens": 400, "system": SYSTEM,
              "messages": [{"role": "user", "content": ctx.facts}]},
        timeout=60,
    )
    r.raise_for_status()
    text = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
    ctx.emit(ctx.cif_id, text.strip())
/
