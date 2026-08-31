# Future implementation milestones

Status: proposed post-preview roadmap  
Last reviewed: 2026-08-31

The delivery milestones in `SPEC.md` describe how the original rc.7 preview was
built. This document begins from that working implementation and owns the next
phase: removing the Prime dependency, tracking current DeepSeek Harness (DSH),
adding durable process metadata, implementing canonical long-context RLM, and
keeping a user-facing interface agent available while RLM work continues.

The milestones are ordered to keep one major compatibility boundary moving at
a time. Each milestone must leave a working, testable plugin; a later milestone
must not be required to repair an earlier one's incomplete migration.

## Target outcome

The future implementation should provide both of these layers:

1. A low-level persistent IPython capability (`ctx.rlm` and the `ipython` tool)
   for any DSH agent.
2. A high-level asynchronous RLM process that receives a query and a large
   context reference, recursively investigates bounded slices, and constructs
   a durable response artifact while the interface agent remains responsive.

DSH remains the only agent harness at both layers. There is no nested Prime
process, provider call from Python, or plugin-owned agent loop.

## Roadmap at a glance

| Milestone                       | Outcome                                                               | Depends on       |
| ------------------------------- | --------------------------------------------------------------------- | ---------------- |
| 0. Contract and baseline        | Behavior is characterized and the upgrade target is pinned            | Existing preview |
| 1. Project-owned Python runtime | Prime is absent from the production and build graphs                  | 0                |
| 2. Current DSH adapter          | The plugin runs on an unpatched supported DSH baseline                | 0; merge after 1 |
| 3. Hybrid durable state         | The minimal rebase metadata becomes the complete durable schema       | 2                |
| 4. Canonical RLM process        | Query plus context becomes a durable recursive process                | 3                |
| 5. Responsive interface agent   | Users can inspect and steer work while it runs                        | 4                |
| 6. Hardening and release        | Compatibility, isolation, observability, and packaging are releasable | 5                |

Milestones 1 and 2 can be developed on separate branches after Milestone 0,
but they should be merged separately and revalidated together before Milestone
3 begins.

## Milestone 0 — Contract and upgrade baseline

### Outcome

Freeze the behavior that must survive the migration and choose one exact DSH
revision for the next compatibility line.

The repository now pins DSH `dsh-v0.1.2-alpha.3` at `dd6322d` after the
2026-08-31 compatibility audit. This baseline includes generic
[`AgentOptions.reasoningEffort`](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/core/agent/src/runtime-types.ts)
and persisted
[continuable-child reasoning](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/subagent/subagent/src/continuation.ts),
but it does not expose the preview patch names `deleteContinuable` or
`appendIgnorable`. It also includes
[`ctx.storageDomain`](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/docs/subsystems/storage.md)
and the process-local
[`ctx.jobs`](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/docs/subsystems/jobs.md)
service.

The implementation PR must repeat this audit against the exact revision it
selects; a moving branch is not a release baseline.

### Work

- Record an exact candidate DSH commit, tag, Cordis version, Node range, Loader
  schema, package set, and required platform toolchains.
- Add a compatibility matrix comparing every use of `ctx.rlm`, `ctx.llm`,
  `ctx.subagents`, `ctx.tools`, Sessions, Loader, jobs, and storage between rc.7
  and the candidate.
- Turn the existing Prime-protocol fixtures into black-box conformance tests for
  the public Python surface:
  - callable `rlm(prompt, **kwargs)`;
  - `find_models`, `list_subagents`, and `delete_subagent`;
  - `RLMSpawnHandle`, `RLMModel`, and `RLMSubagent` shapes;
  - `agent_message` and `dsh_tools` behavior;
  - stable error codes and admission timing.
