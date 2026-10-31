"""Optional AI features. Off unless AI_PROVIDER is set; everything else works without it.

AI_PROVIDER=anthropic  uses the Anthropic API with ANTHROPIC_API_KEY
AI_PROVIDER=bedrock    uses Claude on Amazon Bedrock with the host's AWS credentials (AWS_REGION)
AI_MODEL               model id for the chosen provider
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from .config import settings

log = logging.getLogger("credora.ai")

PROVIDERS = ("anthropic", "bedrock")

_client: Any = None
_lock = threading.Lock()


def enabled() -> bool:
    if settings.ai_provider not in PROVIDERS or not settings.ai_model:
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
                _client = anthropic.AnthropicBedrock(aws_region=settings.aws_region)
            else:
                _client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        return _client


def status() -> dict:
    return {"enabled": enabled(), "provider": settings.ai_provider or None,
            "model": settings.ai_model if enabled() else None}
