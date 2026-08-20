# DeepSeek Harness patches

These patches apply in filename order to DeepSeek Harness revision `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` (`dsh-v0.1.0-rc.7`). They use only public service contracts; the RLM packages never read continuation-manager private state.

- `0001` adds `AgentOptions.reasoningEffort`, exact pre-admission model validation, descriptor persistence/cold restoration, and `supportsContinuableReasoningEffort()`.
- `0002` adds public `deleteContinuable(parent, childId, { signal })`, parent-owned tombstones, child-first activation disposal, idempotency, list pruning, and cold-send refusal.
- `0003` adds the generic `Session.appendIgnorable()` writer for the already-defined forward-compatible event envelope. It is a prerequisite for any independently installed plugin that persists informational events outside DSH’s generated in-repository vocabulary.

Run `DSH_SOURCE=/absolute/pinned/checkout pnpm verify:patches` to verify and apply the series in a disposable Git worktree. The final patched tree typechecks with DSH’s package toolchain; targeted upstream session, agent-loop, continuation, listing, and deletion tests run on Node 22.