- Inventory the vendored Python surface and classify it:
  - **own:** the host comm, callable RLM API, response types, and validation;
  - **keep as DSH bridges:** `agent_message` and `dsh_tools`;
  - **redesign or deprecate:** `rlm.harness` local/global state;
  - **do not copy by default:** Prime-specific MCP credential access and generic
    skill CLI helpers that are not required by DeepSeek RLM.
- Add an executed compatibility report under `docs/qa` with scrubbed commands
  and results. Do not put credentials or environment dumps in the report.
- Decide the support policy: one exact primary DSH release is required; older
  releases are either explicitly supported by an adapter or rejected at
  startup with a stable diagnostic.

### Exit criteria

- The current preview passes unchanged against the new black-box Python
  conformance suite.
- Every DSH dependency and each of the three original patches has a written
  disposition for the selected candidate.
- The selected baseline is an exact tag and commit, not `master`.
- `ARCHITECTURE.md`, `SPEC.md`, and this roadmap agree on ownership boundaries.

## Milestone 1 — Replace the vendored Prime runtime

### Outcome

The kernel exposes the useful Prime-compatible Python API from project-owned
code, while no production, build, test, provenance, or packaging path depends
on the Prime Agent repository.

This changes implementation ownership, not orchestration behavior.

### Work

- Move the required top-level `rlm` module into
  `python/dsh-rlm-runtime/src/rlm` and make `dsh-rlm-runtime` the single owned
  Python distribution installed into managed kernels.
- Reimplement the small required surface from the protocol contract rather than
  copying the obsolete runtime wholesale:
  - authenticated `host_request` over the existing Jupyter comm;
  - `RLMSpawnHandle`, `RLMModel`, and `RLMSubagent` value types;
  - callable `rlm` plus find/list/delete helpers;
  - lazy control-channel handler installation;
  - strict payload and response validation.
- Keep `agent_message` and `dsh_tools` in the owned distribution and route every
  privileged operation through `host.request`.
- Decide `rlm.harness` using evidence from Milestone 0:
  - if used, provide a small compatibility facade backed by project-owned
    storage and publish a deprecation path;
  - if unused, remove it explicitly in a documented preview-breaking change;
  - do not copy the 800-line Prime store merely to preserve an unverified API.
- Remove Prime's direct MCP credential client. Python integrations should call
  MCP-backed capabilities through DSH's tool path so policy, approval, logging,
  and credential ownership stay host-side.
- Rename `packages/prime-runtime` to `packages/runtime-assets`. Because the
  current packages are unpublished previews, prefer a clean rename; if that
  changes before implementation, ship a one-release deprecation facade.
- Remove `vendor/prime-agent-runtime`, its upstream tests, its provenance pin,
  and Prime-specific third-party notices only after the owned tests cover the
  retained behavior.
- Update managed-runtime lock markers so a kernel environment built with Prime
  cannot be mistaken for the owned runtime.

### Exit criteria

- `rg` finds no runtime or build dependency on `prime-agent-runtime`, Prime ACP,
  or `AgentSession`; historical documentation may mention the migration.
- The black-box Python conformance suite passes against the owned module.
- Managed environment creation, package smoke installation, and offline import
  tests pass on Windows, macOS, and Linux.
- `await rlm(...)`, reporting, follow-up, and `dsh_tools.call()` still traverse
  the same public DSH services with the same authority.
- Licensing and provenance checks pass with the vendor directory absent.

## Milestone 2 — Rebase and eliminate mandatory DSH patches

### Outcome

DeepSeek RLM installs against one current, exact, unmodified DSH baseline. Any
operation that still needs a missing public capability is optional and fails
with a stable unsupported-capability error.

The goal is zero mandatory host patches, not private fallback code.

### Patch disposition

For the selected `dsh-v0.1.2-alpha.3` baseline:

