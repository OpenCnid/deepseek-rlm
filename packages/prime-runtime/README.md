# @deepseek-rlm/dsh-rlm-prime-runtime

This package stages two local Python projects for managed-kernel installation: the exact unmodified Prime `prime-agent-runtime` pin and the separate `dsh-rlm-runtime` bridge. It exports only version facts and absolute asset locators; it contains no agent loop, provider client, ACP transport, or Prime `AgentSession`.

The repository build regenerates `python/` from the provenance-verified source directories. Installed package contents therefore remain reproducible without relying on the consumer's workspace layout.

## Known limitations and deferred work

Managed environments are created by the Jupyter provider, not this asset package. A deployment that blocks Python package installation must pre-provision a compatible interpreter and configure it explicitly.
