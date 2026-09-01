# DeepSeek Harness patches

These patches apply in filename order to DeepSeek Harness revision
`dd6322d604e00eec1ba5e0c8541159906a21094a` (`dsh-v0.1.2-alpha.3`). They use
only public service contracts; the RLM packages never read continuation-manager
private state.

- `0002` adds public `deleteContinuable(parent, childId, { signal })`,
  parent-owned tombstones, child-first activation disposal, idempotency, list
  pruning, and cold-send refusal.
- `0003` adds the generic `Session.appendIgnorable()` writer for the already-defined
  forward-compatible event envelope. It is a prerequisite for any independently
  installed plugin that persists informational events outside DSH's generated
  in-repository vocabulary.
- `0004` gives the pi-ai adapter exact-Agent ownership of session-scoped provider
  resources at actual stream use, with an exact-Session fallback for agentless
  callers. Disposal invokes pi-ai's public `cleanupSessionResources()` and
  contains aggregate cleanup failures. It is adapted to alpha.3 from DSH
  reference commit `d3edd5f1ee8e31325f6de54dbac67acb0d461872`.
- `0005` keeps the CLI's existing force-exit deadline armed but unreferenced after
  successful application-tree disposal. A quiescent process exits normally;
  a provider transport whose public close leaves a referenced OS handle cannot
  hold a headless CLI open indefinitely.

Patches `0002` and `0003` are the two RLM capability seams required by
[SPEC.md](../../SPEC.md). Patches `0004` and `0005` are generic DSH lifecycle
fixes exposed by real OpenAI Codex WebSocket testing; they do not add an RLM
or provider-specific execution path.

The former reasoning-effort patch is retired: alpha.3 natively accepts,
validates, persists, and cold-restores `AgentOptions.reasoningEffort` for
continuable children.

Run `DSH_SOURCE=/absolute/pinned/checkout pnpm verify:patches` to verify and
apply the series in a disposable Git worktree. The final patched tree typechecks
with DSH's package toolchain; targeted upstream session, continuation, listing,
deletion, pi-ai resource-lifecycle, and CLI shutdown tests run on Node 24.
