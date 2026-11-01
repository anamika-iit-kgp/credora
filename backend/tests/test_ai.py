import asyncio
import dataclasses
import json
from types import SimpleNamespace as NS

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import ai, assistant, memo
from app.auth import issue_token, make_user
from app.main import app


def test_mcp_tools_become_anthropic_tools_without_session_settings():
    mcp_tools = [
        NS(name="execute_exasol_query", description="Run a SELECT",
           inputSchema={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}),
        NS(name="list_exasol_schemas", description=None, inputSchema={}),
        NS(name="set_exasol_preprocessor", description="Session setting", inputSchema={"type": "object"}),
    ]
    tools = assistant.to_claude_tools(mcp_tools)
    assert [t["name"] for t in tools] == ["execute_exasol_query", "list_exasol_schemas"]
    assert tools[0] == {"name": "execute_exasol_query", "description": "Run a SELECT",
                        "input_schema": mcp_tools[0].inputSchema}
    assert tools[1]["description"] == "list_exasol_schemas"
    assert tools[1]["input_schema"] == {"type": "object", "properties": {}}


def test_tool_result_text_and_clipping():
    r = NS(content=[NS(type="text", text='{"rows":[[1]]}')], structuredContent=None)
    assert assistant.result_text(r) == '{"rows":[[1]]}'
    assert assistant.result_text(NS(content=[], structuredContent={"rows": []})) == '{"rows": []}'
    assert assistant.clip("abc", 5) == "abc"
    assert assistant.clip("abcdefgh", 3).startswith("abc\n… (5 more")


def test_mcp_server_env_is_read_only_as_credora_mcp_without_a_role(monkeypatch):
    env = assistant.server_env({"PATH": "/usr/bin"})
    assert env["EXA_USER"] == "CREDORA_MCP" and env["PATH"] == "/usr/bin"
    assert env["EXA_SSL_CERT_VALIDATION"] == "no"
    assert "CREDORA_SESSION_SQL" not in env  # the AI's limits come from consumer group CREDORA_AI
    s = json.loads(env["EXA_MCP_SETTINGS"])
    assert s["enable_read_query"] is True and s["enable_write_query"] is False and s["enable_write_bucketfs"] is False
    assert "latest published (official) analysis run is RUN_ID 'R7'" in assistant.system_prompt("R7")
    assert "RUN_ID 'None'" not in assistant.system_prompt(None)


def _with_passwords(monkeypatch, exa_passwords, exa_mcp_password="mcp-pw"):
    monkeypatch.setattr(assistant, "settings", dataclasses.replace(
        assistant.settings, exa_passwords=exa_passwords, exa_mcp_password=exa_mcp_password))


def test_exasol_login_is_the_ai_session_user_of_the_role(monkeypatch):
    _with_passwords(monkeypatch, {"CREDORA_RM": "person-pw", "CREDORA_RM_AI": "ai-pw", "CREDORA_ADMIN_AI": "admin-ai-pw"})
    assert assistant.exasol_login("rm") == ("CREDORA_RM_AI", "ai-pw")
    assert assistant.exasol_login("admin") == ("CREDORA_ADMIN_AI", "admin-ai-pw")
    assert assistant.ai_user("loanops") == "CREDORA_LOANOPS_AI" and assistant.ai_user(None) is None
    env = assistant.server_env({}, "rm")
    assert env["EXA_USER"] == "CREDORA_RM_AI" and env["EXA_PASSWORD"] == "ai-pw"
    assert env["CREDORA_CLIENT_NAME"] == "credora:rm:ask-credora"
    assert "CREDORA_SESSION_SQL" not in env
    assert "CREDORA_RM_AI" in assistant.system_prompt("R7", "rm")


def test_exasol_login_refuses_a_role_whose_ai_user_has_no_password(monkeypatch):
    # The person's own password and CREDORA_MCP's are there, and neither is used for the AI.
    _with_passwords(monkeypatch, {"CREDORA_RM": "person-pw", "CREDORA_ADMIN_AI": "admin-ai-pw"})
    with pytest.raises(HTTPException) as e:
        assistant.exasol_login("rm")
    assert e.value.status_code == 503 and e.value.detail == "Ask Credora is not set up for this role."
    with pytest.raises(HTTPException):
        assistant.server_env({}, "rm")
    with pytest.raises(HTTPException):
        assistant.exasol_login("not-a-role")
    assert assistant.exasol_login(None) == ("CREDORA_MCP", "mcp-pw")


