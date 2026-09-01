# DSH alpha.3 upgrade verification

Date: 2026-08-31

## Scope

This report records the local compatibility and packaging evidence for moving
DeepSeek RLM from DeepSeek Harness `dsh-v0.1.0-rc.7` to the exact published
`dsh-v0.1.2-alpha.3` baseline.

## Audited baseline

| Component           | Exact selection                                                    |
| ------------------- | ------------------------------------------------------------------ |
| DeepSeek Harness    | `dsh-v0.1.2-alpha.3` at `dd6322d604e00eec1ba5e0c8541159906a21094a` |
| DSH packages        | `0.1.2-alpha.3` as one atomic set                                  |
| Cordis              | `4.0.2`                                                            |
| Cordis Loader       | `1.0.3`                                                            |
| Node.js             | `^22.19.0` or `>=24.0.0`                                           |
| Repository pnpm pin | `11.7.0`                                                           |
| Python              | `3.11` managed through `uv`                                        |

The Windows verification host used Node.js `24.19.0`, pnpm `11.24.0`, uv
`0.12.7`, and managed CPython `3.11.16`. CI installs the repository's exact
pnpm `11.7.0` pin.

## Compatibility findings

- DSH alpha.3 renamed the public LLM call identifier from `CallId` to
  `ToolCallId` and renamed subagent report delivery from `wakeup` to
  `next-step`.
- `AgentLoop` now requires `SessionProjectionRegistry`, and durable subagent
  listing requires the public `ctx.sessionQuery` service.
- Persisted continuable-child reasoning effort is native. The former
  reasoning-effort patch and runtime capability probe were removed; an
  integration test verifies `low` on the child's first request.
- The durable deletion patch remains necessary and was rebased to mount the
  alpha.3 session-query test service.
- The public ignorable-Session-event patch remains necessary for the current
  snapshot-authority event design and was rebased against alpha.3 Session
  sources.
- pnpm 11 moved smoke-project overrides to `pnpm-workspace.yaml`; the isolated
  tarball installer now writes that form.
- The Python suite invokes `python -m pytest`, avoiding platform-dependent
  console-script resolution under current uv on Windows.

## Executed verification

The following gates passed from a cleanly installed plugin workspace:

- `pnpm build`
- `pnpm check`
  - formatting, lint, and TypeScript project type checking;
  - 19 TypeScript unit tests;
  - 62 Python tests passed and 2 documented compatibility cases were deselected;
  - provenance, exact package pins, and patch-series validation;
  - 9 real Jupyter/DSH integration tests;
  - 5 bundle end-to-end tests.
- `pnpm package:bundle`
  - built and packed all five preview packages;
  - installed them into an isolated pnpm 11 project;
  - imported every public package entry point successfully.

The two RLM capability patches were also applied to a checkout at the exact DSH commit. The
upstream host build and client contract type check passed, followed by 251
passing targeted upstream tests:

- `packages/core/session/tests/session.spec.ts`
- `packages/subagent/subagent/tests/continuation.spec.ts`
- `packages/subagent/subagent/tests/list-children.spec.ts`
- `packages/subagent/subagent/tests/deletion.spec.ts`

No credentials, environment dumps, source prompts, or user data were captured
in this report.

## Deferred roadmap work

This upgrade does not remove the vendored Prime compatibility runtime, replace
snapshot authority with `ctx.storageDomain`, or implement the canonical
asynchronous RLM process/interface-agent layer. Those changes remain sequenced
in `MILESTONES.md`; they are intentionally separate from the atomic DSH pin
upgrade.
