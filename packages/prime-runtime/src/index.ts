import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Pinned Prime Agent revision represented by the staged runtime. */
export const PRIME_AGENT_REVISION = 'f8f0036cc2da1a640aad990ae8dcb7c4820ce32e'
/** Pinned Python shim version. */
export const PRIME_RUNTIME_VERSION = '0.1.0'
/** DSH host-bridge protocol version. */
export const DSH_RLM_BRIDGE_PROTOCOL_VERSION = 1

/** Absolute source directories installed into the managed Python environment. */
export interface PythonRuntimeAssets {
  readonly primeRuntime: string
  readonly dshRuntime: string
  readonly requirementsLock: string
}

async function isAssetRoot(path: string): Promise<boolean> {
  try {
    await Promise.all([
      access(resolve(path, 'prime-agent-runtime/pyproject.toml')),
      access(resolve(path, 'dsh-rlm-runtime/pyproject.toml')),
    ])
    return true
  } catch {
    return false
  }
}

/**
 * Locate packaged assets, with a source-workspace fallback used before the package is built.
 * @returns absolute paths to both local Python projects.
 */
export async function resolvePythonRuntimeAssets(): Promise<PythonRuntimeAssets> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const packaged = resolve(moduleDirectory, '../python')
  if (await isAssetRoot(packaged)) {
    return {
      primeRuntime: resolve(packaged, 'prime-agent-runtime'),
      dshRuntime: resolve(packaged, 'dsh-rlm-runtime'),
      requirementsLock: resolve(packaged, 'managed-requirements.lock'),
    }
  }

  let cursor = moduleDirectory
  for (let index = 0; index < 6; index += 1) {
    const primeRuntime = resolve(cursor, 'vendor/prime-agent-runtime')
    const dshRuntime = resolve(cursor, 'python/dsh-rlm-runtime')
    try {
      await Promise.all([
        access(resolve(primeRuntime, 'pyproject.toml')),
        access(resolve(dshRuntime, 'pyproject.toml')),
      ])
      return {
        primeRuntime,
        dshRuntime,
        requirementsLock: resolve(cursor, 'python/managed-requirements.lock'),
      }
    } catch {
      cursor = dirname(cursor)
    }
  }
  throw new Error('DSH RLM Python runtime assets are missing from the installed package')
}
