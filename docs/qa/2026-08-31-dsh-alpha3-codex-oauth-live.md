# Pinned DSH alpha.3 Codex OAuth live acceptance

Date: 2026-08-31

## Verdict

The final five-tarball bundle passed a real, non-mocked DeepSeek Harness run
using the OpenAI Codex provider, an existing Codex OAuth grant, and
`gpt-5.6-sol` with `high` reasoning. DeepSeek Harness remained the sole agent
harness and made every provider request.

The run proved all of the following in one parent/child flow:

- two separate parent IPython calls retained `x = 41` and produced `x + 1 == 42`;
- native `rlm()` admission created one continuable DSH child while omitting
  model and thinking overrides;
- the child used its own IPython kernel, explicitly reported 42 to its parent,
  and completed its first turn;
- a native parent-to-child follow-up resumed the same child;
- the child reused `child_value` without reassigning it, produced 43, explicitly
  reported 43, and completed its second turn; and
- the parent printed the final `LIVE_DSH_RLM=PASS` marker only after receiving
  both reports.

No Prime agent driver, ACP wrapper, Prime `AgentSession`, Python provider call,
or second Python agent loop was used.

## Exact inputs

| Component        | Selection                                                         |
| ---------------- | ----------------------------------------------------------------- |
| DeepSeek Harness | `dd6322d604e00eec1ba5e0c8541159906a21094a` / `dsh-v0.1.2-alpha.3` |
| Prime Agent      | `f8f0036cc2da1a640aad990ae8dcb7c4820ce32e`                        |
| Cordis           | `4.0.2`                                                           |
| model provider   | `openai-codex`                                                    |
| model            | `gpt-5.6-sol`                                                     |
| reasoning effort | `high`                                                            |
| Node.js          | `24.19.0`                                                         |
| pnpm             | `11.7.0` for repository gates                                     |
| uv               | `0.12.8`                                                          |
| managed Python   | `3.11`                                                            |

All four compatibility patches were applied in filename order to a disposable
checkout at the exact DSH revision. Patches 2 and 3 are the two RLM capability
seams; patches 4 and 5 are generic provider/CLI lifecycle fixes. DSH host,
client, and web builds passed, and `git diff --check` passed in that checkout.

The pinned alpha.3 profile did not expose an interactive Codex authorization
surface. A disposable test-only Cordis plugin therefore copied the existing
Codex OAuth grant into DSH's public credential service. No credential value or
authorization URL was printed or retained in this repository. That plugin was
not included in the RLM bundle. This verifies real Codex OAuth provider traffic
through DSH, but it does not test a fresh interactive login initiated by DSH.

## Defect found by the live run

The first real packaged run failed while uv installed the managed Python
runtime. On Windows, the Python build backend misresolved project metadata when
the source was addressed through a pnpm virtual-store path whose scoped package
segment contained `+`.

The Jupyter provider now copies its package-owned Python projects and lock file
to a short RLM-owned staging directory before invoking uv, then removes that
directory in `finally`. A focused regression test constructs the hostile pnpm
path. The final acceptance rerun moved the prior managed environment aside and
successfully provisioned a fresh one from the rebuilt tarball. It left zero
`.sources-*` staging directories.

Installation documentation was also corrected for pnpm 11:

- local tarball overrides and `allowBuilds.zeromq` belong in
  `pnpm-workspace.yaml`; and
- installing the bundle already activates its rows, so profile configuration
  must override `rlm-jupyter` by id rather than insert duplicate rows.

## Headless lifecycle defect found and fixed

The first successful live responses exposed a separate pinned-DSH lifecycle
defect: the headless process printed its answer but stayed alive. Repeating the
run with all RLM rows disabled reproduced the hold-open, isolating it from the
Jupyter provider and its managed processes.

Handle and disposal instrumentation identified the exact path:

1. DSH's `llm-pi-ai` adapter passes the DSH session ID to
   `@earendil-works/pi-ai@0.84.2`.
2. pi-ai caches one Codex WebSocket per session and arms a referenced five-minute
   idle timer.
3. Pinned DSH never called pi-ai's exported `cleanupSessionResources(sessionId)`.
4. After adding that public cleanup at exact-Agent disposal, the native
   WebSocket `close()` could still leave its TLS socket referenced while waiting
   for the peer close handshake.
5. The CLI cleared its five-second force-exit deadline as soon as application
   disposal completed, leaving that residual transport handle unbounded.

