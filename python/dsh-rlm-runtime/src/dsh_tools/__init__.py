"""Policy-preserving access to DSH tools from an active IPython call."""

from __future__ import annotations

from typing import Any

import rlm as _rlm_module


async def list() -> list[dict[str, Any]]:
    """Return tools visible to the exact calling DSH agent."""
    response = await _rlm_module.host_request("dsh_tools.list")
    tools = response.get("tools")
    if not isinstance(tools, builtins.list):
        raise RuntimeError("dsh_tools.list returned an invalid tools list")
    return tools


async def call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one nested tool through ``ctx.tools.execute()``."""
    if not isinstance(name, str) or not name:
        raise TypeError("name must be a non-empty str")
    if not isinstance(arguments, dict):
        raise TypeError("arguments must be a dict")
    return await _rlm_module.host_request(
        "dsh_tools.call", {"name": name, "arguments": arguments}
    )


import builtins

__all__ = ["call", "list"]
