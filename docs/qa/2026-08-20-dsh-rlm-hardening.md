# DSH RLM post-fix hardening QA

Date: 2026-08-20

## Verdict

The safely executable post-fix hardening cases passed:

- concurrent native child admission and interleaved reporting with real ChatGPT-subscription OAuth requests;
- forced DSH termination during an active IPython cell;
- corrupt-snapshot detection and fail-closed recovery without cell replay; and
- managed-runtime integration and end-to-end testing on Windows and Ubuntu 24.04 under WSL2.

The OpenAI Codex provider's controlled authentication-error suite also passed. A live OAuth expiry or revocation during a child turn was not induced because the test environment had only one DSH-owned credential, and invalidating it would have been destructive. Interactive macOS OAuth coverage was not available.

This was a verification-only run. No product source, credential, or normal user profile was modified.

## Revisions and configuration

| Component             | Revision                                   |
| --------------------- | ------------------------------------------ |
| DeepSeek RLM          | `4bd3ee73e7e247e5dfef1961606f75da9eadde26` |
| OpenAI Codex provider | `a63a72f8c3240364a437c4ea1f14eb641116c116` |
| DeepSeek Harness      | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` |
| DSH release           | `dsh-v0.1.0-rc.7`                          |

The disposable DSH profile used:

- `subagentProvider: rlm-spawn`;
- `maxDepth: 1`;
- snapshot policy `after-cell`;
- `envAllowlist: []` and `env: {}`;
- all deferred adapters disabled; and
- no `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or API-key fallback.

The final composed configuration contained exactly one active row for each of:

- `deepseek-openai-codex`;
- `rlm-spawn-provider`;
- `rlm-jupyter`; and
- `rlm-ipython-tool`.

The OpenAI Codex plugin card reported **Configured**. Existing DSH-owned OAuth state was used without inspecting or exporting the credential, and no manual sign-in was required.

## Package artifacts

The profile used the five-package RLM bundle built from the exact lockfile.

| Package                                                  | SHA-256                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `deepseek-rlm-dsh-rlm-0.1.0-preview.0.tgz`               | `EA2662E8335C8A8D8EA831CEF8F979DEDE85C2416608B80AA070993B94D59A7A` |
| `deepseek-rlm-dsh-rlm-bundle-0.1.0-preview.0.tgz`        | `98F6BE384AB68A3682EAEEAFFCD50A52A9C8E9912F74C58B622E9FA73AAA4D1C` |
| `deepseek-rlm-dsh-rlm-jupyter-0.1.0-preview.0.tgz`       | `8F4F6B4C512FFC7C789A199BDF7A175D1B54210476DD204C45A2C4CA6DCC50F0` |
| `deepseek-rlm-dsh-rlm-prime-runtime-0.1.0-preview.0.tgz` | `801FB6F0307166F645887F78FE9A68F169A817C0D019267C8FAE3808D0C1B1F5` |
| `deepseek-rlm-dsh-tool-ipython-0.1.0-preview.0.tgz`      | `FF9C06889A95505D5179173D14CAC5A87101D81C021DC8E356D880F5988FBC5D` |

The Codex-provider tarball SHA-256 was `26F86AB74CF5CEE39D9670CE6089914AD0FF0EA4BB62D5E7E821D8143A8431E9`.

## Concurrent child and report-pressure test

