# @deepseek-rlm/dsh-rlm

This package is the provider-neutral Service Definition for `ctx.rlm`. It defines cell execution, kernel inspection, snapshots, restart, disposal, lifecycle events, and log-only RLM session events. It owns no Python process, model choice, tool policy, or child-agent lifecycle.

Runtime failures from Python resolve as `RlmExecutionResult`; invalid caller input and kernel substrate failures reject. A provider maps one exact DSH `Agent`/`SessionId` to one live kernel and must preserve the exact `Agent` as the authority for every bridged host operation.

## Compatibility requirement

DeepSeek Harness alpha.3 cannot mark out-of-tree informational events with its existing `ignorable: true` envelope contract. This package exposes `appendRlmSessionEvent()`, which requires the public method supplied by `0003-public-ignorable-session-events.patch` and fails with `UNSUPPORTED_IGNORABLE_SESSION_EVENTS` when it is absent. It never falls back to a live event that would poison cold restore.
