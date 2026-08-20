<p align="center">
  <img src="./docs/assets/deepseek-rlm.svg" alt="DeepSeek RLM — persistent Python state and native recursive subagents for DeepSeek Harness" width="100%" />
</p>

# DeepSeek RLM

DeepSeek RLM adds one persistent, authenticated IPython kernel to each DeepSeek Harness agent and exposes Prime-compatible recursive-language-model calls from Python. DeepSeek Harness remains the only harness: it creates and drives every parent and child agent, owns model credentials and policy, records tool/session history, and enforces lineage, depth, cancellation, and persistence.

> **What “RLM” means here:** a Recursive Language Model workflow gives an agent durable Python working memory and lets it delegate focused work to native DeepSeek Harness subagents. This repository is a plugin bundle for DeepSeek Harness (DSH), not a second harness and not a DeepSeek model.

The repository implements the complete core path described by [`SPEC.md`](./SPEC.md):

- `@deepseek-rlm/dsh-rlm` — provider-neutral `ctx.rlm` Service Definition and typed events;
- `@deepseek-rlm/dsh-rlm-jupyter` — persistent Jupyter v5/HMAC transport, Python provisioning, snapshots, and host bridge;
- `@deepseek-rlm/dsh-tool-ipython` — exclusive native `ipython` tool and prompt guidance;
- `@deepseek-rlm/dsh-rlm-prime-runtime` — reproducible Python assets containing the exact Prime shim and the separate DSH bridge; and
- `@deepseek-rlm/dsh-rlm-bundle` — Loader-compatible [`dsh.bundle.patch`](./packages/bundle/dsh.bundle.patch).

No production code starts `prime-agent`, wraps Prime ACP, instantiates Prime `AgentSession`, calls an LLM provider from Python, or runs a second agent loop.

## Pinned baselines

- DeepSeek Harness `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` (`dsh-v0.1.0-rc.7`)
- Prime Agent `f8f0036cc2da1a640aad990ae8dcb7c4820ce32e`

The Prime `prime-agent-runtime` directory is vendored byte-for-byte under [`vendor/prime-agent-runtime`](./vendor/prime-agent-runtime). Adapted kernel, snapshot, and `%%bash` behavior is recorded in [`provenance/upstreams.json`](./provenance/upstreams.json).

## Install

Build and pack this workspace with pnpm 9 and `uv` available:

```text
pnpm install --frozen-lockfile
pnpm package:bundle
```

This produces five local tarballs under [`artifacts/packages`](./artifacts/packages) and verifies them by installing and importing all five from an isolated project. Because preview package names are not published, initialize the target profile, then add `pnpm.overrides` in `$DSH_HOME/profiles/<profile>/package.json` for the four internal package names, each pointing at its absolute `file:/.../*.tgz` path. Finally install the bundle:

```text
dsh plugin --profile <profile> install
dsh plugin --profile <profile> add -w /absolute/path/deepseek-rlm-dsh-rlm-bundle-0.1.0-preview.0.tgz
dsh --profile <profile> --dump-default-config
```

The required override keys are `@deepseek-rlm/dsh-rlm`, `@deepseek-rlm/dsh-rlm-prime-runtime`, `@deepseek-rlm/dsh-rlm-jupyter`, and `@deepseek-rlm/dsh-tool-ipython`. They make pnpm resolve internal package edges to the sibling tarballs instead of the public registry. The DSH CLI recognizes the bundle’s `dsh.bundle` manifest and appends it after the existing profile bundles. Published packages do not need local overrides. Override the absolute artifact/runtime roots with the profile’s `cordis.patch.yml`; [`packages/bundle/example.cordis.yml`](./packages/bundle/example.cordis.yml) is a complete Windows example.

Keep the profile-created `nodeLinker: hoisted` and `autoInstallPeers: false` settings. The bundle declares Cordis and DSH host packages as peers so Node resolves them from DSH's installation-managed `profiles/node_modules` fallback. Installing registry copies of those host packages into the profile can split service symbols or replace the three patched seams with unpatched rc.7 implementations; the package check rejects such host dependencies in the bundle.

The bundle does not rely on YAML row order. Its `rlm-spawn-provider` wrapper publishes `rlmSpawnReady` only after native `rlm-spawn` registration commits, and the existing `rlm-jupyter` row injects that service before validating the exact configured provider. A missing or disabled provider therefore remains a visible startup error rather than a timing race or a substituted backend.

Full parity on rc.7 requires applying these patches, in order, to the exact DSH source revision and rebuilding its packages:

```text
git apply /path/to/deepseek-rlm/patches/deepseek-harness/0001-persisted-child-reasoning-effort.patch
git apply /path/to/deepseek-rlm/patches/deepseek-harness/0002-continuable-child-deletion.patch
git apply /path/to/deepseek-rlm/patches/deepseek-harness/0003-public-ignorable-session-events.patch
```

Patch 1 supplies validated, persisted per-child reasoning. Patch 2 supplies public durable deletion. Patch 3 exposes the existing `ignorable: true` event-envelope contract so out-of-tree `rlm/*` events survive cold reads. Without patches 1 or 2, `thinking` and deletion return stable unsupported-capability errors. Without patch 3, the provider fails loudly before writing an event it cannot safely restore.