The parent ran through the normal DSH AgentLoop with the authoritative request route:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "reasoningEffort": "high"
}
```

Five `rlm()` calls were admitted concurrently with `asyncio.gather`. Every call omitted `model` and `thinking`.

The results were:

| Child      | Initial report | Follow-up report |
| ---------- | -------------: | ---------------: |
| `stress_0` |             11 |              111 |
| `stress_1` |             22 |              122 |
| `stress_2` |             33 |              133 |
| `stress_3` |             44 |              144 |
| `stress_4` |             55 |              155 |

Evidence from the durable session streams showed:

- five successful `rlm.run` host requests;
- five unique native `RLMSpawnHandle` child IDs and names;
- `origin: subagent`, `delegationDepth: 1`, and the real parent session for every child;
- initial and resumed child request headers exactly matching `openai-codex/gpt-5.6-sol`;
- native child IPython calls;
- two successful parent reports from every child;
- five successful concurrent parent-to-child follow-ups;
- ten correctly attributed reports with no duplicate result; and
- exactly five direct children, with no extra child or grandchild.

Omitted `thinking` intentionally left the child reasoning effort unspecified, as documented. It did not cause provider/model substitution.

No Prime agent, Prime ACP, Prime AgentSession, Python provider request, simulated child, or second Python agent loop was used.

## Forced termination during an active cell

One IPython cell:

1. set an in-memory `started` marker;
2. appended one line to a fresh sentinel;
3. slept for 120 seconds; and
4. would then have set a `completed` marker.

While the tool was visibly running and the sentinel contained exactly one line, the exact DSH listener process was force-stopped.

Within two seconds:

- the DSH listener count was zero; and
- all managed kernel processes were gone.

After restarting the same disposable profile and resuming the same session, DSH reconstructed the tool call as interrupted with no durable result, reported its outcome as unknown, and warned against blind retry. A separate safe probe found neither in-memory marker. The sentinel still contained exactly one line, proving the side-effecting historical cell was not replayed.

## Corrupt-snapshot recovery

A checkpoint cell set an in-memory value to 77 and appended one line to a fresh sentinel. The resulting snapshot was 511 bytes with digest:

```text
8041f266f5eee23c139f6914b81883718cda09b64900a5566ff7093f567a9589
```

After a clean DSH shutdown, the snapshot and manifest were backed up. One byte in only the disposable active payload was flipped. Its SHA-256 became:

```text
691F392BC17072A167DE2D94F3F1072DD07636E567A3989B0E66563833AD6525
```

On restart, the durable restore event:

- retained the authoritative manifest digest;
- restored no variables; and
- reported `snapshot digest mismatch`.

A safe probe confirmed that the checkpoint variables were absent. The sentinel remained exactly one line. RLM therefore failed closed with a fresh namespace, did not load corrupt state, and did not replay the historical cell. A subsequent valid empty-namespace snapshot was written with digest:

```text
926248e52d1fa532c317e37da24ed652ae64110f8219cb5e061668bd3091f048
```

## Cross-platform managed runtime

The exact RLM revision was tested on Ubuntu 24.04 under WSL2 with:

- Linux kernel `6.6.87.2`;
- Node `v24.19.0`;
- pnpm `9.14.4`; and
- uv `0.12.3`.

An initial control run from the Windows-mounted DrvFS checkout was pathologically slow while creating the Python environment, and one provider test exceeded its 120-second timeout. The same exact clean revision was therefore tested from native WSL ext4, where the frozen install completed in 4.4 seconds.

Commands:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test:integration
pnpm test:e2e
```

Results on ext4:

- build: PASS;
- integration: 3 files / 8 tests passed;
- E2E: 1 file / 5 tests passed; and
- final matching Linux Node, Python, and uv process count: zero.

The integration suite covered persistent and isolated namespaces, restore without replay, active-cell disposal, the real DSH AgentLoop and tool registry, provider-generation restore, and host integration.

Repository CI independently exercises Ubuntu, Windows, and macOS package validation. This run did not perform an interactive macOS OAuth session.

## Controlled authentication-error coverage

The exact Codex-provider revision ran:

```powershell
pnpm exec vitest run tests/unit/adapter-errors.spec.ts tests/unit/coordinator.spec.ts tests/unit/credential.spec.ts
```

Result: 3 files / 31 tests passed.

These tests cover sanitized HTTP 401 mapping, auth-failure redaction, an expired login attempt terminating as `AUTH_EXPIRED`, concurrent-login coordination, and credential codec/store validation.

This does not replace an end-to-end live OAuth expiry during a child turn. That remaining test requires either a second disposable DSH-owned credential that may be revoked or a supported one-shot authentication fault-injection seam.

The future live-expiry assertions should include:

- no provider/model fallback;
- no API-key fallback;
- sanitized terminal errors in both child and parent;
- no duplicate tool or cell execution;
- the same continuable child identity after reauthentication; and
- clean kernel and process disposal.

## Cleanup and repository state

At the end of the run:

- DSH listener count was zero;
- Windows managed-kernel count was zero;
- live Jupyter connection-file count was zero;
- Linux managed test-process count was zero;
- Prime/ACP/AgentSession process count was zero;
- both no-replay sentinels contained exactly one line;
- all three original source worktrees were clean; and
- the disposable RLM, Codex-provider, Windows-mounted Linux, and native Linux checkouts were clean.

The disposable DSH checkout retained only the three documented compatibility patches, and `git diff --check` passed.

## Follow-up hardening recommendations

1. Run live OAuth expiry with a second disposable credential or supported one-shot 401 injection.
2. Run an interactive macOS OAuth/managed-runtime test.
3. Add a longer 10-child soak with repeated interleaved follow-ups after deterministic report waiting is available.
4. Extend corrupt-state coverage to a missing manifest, truncated payload, stale generation, and unwritable snapshot directory.
5. Exercise graceful `SIGTERM` or Windows service-stop behavior separately from a hard kill, including an active child cell.

## Security note

IPython is not a sandbox. It executes with the operating-system authority of the DSH process.