| Existing patch                          | Audited disposition                                                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001-persisted-child-reasoning-effort` | Removed: the generic agent and continuable descriptor carry reasoning effort on alpha.3; integration tests verify first-request propagation.                                                                            |
| `0002-continuable-child-deletion`       | Rebased unchanged for the current preview. Propose upstream; Milestone 2 makes deletion optional until a public equivalent lands.                                                                                       |
| `0003-public-ignorable-session-events`  | Rebased for the current preview. Milestone 2 moves minimum snapshot authority to `ctx.storageDomain`; Milestone 3 expands that schema, eliminating this mandatory patch. Propose the generic writer upstream if useful. |

### Work

- Update the atomic DSH package set, Cordis version, Node requirement, Loader
  bundle schema, imports, event vocabulary, and tests to the selected baseline.
- Rewrite the native spawn composition against the current public subagent
  provider contract. Preserve exact model selection, reasoning validation,
  absolute depth, admission timing, and cold continuation.
- Replace version-shaped duck typing with explicit startup compatibility checks
  for the small set of optional capabilities.
- Keep `delete_subagent` in the Python vocabulary only if it deterministically
  returns either a real public DSH deletion result or
  `UNSUPPORTED_CONTINUABLE_DELETION`.
- Introduce the smallest versioned storage-domain record needed to authorize
  the current namespace snapshot digest and generation. This is the bridge that
  removes the `appendIgnorable` requirement; Milestone 3 expands it into the
  complete kernel, process, command, and artifact schema.
- Submit independently reviewable upstream changes for generic missing seams.
  Each upstream PR must have DSH-native motivation and tests, not depend on RLM
  terminology, and remain useful to other plugins.
- Remove patch application from normal installation and CI. Retain the old
  patch files only in a clearly labeled legacy branch or release artifact if
  existing preview users still need them.
- Isolate DSH-version-dependent translation in one TypeScript adapter module so
  future rebases do not spread conditionals through kernel and process code.

### Exit criteria

- A clean checkout of the pinned DSH baseline installs and runs the bundle with
  no source patching.
- Reasoning effort is active on a child's first request and survives cold
  continuation.
- Missing deletion support fails before mutation with the documented stable
  code; no source reads or writes DSH continuation-manager private state.
- Snapshot recovery uses the minimal storage-domain authority and no custom
  Session event writer.
- The complete unit, integration, e2e, package-smoke, and teardown suites pass
  against the new baseline on all supported platforms.
- The README compatibility table and installation guide no longer instruct a
  normal user to patch DSH.

## Milestone 3 — Hybrid durable metadata and blob persistence

### Outcome

The minimal snapshot authority introduced during the DSH rebase becomes a
complete, queryable RLM schema through `ctx.storageDomain`; large binary or
textual values remain immutable files addressed by digest. Restart recovery
does not depend on a live kernel, process-local job registry, or custom Session
event type.

### Storage model

Define one versioned `deepseek_rlm` domain with records equivalent to:

- `kernels[SessionId]`: runtime digest, current generation, and authorized
  snapshot id;
- `snapshots[SnapshotId]`: owner Session, generation, blob digest, manifest
  digest, byte counts, saved/skipped names, and timestamps;
- `processes[ProcessId]`: owner, supervisor Session, state, query/context refs,
  budgets, command head, artifact head, and terminal outcome;
- `commands[ProcessId:Sequence]`: ordered steering, pause, resume, cancel, or
  finalize requests and their application status;
- `revisions[ProcessId:Revision]`: parent revision, artifact blob digest,
  evidence refs, author, command head, and status.

Use a digest-addressed blob tree for namespace snapshots, context bodies,
evidence attachments, and artifact bodies. Blob paths are derived only from
validated digests, never from user labels.

### Work

- Expand the rebase milestone's snapshot record into the complete versioned
  domain. Keep `ctx.storageDomain` required for durable recovery while retaining
  an explicitly labeled ephemeral mode for local experimentation, if useful.
- Implement the blob commit protocol: bounded temporary write, digest, atomic
  install, host-side verification, then durable metadata reference.
- Replace `rlm/kernel-*` custom Session events as recovery authority. Ordinary
  DSH `tool/call` and `tool/result` events remain the model-visible record.
- Preserve current namespace behavior: per-value `dill`, aggregate and
  per-variable limits, independent restore, skipped-value diagnostics, no cell
  replay, and generation fencing.
- Verify the digest and owner against durable metadata before any `dill.load`.
  Integrity does not imply trust; only plugin-owned snapshots may be loaded.
- Add orphan-blob collection with a grace period, dry-run reporting, and no
  deletion of blobs referenced by any live metadata version.
- Implement an idempotent migration from the rc.7 artifact layout and matching
  snapshot events. Migration writes new metadata only after verifying the old
  file and never rewrites the original Session log.
- Document backend expectations. JSON storage is adequate for small workloads;
  SQLite is preferred for frequently revised process and artifact metadata.

### Exit criteria

- A killed host process can restore the last committed namespace without
  replaying cells.
- Orphan files, missing blobs, corrupt digests, oversized values, and partial
  metadata writes have deterministic recovery tests.
- Snapshot and process metadata are queryable without reading binary blobs.
- A process-local `ctx.jobs` loss does not lose durable process status.
- No mandatory custom Session event or `appendIgnorable` patch remains.

## Milestone 4 — Canonical asynchronous RLM process

### Outcome

The plugin exposes a durable high-level operation that accepts a query and a
large context reference, gives a native DSH supervisor a sliceable `context`,
supports recursive bounded workers, and produces a versioned response artifact.

### Service boundary

Add a provider-neutral service, provisionally `ctx.rlmProcesses`, with semantics
equivalent to:

```ts
interface RlmProcessRuntime {
  start(request: RlmProcessStart): Promise<RlmProcessHandle>
  get(owner: Agent, id: RlmProcessId): Promise<RlmProcessSnapshot>
  list(owner: Agent): Promise<readonly RlmProcessSnapshot[]>
  steer(owner: Agent, id: RlmProcessId, command: RlmCommand): Promise<RlmCommandReceipt>
  cancel(owner: Agent, id: RlmProcessId, reason?: string): Promise<RlmProcessSnapshot>
  result(owner: Agent, id: RlmProcessId, revision?: number): Promise<RlmArtifact>
  onChanged(listener: RlmProcessListener): () => void
}
```

All operations are authorized by the exact owner `Agent` and durable Session
relationship. The final types may differ, but start must return after durable
admission rather than after completion.

### Work

- Define context sources for inline text, DSH workspace/artifact files, and
  previously stored blobs. Every source records media type, length, digest, and
  owner; remote content must be acquired through an explicit host capability
  before the process begins.
- Bootstrap the supervisor's Python namespace with:
  - `query`: the user's question;
  - `context`: a read-only slice/search object;
  - `evidence`: an append-only evidence client;
  - `artifact`: a revision client that proposes and commits drafts.
- Preserve ordinary Python slicing for small text while preventing accidental
  eager copies of very large contexts. The large-context object should support
  length, bounded slices, line windows, search, and digest-stable references.
- Start one continuable DSH child as supervisor. The TypeScript process service
  manages durable transitions and authority only; it never decides slices or
  synthesizes prose itself.
- Give the supervisor a protocol that requires it to:
  1. inspect context rather than assume its contents;
  2. formulate bounded slice questions;
  3. spawn native DSH workers through the existing Python RLM API;
  4. record evidence with context locations and worker provenance;
  5. reconcile contradictions before relying on evidence;
  6. commit provisional artifact revisions; and
  7. explicitly finalize or request user input.
- Enforce process budgets independently for recursion depth, active workers,
  model requests or tokens where DSH exposes them, wall time, context bytes
  disclosed, evidence bytes, artifact bytes, and revision count.
- Define process states at minimum: `queued`, `running`, `waiting_for_user`,
  `paused`, `completed`, `failed`, and `cancelled`. All transitions are durable,
  validated, and idempotent where retry is safe.
- Make artifact commits single-writer and compare-and-swap on parent revision.
  A revision records the evidence and steering-command head it incorporated.
- Add a synchronous convenience wrapper only as `start` plus bounded `wait`;
  the asynchronous service remains the source of truth.

### Exit criteria

- An integration test answers a question whose supporting evidence is located
  beyond a model's direct context window without sending the full source to any
  one model request.
- The start call returns a durable handle before the supervisor completes.
- Recursive workers are normal DSH children with preserved lineage, policy,
  model selection, cancellation, and usage accounting.
- Every claim in the final test artifact can be traced to an evidence record or
  is explicitly marked as inference.
- Crash/restart resumes from the last committed process and artifact revision
  without duplicating an applied command.
- No TypeScript or Python component outside DSH implements a model loop.

## Milestone 5 — Responsive interface-agent workflow

### Outcome

The top-level DSH agent can start an RLM process, answer the user immediately,
inspect partial artifacts, accept steering, and present the result while the
supervisor continues in its separate Session.

The interface agent is an agent role and tool composition, not an always-on
model process.

### Work

- Add model-facing tools backed by `ctx.rlmProcesses`:
  - `rlm_start(query, context, budgets?)`;
  - `rlm_status(process_id)`;
  - `rlm_steer(process_id, instruction, expected_revision?)`;
  - `rlm_cancel(process_id, reason?)`;
  - `rlm_result(process_id, revision?)`.
- Make `rlm_start` return after supervisor admission and durable process commit.
  It must not hold the interface agent's turn open for the final answer.
- Mirror live execution into `ctx.jobs` when present so existing DSH job
  controllers can expose status, cancellation, and completion notices. Treat
  that registry as a process-local view; rehydrate it from the durable process
  domain after restart.
- Prefer event delivery to polling. Wake or notify the interface only for:
  - a user message;
  - `waiting_for_user`;
  - a configured checkpoint or material artifact revision;
  - contradiction or policy escalation requiring judgment;
  - terminal completion, failure, or cancellation.
- Do not invoke the interface model for routine heartbeat events. The UI may
  render deterministic status and revision metadata without a model call.
- Record every steering instruction as an ordered command. The supervisor
  applies commands at safe checkpoints; the interface never edits the current
  artifact blob directly.
- Define stale-revision behavior. A steer request with an old expected revision
  either rebases explicitly or returns a conflict showing the current head; it
  never silently overwrites work.
- Provide interface prompt guidance for provisional drafts, uncertainty,
  progress reports, cancellation, and the distinction between a child handle
  and a final answer.
- Verify the target DSH surface can admit a new parent turn while its supervisor
  child is active. If a surface serializes unrelated Sessions, adapt the
  surface; do not move the supervisor back into the interface turn.

### Exit criteria

- The interface agent starts a long process, returns an acknowledgement, and
  successfully handles another user message before the process completes.
- The user can inspect revision N, steer the process, and observe a later
  revision that names the applied command.
- Completion reaches the interface through an event or existing DSH job notice,
  with no repeated model polling.
- Restart preserves the process, last artifact revision, and unapplied commands;
  a missing process-local job mirror is reconstructed.
- Concurrent interface messages cannot create two writers or lose an artifact
  update.

## Milestone 6 — Hardening, upstreaming, and release

### Outcome

The future architecture is installable, diagnosable, resource-bounded, and
maintainable across DSH releases.

### Work

- Publish or prepare upstream PRs for any generally useful DSH seam still
  required, especially durable continuable-child deletion. Track accepted,
  replaced, and rejected proposals in the compatibility matrix.
- Add an optional process/container kernel provider behind `ctx.rlm`. Keep the
  local Jupyter provider's OS-authority warning; do not market HMAC transport as
  code isolation.
- Add quotas and pressure behavior for kernels, process jobs, concurrent
  workers, snapshots, blobs, context reads, artifact revisions, and retained
  terminal processes.
- Add scrubbed structured metrics for kernel generation, process state,
  revisions, context bytes disclosed, worker counts, cancellation, recovery,
  and garbage collection. Correlate with DSH usage records rather than
  duplicating token accounting.
- Add chaos tests for killed kernels, killed hosts, delayed worker reports,
  duplicate events, stale revisions, storage failures, full disks, corrupt
  snapshots, cancellation races, and provider teardown.
- Expand the compatibility suite to every supported operating system and exact
  DSH release. A new DSH release enters support only after the adapter audit and
  bundle smoke install pass.
- Add migration, rollback, storage backup, artifact retention, and security
  guidance. Rollback must preserve the old artifacts even when a newer metadata
  version cannot be opened by an older plugin.
- Publish the project-owned packages only when package provenance, licenses,
  isolated tarball installation, and a clean-host tutorial all pass.

### Exit criteria

- The complete gate passes on Windows, current macOS, and current Ubuntu using
  an exact unpatched DSH baseline.
- No cancellation or teardown test leaves a kernel, worker, socket, connection
  file, or active job behind.
- Recovery point and data-loss windows are documented and verified.
- Direct Python authority, snapshot trust, user-data retention, and tool-policy
  boundaries are accurately documented.
- A new contributor can use `ARCHITECTURE.md` to locate the correct package and
  run the smallest relevant test without first reading all of `SPEC.md`.

## Decisions that apply to every milestone

- **Public seams only.** Missing DSH behavior is upstreamed or reported as
  unsupported; private-state fallbacks are forbidden.
- **One orchestrator.** DSH owns every model loop, child Session, model route,
  tool policy, cancellation path, and usage record.
- **Durable before visible.** A process or artifact revision is announced only
  after its authoritative metadata commit succeeds.
- **Handles are not answers.** Child and process admission returns handles;
  reports, revisions, and terminal results are separate events.
- **No replay recovery.** Restore values and durable transitions, never old
  Python cells or already-applied user commands.
- **No continuous interface inference.** Deterministic infrastructure watches
  processes; the interface model wakes for conversation or judgment.
- **Fail closed on authority and corruption.** An unavailable capability,
  mismatched owner, stale generation, bad digest, or unknown storage version
  produces a stable failure rather than a weakened fallback.
- **Keep large values out of logs.** Events contain identifiers, digests, sizes,
  and outcomes—not source contexts, code, artifact bodies, credentials, or full
  exception objects.

## Deferred beyond this roadmap

- A general replacement for DSH's one-shot `ctx.codeRuntime`.
- A second agent harness or provider client inside Python.
- Full compatibility with Prime's TUI, heartbeat, ACP, MCP credential store,
  refinement system, or `AgentSession`.
- Collaborative multi-writer document editing. The first artifact protocol is
  deliberately single-writer with ordered steering commands.
- Claims that a local Python kernel is a security sandbox.

## Main risks

| Risk                                               | Mitigation                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| DSH pre-release APIs continue changing             | Pin exact releases, isolate one adapter, and run compatibility tests before changing the pin                         |
| `ctx.jobs` is process-local                        | Keep durable RLM process authority in `ctx.storageDomain`; use jobs only as a live projection                        |
| Prime removal accidentally changes Python behavior | Black-box fixtures precede extraction; preserve only the explicitly classified surface                               |
| `dill` can execute code during load                | Verify owner and digest host-side and load only plugin-produced snapshots inside the already trusted kernel boundary |
| User steering races artifact construction          | Ordered durable commands, one artifact writer, and compare-and-swap revisions                                        |
| Recursive work consumes unbounded resources        | Enforce depth, concurrency, byte, time, revision, and model-usage budgets at admission and commit boundaries         |
| Events wake the interface agent too often          | Deterministic event filtering and no model call for routine progress                                                 |
