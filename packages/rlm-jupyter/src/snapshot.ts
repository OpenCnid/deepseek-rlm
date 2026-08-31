/**
 * Per-variable namespace persistence adapted from Prime Agent at
 * f8f0036cc2da1a640aad990ae8dcb7c4820ce32e. Local changes add SHA-256,
 * atomic manifest replacement, DSH runtime metadata, and stricter exclusions.
 */
import { join } from 'node:path'

export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
export const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024
const resultMarker = '__DSH_RLM_KERNEL_STATE__'

/** Snapshot facts parsed from the helper marker. */
export interface SnapshotCapture {
  readonly saved: string[]
  readonly skipped: Array<{ name: string; reason: string }>
  readonly bytes: number
  readonly digest: string
}

/** Per-name restore outcome parsed from the helper marker. */
export interface SnapshotRestore {
  readonly restored: string[]
  readonly failed: Array<{ name: string; reason: string }>
}

export function snapshotPathIn(sessionDirectory: string): string {
  return join(sessionDirectory, 'kernel-state.dill')
}

export function manifestPathIn(sessionDirectory: string): string {
  return join(sessionDirectory, 'kernel-state.json')
}

function pythonString(value: string): string {
  return JSON.stringify(value)
}

/** Build a bounded, best-effort, atomic namespace snapshot cell. */
export function buildSnapshotCode(
  outputPath: string,
  manifestPath: string,
  maximumBytes: number,
  maximumVariableBytes: number,
  runtimeVersion: string,
): string {
  return `
def _dsh_rlm_snapshot_state():
    import builtins as _b, datetime, hashlib, io, json, os, sys
    try:
        import dill
    except _b.Exception as _err:
        _b.print(${pythonString(resultMarker)} + json.dumps({"error": "dill unavailable: " + _b.str(_err)}))
        return
    dill.settings["recurse"] = True
    ip = get_ipython()  # noqa: F821
    ns = ip.user_ns
    hidden = _b.set(_b.getattr(ip, "user_ns_hidden", {}) or {})
    excluded = {"rlm", "asyncio", "agent_message", "dsh_tools", "In", "Out", "get_ipython", "exit", "quit", "open"}

    class _Limit(_b.Exception):
        pass

    class _Buffer(io.BytesIO):
        def __init__(self, limit):
            io.BytesIO.__init__(self)
            self.limit = limit
        def write(self, chunk):
            if self.tell() + _b.len(chunk) > self.limit:
                raise _Limit()
            return io.BytesIO.write(self, chunk)

    payload = {}
    skipped = []
    total = 0
    for name in _b.sorted(_b.list(ns.keys())):
        if name.startswith("_") or name in hidden or name in excluded:
            continue
        remaining = ${maximumBytes} - total
        if remaining <= 0:
            skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
            continue
        buffer = _Buffer(_b.min(${maximumVariableBytes}, remaining))
        try:
            dill.dump(ns[name], buffer)
            blob = buffer.getvalue()
        except _Limit:
            reason = "exceeds per-variable snapshot size cap" if remaining >= ${maximumVariableBytes} else "exceeds aggregate snapshot size cap"
            skipped.append({"name": name, "reason": reason})
            continue
        except _b.Exception as _err:
            skipped.append({"name": name, "reason": "serialization failed (" + _b.type(_err).__name__ + ")"})
            continue
        payload[name] = blob
        total += _b.len(blob)

    while True:
        aggregate = _Buffer(${maximumBytes})
        try:
            dill.dump(payload, aggregate)
            encoded_payload = aggregate.getvalue()
            break
        except _Limit:
            if not payload:
                _b.print(${pythonString(resultMarker)} + json.dumps({"error": "snapshot size cap is too small for an empty payload"}))
                return
            removed = _b.next(_b.reversed(payload))
            total -= _b.len(payload.pop(removed))
            skipped.append({"name": removed, "reason": "exceeds aggregate snapshot size cap"})

    os.makedirs(os.path.dirname(${pythonString(outputPath)}), exist_ok=True)
    payload_tmp = ${pythonString(outputPath)} + ".tmp-" + os.urandom(8).hex()
    manifest_tmp = ${pythonString(manifestPath)} + ".tmp-" + os.urandom(8).hex()
    try:
        with _b.open(payload_tmp, "xb") as fh:
            fh.write(encoded_payload)
        try:
            os.chmod(payload_tmp, 0o600)
        except _b.Exception:
            pass
        digest = hashlib.sha256(encoded_payload).hexdigest()
        bytes_written = _b.len(encoded_payload)
        manifest = {
            "version": 1,
            "runtimeVersion": ${pythonString(runtimeVersion)},
            "pythonVersion": sys.version.split()[0],
            "savedNames": _b.sorted(payload.keys()),
            "skipped": skipped,
            "bytes": bytes_written,
            "digest": digest,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        with _b.open(manifest_tmp, "x", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, sort_keys=True)
        try:
            os.chmod(manifest_tmp, 0o600)
        except _b.Exception:
            pass
        os.replace(payload_tmp, ${pythonString(outputPath)})
        os.replace(manifest_tmp, ${pythonString(manifestPath)})
    except _b.Exception as _err:
        for path in (payload_tmp, manifest_tmp):
            try:
                os.remove(path)
            except _b.Exception:
                pass
        _b.print(${pythonString(resultMarker)} + json.dumps({"error": "write failed: " + _b.str(_err)}))
        return
    _b.print(${pythonString(resultMarker)} + json.dumps({"saved": manifest["savedNames"], "skipped": skipped, "bytes": bytes_written, "digest": digest}))

try:
    _dsh_rlm_snapshot_state()
finally:
    del _dsh_rlm_snapshot_state
`.trim()
}

