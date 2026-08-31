# Install DeepSeek RLM

DeepSeek RLM is currently a local five-package preview for one audited DeepSeek
Harness release. Complete every section in order; mixing DSH versions or
registry-installed host packages can split Cordis service identities.

## Prerequisites

- DeepSeek Harness revision
  `dd6322d604e00eec1ba5e0c8541159906a21094a`
  (`dsh-v0.1.2-alpha.3`)
- Node.js `^22.19` or `>=24`
- pnpm `11.7.0`
- `uv`, with permission to provision Python 3.11
- absolute writable directories for RLM artifacts and the managed runtime

## 1. Build the local packages

```sh
pnpm install --frozen-lockfile
pnpm package:bundle
```

The command builds, packs, installs, and imports all five packages in an
isolated smoke project. The tarballs are written to `artifacts/packages/`.

## 2. Patch the pinned DSH checkout

Apply the patches in filename order to the exact revision above:

```sh
git -C /path/to/deepseek-harness apply /path/to/deepseek-rlm/patches/deepseek-harness/0002-continuable-child-deletion.patch
git -C /path/to/deepseek-harness apply /path/to/deepseek-rlm/patches/deepseek-harness/0003-public-ignorable-session-events.patch
```

DSH alpha.3 natively provides validated, persisted per-child reasoning. Patch
2 provides public durable child deletion. Patch 3 makes independently defined `rlm/*`
informational events safe for cold reads. Missing patches produce explicit
unsupported-capability errors; the plugin does not substitute a weaker path.

Verify the series against a disposable checkout when changing either side:

```sh
DSH_SOURCE=/absolute/path/to/deepseek-harness pnpm verify:patches
```

On PowerShell:

```powershell
$env:DSH_SOURCE = 'D:\absolute\path\to\deepseek-harness'
pnpm verify:patches
```

## 3. Initialize the DSH profile

```sh
dsh plugin --profile <profile> install
```

Keep the profile-created `nodeLinker: hoisted` and `autoInstallPeers: false`
settings. Cordis and DSH host packages are peers and must resolve from DSH's
installation-managed `profiles/node_modules` fallback. Do not install registry
copies of those host packages into the profile.

## 4. Point internal edges at the local tarballs

The preview package names are not published. Add `pnpm.overrides` to
`$DSH_HOME/profiles/<profile>/package.json`, using absolute `file:` URLs for the
four internal package edges:

```json
{
  "pnpm": {
    "overrides": {
      "@deepseek-rlm/dsh-rlm": "file:D:/deepseek-rlm/artifacts/packages/deepseek-rlm-dsh-rlm-0.1.0-preview.0.tgz",
      "@deepseek-rlm/dsh-rlm-prime-runtime": "file:D:/deepseek-rlm/artifacts/packages/deepseek-rlm-dsh-rlm-prime-runtime-0.1.0-preview.0.tgz",
      "@deepseek-rlm/dsh-rlm-jupyter": "file:D:/deepseek-rlm/artifacts/packages/deepseek-rlm-dsh-rlm-jupyter-0.1.0-preview.0.tgz",
      "@deepseek-rlm/dsh-tool-ipython": "file:D:/deepseek-rlm/artifacts/packages/deepseek-rlm-dsh-tool-ipython-0.1.0-preview.0.tgz"
    }
  }
}
```

Use forward slashes in Windows `file:` URLs. On macOS or Linux, use an absolute
URL such as `file:/home/user/deepseek-rlm/artifacts/packages/...tgz`.

## 5. Configure runtime roots

Merge the rows from
[`packages/bundle/example.cordis.yml`](../packages/bundle/example.cordis.yml)
into the profile's `cordis.patch.yml`. At minimum, replace these absolute
paths:

```yaml
config:
  artifactRoot: D:/dsh-state/rlm-artifacts
  managedRuntimeRoot: D:/dsh-state/rlm-runtime
```

The default composition uses `rlm-spawn`, `maxDepth: 1`, snapshots after each
cell, and no Python-to-DSH tools adapter. The spawn-provider wrapper publishes
its readiness service only after native DSH registration commits, so Loader row
order is not used as a timing contract.

Important defaults:

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

`shellPath` replaces a bare `%%bash` with `%%script <shell>`. `commandPrefix`
is applied only to a leading `%%bash` cell. Keep the deferred goal and
compaction adapters disabled.

## 6. Install and verify the bundle

```sh
dsh plugin --profile <profile> add -w /absolute/path/to/artifacts/packages/deepseek-rlm-dsh-rlm-bundle-0.1.0-preview.0.tgz
dsh --profile <profile> --dump-default-config
```

The dump must contain exactly one active row for each of:

- `rlm-spawn-provider`
- `rlm-jupyter`
- `rlm-ipython-tool`

Start the profile and verify two consecutive `ipython` calls share a variable.
Then admit a child with `await rlm(...)` and require it to report through
`agent_message.send()`.

## Troubleshooting

- **`UNSUPPORTED_DELETION`:** rebuild the exact DSH checkout with patch 2.
- **`UNSUPPORTED_IGNORABLE_SESSION_EVENTS`:** apply patch 3. A live-only event
  is intentionally not used as fallback.
- **Managed runtime startup failure:** confirm `uv` is on `PATH`, both runtime
  roots are writable, and Python 3.11 can be installed. A custom Python must be
  absolute and import `ipykernel`, `dill`, `nest_asyncio`, `rlm`, and
  `dsh_rlm_runtime`.
- **`%%bash` on Windows:** configure an absolute Git Bash, Cygwin, or compatible
  executable using `shellPath`.
- **Snapshot restore diagnostic:** the event/file digest pair is authoritative.
  Missing or corrupt files start an empty namespace; orphan files are ignored.
- **Missing spawn provider:** confirm the bundle row is enabled. The Jupyter row
  deliberately fails startup rather than racing or substituting another
  backend.

## Upgrade policy

An upstream upgrade requires updating both revision pins, regenerating Prime
file digests and the Python lock, rebasing all DSH patches, and rerunning the
host-protocol, kernel, event-vocabulary, Loader/package, license, and upstream
patch suites. See [SPEC.md](../SPEC.md) and
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
