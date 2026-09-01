import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  cp,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  DSH_RLM_BRIDGE_PROTOCOL_VERSION,
  PRIME_AGENT_REVISION,
  PRIME_RUNTIME_VERSION,
  resolvePythonRuntimeAssets,
} from '@deepseek-rlm/dsh-rlm-prime-runtime'

const runtimeMarkerVersion = 1
const provisionOutputLimit = 64 * 1024
const provisions = new Map<string, Promise<string>>()

/** Runtime assets copied to a path that Python build backends can address safely. */
interface StagedPythonRuntimeAssets {
  readonly primeRuntime: string
  readonly dshRuntime: string
  readonly requirementsLock: string
}

interface RuntimeMarker {
  readonly version: number
  readonly pythonVersion: string
  readonly lockDigest: string
  readonly primeRevision: string
  readonly primeRuntimeVersion: string
  readonly bridgeProtocolVersion: number
  readonly platform: string
  readonly architecture: string
}

/** Inputs for custom-interpreter probing or managed environment reuse. */
export interface PythonResolutionOptions {
  readonly python?: string
  readonly managedRuntimeRoot: string
  readonly probeEnvironment: Readonly<Record<string, string>>
}

function executableIn(environment: string): string {
  return process.platform === 'win32'
    ? join(environment, 'Scripts', 'python.exe')
    : join(environment, 'bin', 'python')
}

/**
 * Copy package-owned Python projects out of package-manager store paths before
 * asking a Python build backend to consume them. On Windows, hatchling can
 * misresolve project roots reached through pnpm virtual-store paths containing
 * scoped-package `+` segments and then report that a present `[project]` table
 * is missing. A short RLM-owned staging path also keeps the build independent
 * of symlink and package-manager layout details.
 */
export async function stagePythonRuntimeAssets(
  assets: StagedPythonRuntimeAssets,
  destination: string,
): Promise<StagedPythonRuntimeAssets> {
  const staged = {
    primeRuntime: join(destination, 'upstream-runtime'),
    dshRuntime: join(destination, 'dsh-rlm-runtime'),
    requirementsLock: join(destination, 'managed-requirements.lock'),
  }
  await mkdir(destination, { recursive: true })
  try {
    await Promise.all([
      cp(assets.primeRuntime, staged.primeRuntime, { recursive: true }),
      cp(assets.dshRuntime, staged.dshRuntime, { recursive: true }),
      copyFile(assets.requirementsLock, staged.requirementsLock),
    ])
    return staged
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

async function command(
  program: string,
  arguments_: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(program, [...arguments_], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    const append = (chunk: Buffer): void => {
      if (Buffer.byteLength(output) < provisionOutputLimit) output += chunk.toString()
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise(output)
      else {
        reject(
          new Error(
            `${program} failed (code=${String(code)}, signal=${String(signal)}): ${output.slice(-4096)}`,
          ),
        )
      }
    })
  })
}

async function probe(
  python: string,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const output = await command(
    python,
    [
      '-c',
      'import sys, ipykernel, dill, nest_asyncio, rlm, dsh_rlm_runtime; print(sys.version.split()[0])',
    ],
    { env: { ...environment } },
  )
  const version = output.trim().split(/\s+/u).at(-1)
  if (version === undefined || !/^3\.(?:1[0-9]|[0-9])\./u.test(version)) {
    throw new Error(`Python import probe returned an invalid version: ${output.trim()}`)
  }
  const minor = Number(version.split('.')[1])
  if (minor < 10) throw new Error(`Python ${version} is unsupported; 3.10 or newer is required`)
  return version
}

async function expectedMarker(lockPath: string): Promise<RuntimeMarker> {
  const lockDigest = createHash('sha256')
    .update(await readFile(lockPath))
    .digest('hex')
  return {
    version: runtimeMarkerVersion,
    pythonVersion: '3.11',
    lockDigest,
    primeRevision: PRIME_AGENT_REVISION,
    primeRuntimeVersion: PRIME_RUNTIME_VERSION,
    bridgeProtocolVersion: DSH_RLM_BRIDGE_PROTOCOL_VERSION,
    platform: process.platform,
    architecture: process.arch,
  }
}

function sameMarker(left: RuntimeMarker, right: RuntimeMarker): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Resolve a verified custom Python or an atomically provisioned Python 3.11 environment. */
export async function resolveKernelPython(options: PythonResolutionOptions): Promise<string> {
  if (options.python !== undefined) {
    const absolute = resolve(options.python)
    await access(absolute)
    await probe(absolute, options.probeEnvironment)
    return absolute
  }
  const root = resolve(options.managedRuntimeRoot)
  const existing = provisions.get(root)
  if (existing !== undefined) return existing
  const pending = provision(root, options.probeEnvironment).finally(() => provisions.delete(root))
  provisions.set(root, pending)
  return pending
}

async function provision(
  root: string,
  probeEnvironment: Readonly<Record<string, string>>,
): Promise<string> {
  const assets = await resolvePythonRuntimeAssets()
  const expected = await expectedMarker(assets.requirementsLock)
  const environment = join(root, `python-${expected.pythonVersion}`)
  const markerPath = join(environment, 'runtime.json')
  const python = executableIn(environment)
  try {
    const actual = JSON.parse(await readFile(markerPath, 'utf8')) as RuntimeMarker
    if (sameMarker(actual, expected)) {
      await probe(python, probeEnvironment)
      return python
    }
  } catch {
    // Missing, corrupt, or incomplete environments rebuild below.
  }

  await mkdir(root, { recursive: true })
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new Error(`managedRuntimeRoot is not a directory: ${root}`)
  const temporary = join(root, `.python-${expected.pythonVersion}-${randomUUID()}`)
  const temporarySources = join(root, `.sources-${randomUUID()}`)
  const old = join(root, `.retired-${randomUUID()}`)
  await command('uv', ['venv', '--python', expected.pythonVersion, temporary])
  const temporaryPython = executableIn(temporary)
  try {
    const staged = await stagePythonRuntimeAssets(assets, temporarySources)
    await command('uv', [
      'pip',
      'install',
      '--python',
      temporaryPython,
      '--requirement',
      staged.requirementsLock,
    ])
    await command('uv', [
      'pip',
      'install',
      '--python',
      temporaryPython,
      '--no-deps',
      staged.primeRuntime,
      staged.dshRuntime,
    ])
    await probe(temporaryPython, probeEnvironment)
    await writeFile(join(temporary, 'runtime.json'), `${JSON.stringify(expected, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })

    let retired = false
    try {
      await rename(environment, old)
      retired = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await rename(temporary, environment)
    } catch (error) {
      if (retired) await rename(old, environment)
      throw error
    }
    if (retired) await rm(old, { recursive: true, force: true })
    return executableIn(environment)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  } finally {
    await rm(temporarySources, { recursive: true, force: true })
  }
}

/** Verify a configured root exists as a writable directory without retaining a probe file. */
export async function verifyWritableDirectory(path: string): Promise<string> {
  const absolute = resolve(path)
  await mkdir(absolute, { recursive: true })
  const probe = join(absolute, `.dsh-rlm-write-probe-${randomUUID()}`)
  await writeFile(probe, '', { flag: 'wx', mode: 0o600 })
  await rm(probe)
  return absolute
}

/** Return the parent directory, used by diagnostics without exposing environment values. */
export function runtimeParent(path: string): string {
  return dirname(path)
}
