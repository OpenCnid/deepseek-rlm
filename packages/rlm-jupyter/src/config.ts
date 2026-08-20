import { accessSync, closeSync, constants, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

export interface Config {
  python?: string
  artifactRoot?: string
  managedRuntimeRoot?: string
  subagentProvider?: string
  maxDepth?: number
  maxConcurrentKernelBoots?: number
  interruptGraceMs?: number
  shutdownGraceMs?: number
  hostRequestDrainMs?: number
  maxOutputBytes?: number
  envAllowlist?: string[]
  env?: Record<string, string>
  shellPath?: string
  commandPrefix?: string
  snapshot?: {
    policy?: 'after-cell' | 'idle' | 'dispose'
    maxBytes?: number
    maxVariableBytes?: number
  }
  adapters?: {
    tools?: boolean
    goals?: boolean
    compaction?: boolean
  }
}

export interface ResolvedConfig {
  readonly python?: string
  readonly artifactRoot: string
  readonly managedRuntimeRoot: string
  readonly subagentProvider: string
  readonly maxDepth: number
  readonly maxConcurrentKernelBoots: number
  readonly interruptGraceMs: number
  readonly shutdownGraceMs: number
  readonly hostRequestDrainMs: number
  readonly maxOutputBytes: number
  readonly envAllowlist: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly shellPath?: string
  readonly commandPrefix?: string
  readonly snapshot: {
    readonly policy: 'after-cell' | 'idle' | 'dispose'
    readonly maxBytes: number
    readonly maxVariableBytes: number
  }
  readonly adapters: {
    readonly tools: boolean
    readonly goals: boolean
    readonly compaction: boolean
  }
}

export const ConfigSchema: z<Config> = z.object({
  python: z.string(),
  artifactRoot: z.string(),
  managedRuntimeRoot: z.string(),
  subagentProvider: z.string().default('rlm-spawn'),
  maxDepth: z.natural().default(1),
  maxConcurrentKernelBoots: z.natural().min(1).default(4),
  interruptGraceMs: z.natural().min(1).default(2_000),
  shutdownGraceMs: z.natural().min(1).default(5_000),
  hostRequestDrainMs: z.natural().min(1).default(5_000),
  maxOutputBytes: z
    .natural()
    .min(1)
    .default(4 * 1024 * 1024),
  envAllowlist: z.array(String).default([]),
  env: z.dict(String).default({}),
  shellPath: z.string(),
  commandPrefix: z.string(),
  snapshot: z
    .object({
      policy: z.union(['after-cell', 'idle', 'dispose'] as const).default('after-cell'),
      maxBytes: z
        .natural()
        .min(1)
        .default(256 * 1024 * 1024),
      maxVariableBytes: z
        .natural()
        .min(1)
        .default(16 * 1024 * 1024),
    })
    .default({
      policy: 'after-cell',
      maxBytes: 256 * 1024 * 1024,
      maxVariableBytes: 16 * 1024 * 1024,
    }),
  adapters: z
    .object({
      tools: z.boolean().default(false),
      goals: z.boolean().default(false),
      compaction: z.boolean().default(false),
    })
    .default({ tools: false, goals: false, compaction: false }),
})

const ownedEnvironment = new Set([
  'RLM_SESSION_DIR',
  'RLM_DEPTH',
  'RLM_MAX_DEPTH',
  'RLM_HARNESS_STATE_DIR',
  'RLM_GLOBAL_HARNESS_STATE_DIR',
  'PYTHONPATH',
  'PYTHONNOUSERSITE',
  'JUPYTER_PLATFORM_DIRS',
  'PATH',
])

function positiveSafeInteger(value: number, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}`)
  }
  return value
}

function normalized(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty normalized string`)
  }
  return value
}

function configuredAbsolutePath(
  value: string | undefined,
  fallback: string,
  label: string,
): string {
  if (value !== undefined && !isAbsolute(value))
    throw new Error(`${label} must be an absolute path`)
  return value ?? resolve(fallback)
}

function optionalExecutable(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  const absolute = resolve(value)
  try {
    accessSync(absolute, constants.X_OK)
  } catch (error) {
    throw new Error(`${label} is not executable: ${absolute}`, { cause: error })
  }
  return absolute
}