/** Build a per-name restore cell. Historical cells are never replayed. */
export function buildRestoreCode(inputPath: string): string {
  return `
def _dsh_rlm_restore_state():
    import builtins as _b, json, os
    if not os.path.exists(${pythonString(inputPath)}):
        _b.print(${pythonString(resultMarker)} + json.dumps({"restored": [], "failed": []}))
        return
    try:
        import dill
        with _b.open(${pythonString(inputPath)}, "rb") as fh:
            payload = dill.load(fh)
    except _b.Exception as _err:
        _b.print(${pythonString(resultMarker)} + json.dumps({"restored": [], "failed": [], "error": "load failed: " + _b.str(_err)}))
        return
    if not _b.isinstance(payload, _b.dict):
        _b.print(${pythonString(resultMarker)} + json.dumps({"restored": [], "failed": [], "error": "corrupt snapshot: not a dict"}))
        return
    ns = get_ipython().user_ns  # noqa: F821
    restored = []
    failed = []
    for name, blob in payload.items():
        try:
            ns[name] = dill.loads(blob)
            restored.append(name)
        except _b.Exception as _err:
            failed.append({"name": name, "reason": "deserialization failed (" + _b.type(_err).__name__ + ")"})
    _b.print(${pythonString(resultMarker)} + json.dumps({"restored": _b.sorted(restored), "failed": failed}))

try:
    _dsh_rlm_restore_state()
finally:
    del _dsh_rlm_restore_state
`.trim()
}

function markerRecord(stdout: string): Record<string, unknown> | undefined {
  const index = stdout.lastIndexOf(resultMarker)
  if (index < 0) return undefined
  const line = stdout
    .slice(index + resultMarker.length)
    .split('\n', 1)[0]
    ?.trim()
  if (line === undefined || line.length === 0) return undefined
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function reasons(value: unknown): Array<{ name: string; reason: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { name?: unknown }).name === 'string' &&
      typeof (item as { reason?: unknown }).reason === 'string'
    ) {
      return [
        {
          name: (item as { name: string }).name,
          reason: (item as { reason: string }).reason,
        },
      ]
    }
    return []
  })
}

export function parseSnapshotCapture(stdout: string): SnapshotCapture | undefined {
  const value = markerRecord(stdout)
  if (
    value === undefined ||
    value.error !== undefined ||
    typeof value.bytes !== 'number' ||
    typeof value.digest !== 'string'
  ) {
    return undefined
  }
  return {
    saved: strings(value.saved),
    skipped: reasons(value.skipped),
    bytes: value.bytes,
    digest: value.digest,
  }
}

export function parseSnapshotRestore(stdout: string): SnapshotRestore | undefined {
  const value = markerRecord(stdout)
  if (value === undefined || value.error !== undefined) return undefined
  return { restored: strings(value.restored), failed: reasons(value.failed) }
}