def test_ask_answers_503_for_a_role_that_is_not_set_up(monkeypatch):
    monkeypatch.setattr(ai, "enabled", lambda: True)
    monkeypatch.setattr(ai, "client", lambda: object())
    _with_passwords(monkeypatch, {"CREDORA_ADMIN_AI": "admin-ai-pw"})
    assert assistant.enabled() is True
    r = TestClient(app).post("/api/ai/ask", json={"question": "Average offer ROI by grade"}, headers=_auth("rm"))
    assert r.status_code == 503 and r.json()["detail"] == "Ask Credora is not set up for this role."


def test_assistant_prefers_the_semantic_layer_and_leaves_the_preprocessor_alone():
    s = json.loads(assistant.server_env({})["EXA_MCP_SETTINGS"])
    assert s["enable_preprocessor_tools"] is False
    assert {"set_exasol_preprocessor", "list_exasol_preprocessors"} <= assistant.HIDDEN_TOOLS
    prompt = assistant.system_prompt("R7")
    assert prompt.index("CREDORA_SEM.PORTFOLIO") < prompt.index("DECISIONS: one row")
    for metric in ("companies_analysed", "approved_companies", "referred_companies", "declined_companies",
                   "approval_rate", "pre_approved_amount", "negotiation_headroom", "avg_offer_roi",
                   "avg_floor_roi", "avg_pd", "avg_raroc_offer", "expected_loss", "top50_amount"):
        assert metric in prompt


class FakeSession:
    def __init__(self):
        self.calls = []

    async def call_tool(self, name, args):
        self.calls.append((name, args))
        return NS(content=[NS(type="text", text='{"columns":["N"],"rows":[[42]]}')], structuredContent=None,
                  isError=False)


class FakeClient:
    """Asks for two tool calls per turn until tool_choice is none, then answers."""

    def __init__(self):
        self.messages = self
        self.choices = []

    def create(self, **kw):
        self.choices.append(kw["tool_choice"]["type"])
        if kw["tool_choice"]["type"] == "none":
            return NS(stop_reason="end_turn", content=[NS(type="text", text="42 companies.")])
        n = len(self.choices)
        return NS(stop_reason="tool_use", content=[
            NS(type="tool_use", id=f"a{n}", name="execute_exasol_query", input={"query": "SELECT 42"}),
            NS(type="tool_use", id=f"b{n}", name="execute_exasol_query", input={"query": "SELECT 43"}),
        ])


def test_tool_loop_stops_at_the_budget_and_records_steps():
    session, client, steps = FakeSession(), FakeClient(), []
    answer = asyncio.run(assistant._loop(client, session, "sys", [{"name": "x"}],
                                         [{"role": "user", "content": "q"}], steps))
    assert answer == "42 companies."
    assert len(session.calls) == assistant.MAX_TOOL_CALLS
    assert len(steps) == assistant.MAX_TOOL_CALLS
    assert steps[0] == {"tool": "execute_exasol_query", "input": {"query": "SELECT 42"},
                        "result_preview": '{"columns":["N"],"rows":[[42]]}', "is_error": False}
    assert client.choices[-1] == "none" and client.choices.count("none") == 1


REPORT = {
    "cif_id": "CIF00042", "legal_name": "Shakti Polymers LLP", "run_id": "R20261031-1103", "decision": "APPROVE",
    "hard_fails": [], "grade": "B1", "pd": 0.0312, "rank_no": 12, "rank_of": 1000, "stage": "GROWTH",
    "gst_years": 6.5, "partners": 3, "raroc": 21.4, "raroc_floor": 16.2,
    "offer": {"amount": 28472480, "roi": 10.85, "tenure": 36},
    "limit": {"max_amount": 32000000, "floor_roi": 9.75, "max_tenure": 48},
    "requested": {"amount": 30000000, "roi": 0, "tenure": 36, "product": "Working capital"},
    "reasons": [{"feature": "inflow_volatility", "text": "Monthly inflows swing by 18% around their average",
                 "contribution": -2.386, "source": "bank.oracle"},
                {"feature": "partner_overdue_amt", "text": "Partners have ₹1.2 L overdue on personal credit",
                 "contribution": 0.924, "source": "api.cibil"}],
    "features": [{"name": "gst_turnover_12m", "label": "GST turnover, last 12 months", "value": 158000000,
                  "unit": "inr", "source": "api.gstn"},
                 {"name": "bounce_ratio", "label": "Bounced debits / all debits", "value": 0.0032, "unit": "ratio",
                  "source": "bank.oracle"},
                 {"name": "dscr", "label": "Debt service coverage ratio", "value": 1.42, "unit": None,
                  "source": "exasol"},
                 {"name": "inflow_volatility", "label": "Inflow volatility", "value": 0.17, "unit": None,
                  "source": "bank.oracle"}],
}


