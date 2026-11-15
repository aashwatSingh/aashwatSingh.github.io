"""
@author: Aashwat Singh (ForgeAI integration)
@description: The only place that talks to NVIDIA's hosted Nemotron model (NVIDIA NIM, an OpenAI-style
    "chat completions" web API). It reads the API key, address and model name from the environment, sends
    a question together with the project facts the caller is allowed to see, and returns the model's text.
    If no key is configured, the address is not HTTPS, the service is slow (15 seconds), or it answers with
    anything unexpected, this module returns None and the caller answers from its own local rules instead,
    so ForgeAI always works offline. The API key is never logged and never sent anywhere except NVIDIA.
@traces: SE-NFR-02, SE-NFR-06, SE-NFR-11, UC-05, UC-21
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger("projectforge.nemotron")

DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1"
#: Reported as the "model" when the answer was computed locally, so a local answer is never labelled Nemotron.
LOCAL_MODEL = "forgeai-local-engine"
MODE_NIM = "nvidia-nim"
MODE_LOCAL = "local-fallback"

TIMEOUT_SECONDS = 15.0
MAX_REPLY_CHARS = 6000
MAX_RESPONSE_BYTES = 512 * 1024

_MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:\-]{0,119}$")
_LOCAL_HTTP = ("http://localhost", "http://127.0.0.1")

# Tests replace this with an httpx.MockTransport; production leaves it as None (real network).
_transport: httpx.AsyncBaseTransport | None = None


@dataclass(frozen=True)
class NemotronConfig:
    api_key: str
    base_url: str
    model: str

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)


def nemotron_config() -> NemotronConfig:
    """Reads NVIDIA_API_KEY, NEMOTRON_BASE_URL and NEMOTRON_MODEL (at call time, so a restart is not needed in tests)."""
    api_key = os.getenv("NVIDIA_API_KEY", "").strip()
    base_url = (os.getenv("NEMOTRON_BASE_URL", "").strip() or DEFAULT_BASE_URL).rstrip("/")
    model = os.getenv("NEMOTRON_MODEL", "").strip() or DEFAULT_MODEL
    if not _MODEL_NAME.fullmatch(model):
        model = DEFAULT_MODEL
    if api_key and not (base_url.startswith("https://") or base_url.startswith(_LOCAL_HTTP)):
        # SE-NFR-06: the key and project data only ever travel over HTTPS (plain http is allowed for a
        # model server on this machine only). Anything else disables the live model.
        logger.warning("NEMOTRON_BASE_URL is not HTTPS; ForgeAI stays on the local engine.")
        api_key = ""
    return NemotronConfig(api_key=api_key, base_url=base_url, model=model)


def strip_reasoning(text: str) -> str:
    """Drops <think>...</think> blocks some reasoning models emit. Linear scan, no regular expression."""
    out: list[str] = []
    position = 0
    lowered = text.lower()
    while True:
        start = lowered.find("<think>", position)
        if start == -1:
            out.append(text[position:])
            break
        out.append(text[position:start])
        end = lowered.find("</think>", start)
        if end == -1:  # unterminated reasoning: discard the rest
            break
        position = end + len("</think>")
    return "".join(out).strip()


async def chat_completion(messages: list[dict[str, str]], *, max_tokens: int = 600, temperature: float = 0.2) -> str | None:
    """Returns Nemotron's reply text, or None when the live model is unavailable for any reason.

    None is the signal to fall back to the deterministic local engine; this function never raises.
    """
    config = nemotron_config()
    if not config.enabled:
        return None
    payload: dict[str, Any] = {
        "model": config.model,
        "messages": messages,
        "temperature": temperature,
        "top_p": 0.9,
        "max_tokens": max_tokens,
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT_SECONDS), transport=_transport, follow_redirects=False) as client:
            response = await client.post(
                f"{config.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {config.api_key}", "Accept": "application/json"},
                json=payload,
            )
        if response.status_code != 200:
            logger.warning("Nemotron answered HTTP %s; using the local engine.", response.status_code)
            return None
        if len(response.content) > MAX_RESPONSE_BYTES:
            logger.warning("Nemotron response too large; using the local engine.")
            return None
        content = response.json()["choices"][0]["message"]["content"]
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
        # Only the kind of failure is logged: never the key, the prompt or project data.
        logger.warning("Nemotron call failed (%s); using the local engine.", type(exc).__name__)
        return None
    if not isinstance(content, str):
        return None
    cleaned = strip_reasoning(content)[:MAX_REPLY_CHARS].strip()
    return cleaned or None
