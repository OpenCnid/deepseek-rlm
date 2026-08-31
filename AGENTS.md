# Repository guidance for coding agents

## Purpose and ownership boundary

This monorepo adds persistent IPython state and native recursive subagents to
DeepSeek Harness through five Cordis packages. DSH is always the sole harness
and authority for models, tools, approvals, sessions, lineage, persistence,
cancellation, and child lifecycle.

Preserve these invariants:

- Never start `prime-agent`, wrap Prime ACP, instantiate Prime `AgentSession`,
  call an LLM provider from Python, or introduce a second agent loop.
- One exact live DSH `Agent` owns one lazy Jupyter kernel; one `SessionId` owns
  its artifact directory.
- Python host requests translate through public `ctx.llm`, `ctx.subagents`, and
  optional `ctx.tools` services using the originating Agent as authority.
- Historical cells are never replayed during restore. Snapshot files require a
  matching durable digest event.
- Child admission, continuation, model routing, reasoning effort, messaging,
  deletion, and cold restore remain native DSH operations.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the system map and ownership
boundaries. Read [SPEC.md](SPEC.md) before architecture, protocol, snapshot,
lifecycle, or security changes. Read [MILESTONES.md](MILESTONES.md) before
post-preview migration work, and read
[patches/deepseek-harness/README.md](patches/deepseek-harness/README.md) before
changing DSH compatibility seams.

## Repository map

- `packages/rlm`: provider-neutral `ctx.rlm` Service Definition and events.
- `packages/rlm-jupyter`: ZeroMQ/Jupyter transport, kernel lifecycle, managed
  Python, host bridge, and snapshot implementation.
- `packages/tool-ipython`: exclusive native `ipython` tool and prompt guidance.
- `packages/prime-runtime`: package-time staging and location of Python assets.
- `packages/bundle`: Loader patch and readiness-gated native spawn provider.
- `python/dsh-rlm-runtime`: project-owned Python bridge modules and tests.
- `vendor/prime-agent-runtime`: exact vendored upstream Prime runtime pin.
- `patches/deepseek-harness`: ordered patches for the exact DSH alpha.3 revision.
- `provenance`: upstream revision facts and vendored-file digests.
- `tests`: workspace-level integration and bundle e2e tests.
- `ARCHITECTURE.md`: short system map, ownership boundaries, and invariants.
- `MILESTONES.md`: post-preview migration sequence and acceptance criteria.
- `docs/qa`: assembled hardening evidence; never place credentials here.

## Toolchain and validation

Use Node.js `^22.19` or `>=24`, pnpm `11.7.0`, `uv`, and a provisionable Python 3.11:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Run the smallest relevant test while iterating:

```sh
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:python
```

Before handoff, run the complete gates:

```sh
pnpm check
pnpm package:bundle
```

`check` includes formatting, lint, type checking, TypeScript/Python tests,
provenance, patch verification, package inspection, real Jupyter/DSH
integration, and bundle e2e behavior. Package changes are incomplete until the
isolated five-tarball smoke install succeeds.

## Compatibility and generated assets

- DSH is pinned to `dd6322d` / `dsh-v0.1.2-alpha.3`, Cordis to `4.0.2`, and Prime
  Agent to `f8f0036`. Do not widen or move one pin without a full audit.
- Treat the DSH package set as atomic. Registry copies in a profile can split
  service symbols and shadow patched host seams.
- Apply the two DSH patches in filename order. If a capability is missing,
  fail with its stable unsupported error; do not add a private-state or
  live-only fallback.
- Do not hand-edit `vendor/prime-agent-runtime`. An upstream change requires a
  new audited pin, license review, file-digest regeneration, Python lock update,
  and upstream tests.
- `packages/prime-runtime` stages owned and vendored Python assets during the
  build. Keep source changes in `python/` or the audited vendor update, not in
  generated package output.

## Security invariants

- IPython is OS-authority execution, not a sandbox. Never document it as
  constrained by DSH tool policy.
- Only `dsh_tools.call()` traverses DSH tool restrictions, guards, approval,
  logging, and telemetry.
- Start kernels with an empty-by-default environment. Pass only validated,
  explicitly allowlisted/configured values and RLM-owned paths.
- Never place provider credentials, complete environment values, connection
  keys, tokens, or user data in events, snapshots, logs, fixtures, QA evidence,
  screenshots, or errors.
- Keep Jupyter transport HMAC-authenticated and loopback-only. Validate protocol
  frames and bound output, snapshot, variable, queue, and timeout resources.
- Cancellation must retire a kernel generation that ignores interrupt, kill
  its process tree, fence stale work, and restart lazily.

## Change checklist

- Service or event change: update `packages/rlm`, consumers, type tests,
  integration tests, and the normative spec.
- Kernel/protocol change: cover HMAC frames, IOPub/shell ordering, interruption,
  process cleanup, generation fencing, and malformed input.
- Snapshot change: cover per-value and aggregate limits, atomic replacement,
  digest authorization, corruption, orphan files, and no-replay recovery.
- Subagent bridge change: cover active-request model inheritance, explicit
  reasoning, admission timing, continuation, messaging, deletion, cancellation,
  and depth limits.
- Bundle or dependency change: verify peer ownership, readiness gating, pack
  contents, isolated install/import, and real DSH composition.
- DSH/Prime upgrade: update pins, provenance, locks, patches, notices, QA
  evidence, compatibility text, and every cross-upstream test.
- User-flow change: keep [README.md](README.md) short, update
  [docs/INSTALL.md](docs/INSTALL.md), and refresh only scrubbed evidence that no
  longer matches reality.

## Documentation style

The root README is the shortest safe path for a human: purpose, compatibility,
build/install entry point, first persistent cell, first child, security, and
verification. Put local-tarball mechanics and troubleshooting in
`docs/INSTALL.md`, normative behavior in `SPEC.md`, patch detail beside the
patches, and executed evidence in `docs/qa`.

Use relative links and copy-pastable commands. Do not claim registry
availability, sandbox isolation, unpatched DSH support, or child completion at
`rlm()` return.
