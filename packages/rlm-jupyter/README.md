# @deepseek-rlm/dsh-rlm-jupyter

The concrete `ctx.rlm` provider. It owns one lazy persistent IPython kernel per exact live DSH `Agent`, authenticated Jupyter v5 shell/IOPub/control channels, FIFO cell execution, one aggregate output budget per cell, generation-fenced `host.request` comms, managed Python 3.11 provisioning, aggregate- and per-value-bounded snapshot/restore, interruption, and process-tree cleanup.

The host bridge translates Prime-compatible requests into `ctx.llm`, `ctx.subagents`, and `ctx.tools`; it never calls a provider or drives an agent loop itself. Full alpha.3 operation requires the ordered compatibility patches documented at the repository root.

When `rlm(..., model=...)` omits its model selector, the child inherits the exact provider/model from the parent session's current `request/header`, including Agent-scoped Web model selection. Only a direct pre-request bridge call with no request header falls back to the parent's construction options. An explicit selector still chooses its named route, and omitting `thinking` does not implicitly copy a reasoning effort.

Construction validates that `subagentProvider` resolves to an exact native DSH provider and fails loudly when it does not. The installable bundle gates this constructor with its `rlmSpawnReady` hard dependency; Loader row order is not a readiness contract. Standalone compositions must likewise make their configured provider available before activating this package.

Artifacts are isolated under `<artifactRoot>/sessions/<SessionId>`. Historical cells are never replayed. Direct Python and `%%bash` execution has the kernel process’s OS authority and is not constrained by DSH tool policy.

See the root [`README.md`](../../README.md) for configuration, installation, security, and troubleshooting.
