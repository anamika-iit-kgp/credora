"""Optional AI features. Off unless AI_PROVIDER is set, and everything else works without it.

AI_PROVIDER=anthropic  the Anthropic API with ANTHROPIC_API_KEY and AI_MODEL (the default provider)
AI_PROVIDER=bedrock    Claude on Amazon Bedrock through the Anthropic SDK's Bedrock client. The AWS
                       credentials come from the standard AWS environment or the EC2 instance role,
                       the region from AWS_REGION (else AWS_DEFAULT_REGION), and no API key is stored.
                       The model is BEDROCK_MODEL_ID, or "anthropic." + AI_MODEL when that is blank,
                       so AI_MODEL=claude-sonnet-5-5 becomes anthropic.claude-sonnet-5-5.
AI_MODEL               the Anthropic API model id, which the CREDIT_MEMO UDF inside Exasol also calls

Ask Credora and the backend credit memo work with either provider. The memo written inside Exasol
(CREDORA.CREDIT_MEMO through CONNECTION AI_LLM) calls api.anthropic.com from the UDF, so that engine
is Anthropic only, and with bedrock the backend writes the memo itself (app/memo.py).
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from .config import settings

log = logging.getLogger("credora.ai")

PROVIDERS = ("anthropic", "bedrock")
BEDROCK_PREFIX = "anthropic."

_client: Any = None
_lock = threading.Lock()


def model() -> str:
    """The model id sent to the configured provider."""
    if settings.ai_provider == "bedrock":
        if settings.bedrock_model_id:
            return settings.bedrock_model_id
        return BEDROCK_PREFIX + settings.ai_model if settings.ai_model else ""
    return settings.ai_model


def enabled() -> bool:
    if settings.ai_provider not in PROVIDERS or not model():
        return False
    if settings.ai_provider == "anthropic" and not settings.anthropic_api_key:
        return False
    return True


def client() -> Any:
    """The SDK client for the configured provider, or None when AI is off."""
    global _client
    if not enabled():
        return None
    with _lock:
        if _client is None:
            try:
                import anthropic
            except ImportError:  # pragma: no cover
                log.warning("anthropic SDK is not installed; AI features are off")
                return None
            if settings.ai_provider == "bedrock":
                try:
                    import botocore  # noqa: F401 - signs the Bedrock requests (package extra anthropic[bedrock])
                except ImportError:  # pragma: no cover
                    log.warning("anthropic[bedrock] is not installed, AI features are off")
                    return None
                # Credentials come from the AWS environment or the instance role, as boto3 resolves them.
                _client = anthropic.AnthropicBedrock(aws_region=settings.aws_region)
            else:
                _client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        return _client


def status() -> dict:
    return {"enabled": enabled(), "provider": settings.ai_provider or None,
            "model": model() if enabled() else None}
