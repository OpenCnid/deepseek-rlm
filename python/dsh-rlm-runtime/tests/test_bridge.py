from __future__ import annotations

import asyncio
from typing import Any

import agent_message
import dsh_tools
import rlm


def test_agent_message_parent_uses_host_request(monkeypatch: Any) -> None:
    calls: list[tuple[str, dict[str, Any] | None]] = []

    async def request(kind: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        calls.append((kind, payload))
        return {"deliveryStatus": "delivered"}

    monkeypatch.setattr(rlm, "host_request", request)
    result = asyncio.run(agent_message.send("READY", receiver_role="parent"))
    assert result == {"deliveryStatus": "delivered"}
    assert calls == [
        (
            "agent_message.send",
            {"message": "READY", "receiver_role": "parent", "receiver_name": None},
        )
    ]


def test_dsh_tools_validates_before_dispatch(monkeypatch: Any) -> None:
    async def request(kind: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return {"kind": kind, "payload": payload}

    monkeypatch.setattr(rlm, "host_request", request)
    result = asyncio.run(dsh_tools.call("read_file", {"path": "README.md"}))
    assert result["kind"] == "dsh_tools.call"
