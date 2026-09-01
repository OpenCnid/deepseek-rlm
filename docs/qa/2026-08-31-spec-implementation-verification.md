# SPEC implementation verification

Date: 2026-08-31

## Scope

This report records the final local verification of the `SPEC.md` preview on
Windows. It supplements the alpha.3 upgrade report with focused hardening for
aggregate output and snapshot limits, exception-metadata redaction, nested-tool
call identity cleanup, lazy-generation lifecycle fencing, and a fresh-context
durable recovery integration.

No provider credentials, environment dumps, connection keys, prompts, source
cells, or user values were recorded.

## Exact baselines

| Component        | Selection                                                         |
| ---------------- | ----------------------------------------------------------------- |
| DeepSeek Harness | `dd6322d604e00eec1ba5e0c8541159906a21094a` / `dsh-v0.1.2-alpha.3` |
| Prime Agent      | `f8f0036cc2da1a640aad990ae8dcb7c4820ce32e`                        |
| Cordis           | `4.0.2`                                                           |
| Node.js          | `24.19.0`                                                         |
| pnpm             | `11.7.0`                                                          |
| uv               | `0.12.7`                                                          |
| managed Python   | `3.11.16`                                                         |

The two upstream repositories were inspected at those detached revisions,
including their repository instructions and the exact Agent, Session, tools,
subagent, Jupyter, and Prime runtime contracts used here.

## Hardening verified

- One UTF-8 byte budget now covers stdout, stderr, final expression text,
  exception messages, and traceback lines for a cell.
- The final serialized dill payload, including dictionary framing overhead, is
  held to `snapshot.maxBytes`; oversized values are removed individually.
- Snapshot skip/restore reasons retain exception types but omit arbitrary
  exception messages from durable metadata.
- Nested DSH tool-call sequence state is scoped to the active cell and released
  with it.
- Agent disposal and restart abort and fence a lazy generation during managed
  runtime resolution, kernel startup, bootstrap, or restore. A failed internal
  bootstrap cannot be published as a ready generation.
- A new integration writes DSH session events to JSONL, destroys the complete
  Cordis context, resumes a new exact Agent from persistence, and restores
  `x = 41` as `x + 1 == 42` from the authorized artifact without cell replay.
  Because workspace dependencies are the pristine published alpha.3 packages,
  the fixture mirrors only patch 0003's `ignorable: true` envelope bit; the
  patched Session writer itself is covered by the upstream suite below.

## Repository gates

The authoritative commands used pnpm 11.7.0 explicitly:

```powershell
pnpm dlx pnpm@11.7.0 install --frozen-lockfile
pnpm dlx pnpm@11.7.0 check
pnpm dlx pnpm@11.7.0 package:bundle
```

Results:

- frozen install: pass, lockfile already current;
- formatting, lint, and TypeScript project typecheck: pass;
- TypeScript unit tests: 8 files, 20 tests passed;
- Python bridge and selected pinned Prime runtime tests: 62 passed, 2
  documented compatibility cases deselected;
- provenance: exact DSH and Prime pins plus all 10 vendored-file digests passed;
- patch application and diff hygiene: both RLM capability patches passed against the exact DSH
  revision;
- package dependency/peer closure: all five packages passed;
- real Jupyter/DSH integration: 3 files, 11 tests passed;
- bundle e2e: 1 file, 5 tests passed; and
- isolated five-tarball install/import smoke: pass.

## Patched upstream DSH verification

Both patches were applied in filename order to a temporary detached DSH
worktree at the exact pin. Because this host exposes Node and pnpm but no `npm`
command, DSH's `typecheck` wrapper could not dispatch its internal `npm run`
commands; its two exact constituent stages were run directly instead:

```powershell
pnpm dlx pnpm@11.7.0 run build:lib:host
pnpm dlx pnpm@11.7.0 run typecheck:contracts-ready
pnpm dlx pnpm@11.7.0 exec vitest run `
  packages/core/agent-loop/tests/request-reconstruction.spec.ts `
  packages/core/session/tests/session.spec.ts `
  packages/subagent/subagent/tests/continuation.spec.ts `
  packages/subagent/subagent/tests/list-children.spec.ts `
  packages/subagent/subagent/tests/deletion.spec.ts
```

The host build, generated contracts, client contract typecheck, and all 277
targeted upstream tests passed. The temporary patched worktree was removed.

## Platform boundary

This current worktree was executed locally on Windows. The repository CI matrix
defines the same build, check, and bundle gates for Windows, Ubuntu, and macOS;
the current uncommitted changes have not been submitted to that remote matrix.
The next release action is to let those three jobs verify this exact tree before
publication. No package was published and no commit or remote operation was
performed.

IPython remains OS-authority execution. HMAC-authenticated loopback transport
does not sandbox Python, and direct Python filesystem, process, or network I/O
bypasses DSH tool guards. Only `dsh_tools.call()` traverses DSH tool policy,
approval, logging, cancellation, and telemetry.
