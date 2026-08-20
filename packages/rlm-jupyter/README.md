# @deepseek-rlm/dsh-rlm-jupyter

The concrete `ctx.rlm` provider. It owns one lazy persistent IPython kernel per exact live DSH `Agent`, authenticated Jupyter v5 shell/IOPub/control channels, FIFO cell execution, generation-fenced `host.request` comms, managed Python 3.11 provisioning, snapshot/restore, interruption, and process-tree cleanup.

The host bridge translates Prime-compatible requests into `ctx.llm`, `ctx.subagents`, and `ctx.tools`; it never calls a provider or drives an agent loop itself. Full rc.7 operation requires the ordered compatibility patches documented at the repository root.

Artifacts are isolated under `<artifactRoot>/sessions/<SessionId>`. Historical cells are never replayed. Direct Python and `%%bash` execution has the kernel process’s OS authority and is not constrained by DSH tool policy.

See the root [`README.md`](../../README.md) for configuration, installation, security, and troubleshooting.