Patch 4 adapts the DSH lifecycle approach from reference commit
`d3edd5f1ee8e31325f6de54dbac67acb0d461872`: the adapter claims provider
resource ownership immediately before actual stream use, binds it to exact
`Agent` identity, uses exact `Session` identity only for agentless callers, and
calls the public pi-ai cleanup API after the Agent loop quiesces. Patch 5 keeps
the CLI's already-existing force-exit deadline armed but unreferenced after the
full application tree disposes. A quiescent process exits immediately; a
transport with a lingering referenced handle is forced only when the bound
expires.

This diagnosis is consistent with the upstream reports in
[DSH discussion 4190](https://github.com/deepseek-ai/deepseek-harness/discussions/4190)
and [pi issue 4103](https://github.com/earendil-works/pi/issues/4103).

## Durable evidence

The parent request header and both child request headers recorded exactly:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "reasoningEffort": "high"
}
```

The child descriptor recorded `mode: continuable`, provider `rlm-spawn`, and
the inherited OpenAI Codex route above. The durable tool and message events
recorded:

| Stage                  | Evidence                                                           |
| ---------------------- | ------------------------------------------------------------------ |
| parent cell 1          | separate successful `ipython` call assigning `x = 41`              |
| parent cell 2          | separate successful `ipython` call printing `42`                   |
| child initial turn     | child `ipython` result `42`, explicit parent report, accepted      |
| child continuation     | same child `ipython` result `43`, explicit parent report, accepted |
| child lifecycle        | two completed `turn/end` events                                    |
| parent final lifecycle | completed `turn/end` after both report messages                    |

The final stdout was:

```text
PARENT_STATE=42
CHILD_INITIAL=42
CHILD_FOLLOWUP=43
LIVE_DSH_RLM=PASS
```

Only route, lifecycle, tool result, and marker fields were inspected. Session
prompts, credential material, environment values, HMAC keys, and user data were
not copied into this report.

## Repository gates

Commands:

```powershell
pnpm dlx pnpm@11.7.0 check
pnpm dlx pnpm@11.7.0 package:bundle
```

Results:

- formatting, lint, and TypeScript typecheck: pass;
- TypeScript unit tests: 9 files, 21 tests passed;
- Python bridge and selected pinned Prime runtime tests: 62 passed, 2
  documented compatibility cases deselected;
- provenance: exact DSH and Prime revisions plus all 10 vendored-file digests
  passed;
- all four DSH compatibility patches: pass;
- five-package dependency and peer closure: pass;
- real Jupyter/DSH integration: 3 files, 11 tests passed;
- bundle E2E: 1 file, 5 tests passed; and
- isolated five-tarball install/import: pass.

Final package SHA-256 values:

| Package                                                  | SHA-256                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `deepseek-rlm-dsh-rlm-0.1.0-preview.0.tgz`               | `aca64e0b4d8ff0dd8b35527f63b0a6d639f46a873dc7e678c800d83e39d4e6ae` |
| `deepseek-rlm-dsh-rlm-bundle-0.1.0-preview.0.tgz`        | `a558931b3530d019c94fc32cc3c62ae9a24c3f3338c4c8852ce60419e8f03e53` |
| `deepseek-rlm-dsh-rlm-jupyter-0.1.0-preview.0.tgz`       | `076f733a932e3d5185c43d2a5e82f8c2b3d05ab726b82c4158c18be321c407db` |
| `deepseek-rlm-dsh-rlm-prime-runtime-0.1.0-preview.0.tgz` | `801fb6f0307166f645887f78fe9a68f169a817c0d019267c8fae3808d0c1b1f5` |
| `deepseek-rlm-dsh-tool-ipython-0.1.0-preview.0.tgz`      | `e8c30c6f3ec37be3a95bdab27d0f439913f43948e0fc905958e5f2ac83ffed1d` |

## Process-exit verification

With patches 4 and 5 applied, a real RLM-disabled Codex OAuth WebSocket control
printed `CONTROL_EXIT_FIXED` and returned exit code 0 in approximately 12.08
seconds without interruption. The full live RLM acceptance run then printed the
four markers above and also returned exit code 0 without interruption. A final
process scan found zero Node or managed Python processes associated with the
disposable DSH/RLM roots.

Focused upstream validation passed:

- pi-ai Agent/Session resource cleanup plus CLI shutdown: 2 files, 14 tests;
- the complete pinned `llm-pi-ai` suite plus CLI shutdown: 13 files, 286 tests;
- forced TypeScript project builds for `llm-pi-ai` and the CLI;
- dependency closure across all 52 DSH packages; and
- lint and `git diff --check`.

## Security boundary

IPython is OS-authority code execution, not a sandbox. Direct Python filesystem,
process, and network access does not traverse DSH tool policy. Only
`dsh_tools.call()` passes through DSH tool restrictions, approvals, logging,
cancellation, and telemetry. The live run used the empty-by-default kernel
environment and did not expose provider credentials to Python.
