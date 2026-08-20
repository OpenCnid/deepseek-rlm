"""Kernel bootstrap helpers for the DeepSeek Harness RLM provider.

This package is a transport shim. It never selects a model, calls a provider,
or drives an agent loop; every privileged operation goes through ``host.request``.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from rlm import rlm

BRIDGE_PROTOCOL_VERSION = 1
RUNTIME_VERSION = "0.1.0"


def bootstrap() -> dict[str, Any]:
    """Return the stable names installed into an IPython user namespace."""
    session_dir = Path(os.environ["RLM_SESSION_DIR"]).resolve()
    session_dir.mkdir(parents=True, exist_ok=True)
    return {
        "asyncio": asyncio,
        "rlm": rlm,
    }


__all__ = ["BRIDGE_PROTOCOL_VERSION", "RUNTIME_VERSION", "bootstrap"]