def test_memo_facts_from_the_report():
    f = memo.facts(REPORT)
    assert f["decision"] == "APPROVE" and f["risk_grade"] == "B1"
    assert f["probability_of_default"] == "3.12%"
    assert f["rank"] == "12 of 1000" and f["gst_stage"] == "GROWTH"
    assert f["indicated_need"] == {"product": "Working capital", "amount": "₹3 cr", "tenure_months": 36}
    assert f["pre_approved_offer"] == {"amount": "₹2.85 cr", "roi": "10.85%", "tenure_months": 36, "raroc": "21.4%"}
    assert f["negotiation_limit"]["max_amount"] == "₹3.2 cr" and f["negotiation_limit"]["floor_roi"] == "9.75%"
    assert f["top_reasons"][0] == {"reason": "Monthly inflows swing by 18% around their average",
                                   "effect": "lowers risk", "pd_points": 2.39}
    assert f["top_reasons"][1]["effect"] == "raises risk"
    assert f["key_features"] == {"GST turnover, last 12 months": "₹15.8 cr", "Bounced debits / all debits": "0.32%",
                                 "Debt service coverage ratio": 1.42}
    assert json.loads(memo.facts_json(REPORT)) == f


def test_memo_facts_for_a_decline_have_no_offer():
    r = {**REPORT, "decision": "DECLINE", "hard_fails": ["GST_LATE_FILINGS"], "offer": None, "limit": None,
         "raroc": None, "raroc_floor": None}
    f = memo.facts(r)
    assert f["pre_approved_offer"] is None and f["negotiation_limit"] is None
    assert f["policy_rules_failed"] == ["GST_LATE_FILINGS"]


def test_memo_model_column_keeps_the_engine():
    assert memo.unpack_model(memo.pack_model("claude-sonnet-5-5", "exasol-udf")) == ("claude-sonnet-5-5", "exasol-udf")
    assert memo.unpack_model("anthropic.claude-x-v1:0|backend") == ("anthropic.claude-x-v1:0", "backend")
    assert memo.unpack_model("claude-sonnet-5-5") == ("claude-sonnet-5-5", "exasol-udf")


def _auth(role="rm"):
    return {"Authorization": f"Bearer {issue_token(make_user(role))}"}


def test_ai_off_status_and_503(monkeypatch):
    monkeypatch.setattr(ai, "enabled", lambda: False)
    c = TestClient(app)
    s = c.get("/api/ai/status", headers=_auth()).json()
    assert s["enabled"] is False and s["assistant"] is False and s["model"] is None
    r = c.post("/api/ai/ask", json={"question": "Average offer ROI by grade"}, headers=_auth())
    assert r.status_code == 503 and "off" in r.json()["detail"]
    r = c.post("/api/companies/CIF00042/memo", headers=_auth("loanops"))
    assert r.status_code == 503
    assert c.post("/api/ai/ask", json={"question": "x"}).status_code == 401


def test_assistant_needs_an_ai_session_user_password(monkeypatch):
    monkeypatch.setattr(ai, "enabled", lambda: True)
    # The person's role users and CREDORA_MCP do not switch Ask Credora on. An AI session user does.
    _with_passwords(monkeypatch, {"CREDORA_RM": "person-pw", "CREDORA_ADMIN": "admin-pw"})
    assert assistant.enabled() is False
    _with_passwords(monkeypatch, {"CREDORA_RM": "person-pw", "CREDORA_RM_AI": "ai-pw"}, exa_mcp_password="")
    assert assistant.enabled() is True