The pinned DSH repository itself declares Node `^22.19 || >=24` and uses `Promise.withResolvers`; therefore run the complete pinned harness on Node 22.19 or newer. This workspace’s standalone packages and tests target Node 20, but they cannot lower the engine requirement of the pinned host.

## Use

State persists between calls in the same agent:

```python
x = 41
```

```python
x + 1  # 42
```

Native recursion returns at DSH inbox admission, not at child completion:

```python
worker = await rlm(
    "Investigate the failing test and explicitly report the cause.",
    name="investigator",
    model="provider/model",
    thinking="high",
)
```

The child reports with:

```python
import agent_message
await agent_message.send("Cause: ...", receiver_role="parent")
```

The parent follows up with:

```python
await agent_message.send(
    "Now verify the smallest fix.",
    receiver_role="child",
    receiver_name=worker.name,
)
```

`await rlm.find_models()`, `await rlm.list_subagents()`, and `await rlm.delete_subagent(worker)` translate to public DSH services. When enabled, `await dsh_tools.list()` and `await dsh_tools.call(name, arguments)` remain inside the originating `ipython` tool execution and route through `ctx.tools`.

## Configuration

The Jupyter provider validates absolute writable artifact/runtime roots, executable overrides, positive safe integer limits, duplicate environment entries, and RLM-owned environment names at startup. Important defaults are:

| Setting                     | Default      |
| --------------------------- | ------------ |
| `subagentProvider`          | `rlm-spawn`  |
| `maxDepth`                  | `1`          |
| `maxConcurrentKernelBoots`  | `4`          |
| `interruptGraceMs`          | `2000`       |
| `shutdownGraceMs`           | `5000`       |
| `hostRequestDrainMs`        | `5000`       |
| `maxOutputBytes`            | 4 MiB        |
| `snapshot.policy`           | `after-cell` |
| `snapshot.maxBytes`         | 256 MiB      |
| `snapshot.maxVariableBytes` | 16 MiB       |
| `envAllowlist`              | empty        |

`shellPath` replaces a bare `%%bash` with `%%script <shell>`. `commandPrefix` is prepended only to a leading `%%bash` cell. The optional tools adapter verifies `ctx.tools` at startup. Goal and compaction host adapters are deferred; keep those flags false.

## Persistence and lifecycle

Each DSH session owns `<artifactRoot>/sessions/<SessionId>`. Namespace values are serialized independently with `dill`, bounded per value and in aggregate, written by temporary-file plus atomic replacement, and authorized by a digest-matched `rlm/kernel-snapshot` event. Restore never replays old cells, so file/network/subprocess side effects are not repeated. Unpicklable variables are reported and skipped.

Cells are FIFO within one kernel; different agents and admitted children may run concurrently. Cancellation first sends a Jupyter interrupt. A cell that ignores it causes process-tree termination, generation retirement, and lazy restart. Disposal snapshots when possible, aborts and drains host requests, sends `shutdown_request`, then force-cleans the process tree and connection directory. HMR generations are fenced so two providers cannot race over one snapshot.

## Verification

```text
pnpm build
pnpm check
```

`check` runs formatting, lint, typecheck, unit tests, Python bridge and applicable pinned-Prime tests, provenance/patch/package checks, real Jupyter and DSH integration tests, and bundle e2e tests. The upstream patch suite was also verified in the pinned DSH worktree on Node 22: 261 targeted tests pass. CI covers Windows, Ubuntu, and macOS; a separate job checks the patch series against a fresh pinned DSH clone.

## Security

IPython is OS-authority code execution, not a sandbox. HMAC and loopback-only ZeroMQ protect transport integrity; they do not restrict Python. Python code, `%%bash`, direct file access, sockets, imports, and subprocesses can bypass DSH tool guards. Only `dsh_tools.call()` traverses DSH tool restrictions, guards, approval, logging, and telemetry. Put the entire kernel process in an external OS/container sandbox if untrusted model-generated code needs confinement.

The kernel receives an empty-by-default ambient environment plus explicitly allowlisted/configured values and RLM-owned paths. Provider credentials and full environment values never enter model catalogs or lifecycle events. Session IDs, not user labels, determine artifact paths.

## Troubleshooting and upgrades

- `UNSUPPORTED_REASONING_EFFORT` or `UNSUPPORTED_DELETION`: rebuild DSH with patches 1 or 2.
- `UNSUPPORTED_IGNORABLE_SESSION_EVENTS`: apply patch 3; typed live-only appends are intentionally not used as a fallback.
- Managed runtime startup failure: ensure `uv` is on `PATH`, the runtime root is writable, and Python 3.11 can be installed. A custom Python must be absolute and import `ipykernel`, `dill`, `nest_asyncio`, `rlm`, and `dsh_rlm_runtime`.
- `%%bash` on Windows: configure an absolute Git Bash/Cygwin/WSL-compatible executable with `shellPath`.
- Restore diagnostic: the event/file digest pair is authoritative. Missing or corrupt files start an empty namespace; orphan files are ignored.

For an upstream upgrade, update the revision pins, regenerate the Prime file digests and Python lock, rebase all DSH patches, and rerun host-protocol, kernel, event-vocabulary, Loader/package, license, and upstream patch tests. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for licensing.