function verifyWritableRoot(path: string, label: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const probe = resolve(path, `.dsh-rlm-write-${process.pid}-${Date.now()}`)
  try {
    const descriptor = openSync(
      probe,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    closeSync(descriptor)
  } catch (error) {
    throw new Error(`${label} is not writable: ${path}`, { cause: error })
  } finally {
    try {
      unlinkSync(probe)
    } catch {
      // A failed create has nothing to remove.
    }
  }
}

/** Resolve defaults and enforce constraints that Schemastery cannot express. */
export function resolveConfig(input: Config = {}): ResolvedConfig {
  const artifactRoot = configuredAbsolutePath(
    input.artifactRoot,
    '.dsh-rlm/artifacts',
    'artifactRoot',
  )
  const managedRuntimeRoot = configuredAbsolutePath(
    input.managedRuntimeRoot,
    '.dsh-rlm/runtime',
    'managedRuntimeRoot',
  )
  const envAllowlist = input.envAllowlist ?? []
  const seen = new Set<string>()
  for (const name of envAllowlist) {
    normalized(name, 'envAllowlist entry')
    if (name.includes('=')) throw new Error(`envAllowlist entry must not contain '=': ${name}`)
    if (seen.has(name)) throw new Error(`duplicate envAllowlist entry: ${name}`)
    if (ownedEnvironment.has(name))
      throw new Error(`envAllowlist cannot override RLM-owned ${name}`)
    seen.add(name)
  }
  const environment = input.env ?? {}
  for (const [name, value] of Object.entries(environment)) {
    normalized(name, 'env key')
    if (typeof value !== 'string') throw new Error(`env value for ${name} must be a string`)
    if (ownedEnvironment.has(name)) throw new Error(`env cannot override RLM-owned ${name}`)
  }
  const snapshot = {
    policy: input.snapshot?.policy ?? ('after-cell' as const),
    maxBytes: positiveSafeInteger(
      input.snapshot?.maxBytes ?? 256 * 1024 * 1024,
      'snapshot.maxBytes',
    ),
    maxVariableBytes: positiveSafeInteger(
      input.snapshot?.maxVariableBytes ?? 16 * 1024 * 1024,
      'snapshot.maxVariableBytes',
    ),
  }
  if (snapshot.maxVariableBytes > snapshot.maxBytes) {
    throw new Error('snapshot.maxVariableBytes must not exceed snapshot.maxBytes')
  }
  if (!['after-cell', 'idle', 'dispose'].includes(snapshot.policy)) {
    throw new Error(`unsupported snapshot policy: ${String(snapshot.policy)}`)
  }
  const maxDepth = positiveSafeInteger(input.maxDepth ?? 1, 'maxDepth', 0)
  verifyWritableRoot(artifactRoot, 'artifactRoot')
  verifyWritableRoot(managedRuntimeRoot, 'managedRuntimeRoot')
  const optional = <T>(value: T | undefined): { value?: T } =>
    value === undefined ? {} : { value }
  const pythonValue = optional(optionalExecutable(input.python, 'python'))
  const shellValue = optional(optionalExecutable(input.shellPath, 'shellPath'))
  const prefixValue = optional(input.commandPrefix)
  return {
    ...(pythonValue.value === undefined ? {} : { python: normalized(pythonValue.value, 'python') }),
    artifactRoot,
    managedRuntimeRoot,
    subagentProvider: normalized(input.subagentProvider ?? 'rlm-spawn', 'subagentProvider'),
    maxDepth,
    maxConcurrentKernelBoots: positiveSafeInteger(
      input.maxConcurrentKernelBoots ?? 4,
      'maxConcurrentKernelBoots',
    ),
    interruptGraceMs: positiveSafeInteger(input.interruptGraceMs ?? 2_000, 'interruptGraceMs'),
    shutdownGraceMs: positiveSafeInteger(input.shutdownGraceMs ?? 5_000, 'shutdownGraceMs'),
    hostRequestDrainMs: positiveSafeInteger(
      input.hostRequestDrainMs ?? 5_000,
      'hostRequestDrainMs',
    ),
    maxOutputBytes: positiveSafeInteger(input.maxOutputBytes ?? 4 * 1024 * 1024, 'maxOutputBytes'),
    envAllowlist: [...envAllowlist],
    env: { ...environment },
    ...(shellValue.value === undefined
      ? {}
      : { shellPath: normalized(shellValue.value, 'shellPath') }),
    ...(prefixValue.value === undefined
      ? {}
      : { commandPrefix: normalized(prefixValue.value, 'commandPrefix') }),
    snapshot,
    adapters: {
      tools: input.adapters?.tools ?? false,
      goals: input.adapters?.goals ?? false,
      compaction: input.adapters?.compaction ?? false,
    },
  }
}

/** A kernel receives no ambient environment unless a deployment allowlists it. */
export function kernelEnvironment(config: ResolvedConfig): Record<string, string> {
  const environment: Record<string, string> = { ...config.env }
  for (const name of config.envAllowlist) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}
