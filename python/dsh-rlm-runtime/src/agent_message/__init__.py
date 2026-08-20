"""Prime-compatible parent/child messaging over the DSH host bridge."""

from __future__ import annotations

from typing import Any, Literal

import rlm as _rlm_module

ReceiverRole = Literal["parent", "sibling", "child"]


async def list_agents() -> dict[str, Any]:
    """List the calling DSH agent's authorized family relationships."""
    return await _rlm_module.host_request("agent_message.list_agents")


async def send(
    message: str,
    broadcast_message: str | None = None,
    *,
    receiver_role: ReceiverRole | str | None = None,
    receiver_name: str | None = None,
) -> dict[str, Any]:
    """Send to the direct parent or one direct child; sibling routing is unsupported."""
    if broadcast_message is not None:
        if message != "all":
            raise TypeError(
                "positional agent_message.send targets are not supported; "
                "use receiver_role and receiver_name"
            )
        if receiver_role is not None or receiver_name is not None:
            raise TypeError("broadcast cannot be combined with receiver_role/receiver_name")
        payload: dict[str, Any] = {"target": "all", "message": broadcast_message}
    else:
        if receiver_role not in ("parent", "sibling", "child"):
            raise ValueError('receiver_role must be "parent", "sibling", or "child"')
        if not isinstance(message, str):
            raise TypeError(f"message must be str, got {type(message).__name__}")
        if receiver_role == "parent":
            if receiver_name is not None:
                raise ValueError("receiver_name must be omitted for parent messages")
        elif not isinstance(receiver_name, str) or not receiver_name.strip():
            raise ValueError("receiver_name is required for sibling and child messages")
        payload = {
            "message": message,
            "receiver_role": receiver_role,
            "receiver_name": receiver_name,
        }
    return await _rlm_module.host_request("agent_message.send", payload)


__all__ = ["ReceiverRole", "list_agents", "send"]
