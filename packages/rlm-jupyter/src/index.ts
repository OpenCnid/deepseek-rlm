import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PRIME_RUNTIME_VERSION } from '@deepseek-rlm/dsh-rlm-prime-runtime'
import RlmRuntime, {
  appendRlmSessionEvent,
  type RlmExecuteRequest,
  type RlmExecutionResult,
  type RlmKernelInfo,
  type RlmKernelLifecyclePhase,
  type RlmSnapshotResult,
} from '@deepseek-rlm/dsh-rlm'
import {
  ConfigSchema,
  kernelEnvironment,
  resolveConfig,
  type Config,
  type ResolvedConfig,
} from './config.js'
import { HostBridge } from './host.js'
import { KernelManager } from './kernel.js'
import { resolveKernelPython } from './python.js'
import { applyShellSettings } from './shell.js'
import {
  buildRestoreCode,
  buildSnapshotCode,
  manifestPathIn,
  parseSnapshotCapture,
  parseSnapshotRestore,
  snapshotPathIn,
} from './snapshot.js'

export { ConfigSchema as Config }
export type { Config as JupyterRlmConfig }
export { HostRequestError } from './kernel.js'
export * from './protocol.js'
export * from './snapshot.js'

const runtimeVersion = `dsh-rlm-jupyter/0.1.0-preview.0 prime-runtime/${PRIME_RUNTIME_VERSION}`
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u

interface KernelSlot {
  readonly agent: Agent
  readonly sessionDirectory: string
  readonly lifetime: AbortController
  generation: number
  state: RlmKernelInfo['state']
  python: string | undefined
  kernel: KernelManager | undefined
  startup: Promise<KernelManager> | undefined
  generationLifetime: AbortController | undefined
  activeCalls: number
  restartReason: 'start' | 'restart'
  disposed: boolean
}

interface SnapshotEventData {
  readonly version: 1
  readonly path: string
  readonly manifestPath: string
  readonly digest: string
  readonly bytes: number
  readonly saved: string[]
  readonly skipped: Array<{ name: string; reason: string }>
  readonly generation: number
}

class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(size: number) {
    this.available = size
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.available === 0) {
      await new Promise<void>((resolvePromise) => this.waiters.push(resolvePromise))
    } else {
      this.available -= 1
    }
    try {
      return await operation()
    } finally {
      const waiter = this.waiters.shift()
      if (waiter === undefined) this.available += 1
      else waiter()
    }
  }
}

let providerFence: Promise<void> = Promise.resolve()

function safeSessionDirectory(root: string, agent: Agent): string {
  if (!sessionIdPattern.test(agent.id)) {
    throw new Error(
      `session id cannot be used as an artifact directory: ${JSON.stringify(agent.id)}`,
    )
  }
  const sessions = resolve(root, 'sessions')
  const directory = resolve(sessions, agent.id)
  if (dirname(directory) !== sessions)
    throw new Error('session artifact directory escaped its root')
  return directory
}

function bootstrapCode(): string {
  return `
import asyncio as asyncio
import nest_asyncio as _dsh_nest_asyncio
_dsh_nest_asyncio.apply()
from dsh_rlm_runtime import bootstrap as _dsh_bootstrap
globals().update(_dsh_bootstrap())
import agent_message as agent_message
import dsh_tools as dsh_tools
del _dsh_bootstrap, _dsh_nest_asyncio
`.trim()
}

function eventSnapshot(agent: Agent): SnapshotEventData | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type === 'rlm/kernel-snapshot') return event.data as SnapshotEventData
  }
  return undefined
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/** Persistent Jupyter provider; it never creates or drives a model loop. */
export class JupyterRlmRuntime extends RlmRuntime {
  static inject = ['agents', 'llm', 'subagents']
  static Config = ConfigSchema

  private readonly config: ResolvedConfig
  private readonly slots = new Map<string, KernelSlot>()
  private readonly attached = new WeakSet<Agent>()
  private readonly boots: Semaphore
  private readonly bridge: HostBridge
  private readonly predecessor: Promise<void>
  private readonly releaseFence: () => void
  private disposed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (ctx.subagents.getProvider(this.config.subagentProvider) === undefined) {
      throw new Error(
        `configured subagent provider ${JSON.stringify(this.config.subagentProvider)} is unavailable`,
      )
    }
    if (this.config.adapters.tools && ctx.get('tools') === undefined) {
      throw new Error('RLM adapter tools was enabled but its Cordis service is unavailable')
    }
    for (const adapter of ['goals', 'compaction'] as const) {
      if (this.config.adapters[adapter]) {
        throw new Error(`RLM adapter ${adapter} is not implemented by this release`)
      }
    }
    this.predecessor = providerFence
    let releaseFence = (): void => {}
    providerFence = new Promise<void>((resolvePromise) => {
      releaseFence = resolvePromise
    })
    this.releaseFence = releaseFence
    this.boots = new Semaphore(this.config.maxConcurrentKernelBoots)
    this.bridge = new HostBridge(ctx, this.config)
    for (const agent of ctx.agents.list()) this.attach(agent)
    ctx.on('agent/created', ({ agent }) => this.attach(agent))
    ctx.on('session/event', (session, event) => {
      if ((event as { readonly type: string }).type !== 'compaction/start') return
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) return
      void this.snapshot(agent).catch((error: unknown) => {
        ctx.logger.warn(
          `RLM snapshot requested by compaction failed for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    })
    ctx.effect(
      () => async () => {
        try {
          await this.disposeAll()
        } finally {
          this.releaseFence()
        }
      },
      'rlm.disposeProvider()',
    )
  }

  private attach(agent: Agent): void {
    if (this.attached.has(agent)) return
    this.attached.add(agent)
    agent.ctx.effect(() => () => this.disposeAgent(agent), 'rlm.disposeAgentKernel()')
  }

  private assertAgent(agent: Agent): void {
    if (this.disposed) throw new Error('RLM provider is disposing')
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new Error('RLM operation requires the exact live Agent authority')
    }
  }

  private slot(agent: Agent): KernelSlot {
    this.assertAgent(agent)
    const existing = this.slots.get(agent.id)
    if (existing !== undefined) {
      if (existing.agent !== agent)
        throw new Error('session id is owned by another Agent activation')
      return existing
    }
    const created: KernelSlot = {
      agent,
      sessionDirectory: safeSessionDirectory(this.config.artifactRoot, agent),
      lifetime: new AbortController(),
      generation: 0,
      state: 'starting',
      python: undefined,
      kernel: undefined,
      startup: undefined,
      generationLifetime: undefined,
      activeCalls: 0,
      restartReason: 'start',
      disposed: false,
    }
    this.slots.set(agent.id, created)
    return created
  }

  private emit(
    slot: KernelSlot,
    phase: RlmKernelLifecyclePhase,
    fields: { durationMs?: number; bytes?: number; forced?: boolean } = {},
  ): void {
    this.ctx.emit('rlm/kernel', {
      sessionId: slot.agent.id,
      generation: slot.generation,
      phase,
      ...fields,
    })
  }

  private environment(slot: KernelSlot, python: string): Record<string, string> {
    const environment = kernelEnvironment(this.config)
    const depth = slot.agent.session.header.delegationDepth ?? 0
    Object.assign(environment, {
      RLM_SESSION_DIR: slot.sessionDirectory,
      RLM_DEPTH: String(depth),
      RLM_MAX_DEPTH: String(this.config.maxDepth),
      RLM_HARNESS_STATE_DIR: join(slot.sessionDirectory, 'harness'),
      PYTHONNOUSERSITE: '1',
      JUPYTER_PLATFORM_DIRS: '1',
    })
    const pythonDirectory = dirname(python)
    const executablePaths = [
      ...(this.config.shellPath === undefined ? [] : [dirname(this.config.shellPath)]),
      pythonDirectory,
      ...(process.platform === 'win32' ? [] : ['/usr/local/bin', '/usr/bin', '/bin']),
    ]
    environment.PATH = executablePaths.join(delimiter)
    return environment
  }

  private ensureReady(slot: KernelSlot, signal?: AbortSignal): Promise<KernelManager> {
    if (slot.disposed) return Promise.reject(new Error('RLM agent kernel is disposing'))
    if (slot.kernel?.isRunning === true) return Promise.resolve(slot.kernel)
    if (slot.startup !== undefined) return slot.startup
    slot.generationLifetime?.abort(new Error('RLM kernel generation retired'))
    const generationLifetime = new AbortController()
    slot.generationLifetime = generationLifetime
    const startup = this.startGeneration(slot, generationLifetime, signal).finally(() => {
      if (slot.startup === startup) slot.startup = undefined
    })
    slot.startup = startup
    return startup
  }

  private async startGeneration(
    slot: KernelSlot,
    generationLifetime: AbortController,
    signal?: AbortSignal,
  ): Promise<KernelManager> {
    await this.predecessor
    const startupSignal =
      signal === undefined
        ? AbortSignal.any([slot.lifetime.signal, generationLifetime.signal])
        : AbortSignal.any([signal, slot.lifetime.signal, generationLifetime.signal])
    const abandonGeneration = (): void => {
      generationLifetime.abort(new Error('RLM kernel generation abandoned'))
      if (slot.generationLifetime === generationLifetime) slot.generationLifetime = undefined
    }
    if (this.disposed || slot.disposed || startupSignal.aborted) {
      abandonGeneration()
      throw new Error('RLM provider disposed before kernel startup')
    }
    const previous = slot.kernel
    if (previous !== undefined) {
      slot.kernel = undefined
      await previous.dispose()
    }
    slot.generation += 1
    slot.state = 'starting'
    await mkdir(join(slot.sessionDirectory, 'harness'), { recursive: true, mode: 0o700 })
    const probeEnvironment = kernelEnvironment(this.config)
    let python: string
    try {
      python = await resolveKernelPython({
        ...(this.config.python === undefined ? {} : { python: this.config.python }),
        managedRuntimeRoot: this.config.managedRuntimeRoot,
        probeEnvironment,
      })
    } catch (error) {
      abandonGeneration()
      throw error
    }
    if (this.disposed || slot.disposed || startupSignal.aborted) {
      abandonGeneration()
      throw new Error('RLM provider disposed during kernel provisioning')
    }
    slot.python = python
    const generation = slot.generation
    let kernel!: KernelManager
    kernel = new KernelManager({
      python,
      cwd: slot.sessionDirectory,
      env: this.environment(slot, python),
      sessionId: slot.agent.id,
      generation,
      interruptGraceMs: this.config.interruptGraceMs,
      shutdownGraceMs: this.config.shutdownGraceMs,
      hostRequestDrainMs: this.config.hostRequestDrainMs,
      isGenerationCurrent: () =>
        !this.disposed &&
        !slot.disposed &&
        !generationLifetime.signal.aborted &&
        slot.generation === generation &&
        slot.kernel === kernel,
      dispatchHostRequest: (type, payload, request) =>
        this.bridge.dispatch(slot.agent, type, payload, request),
      onPhase: (phase, fields) => {
        slot.state =
          phase === 'busy'
            ? 'busy'
            : phase === 'stop'
              ? 'disposing'
              : phase === 'start'
                ? 'starting'
                : 'idle'
        this.emit(slot, phase, fields)
      },
    })
    slot.kernel = kernel
    try {
      await this.boots.run(() => kernel.start(startupSignal))
      const bootstrap = await kernel.execute(bootstrapCode(), {
        signal: startupSignal,
        internal: true,
        maxOutputBytes: this.config.maxOutputBytes,
      })
      if (bootstrap.status !== 'ok') {
        throw new Error(
          `kernel bootstrap failed${bootstrap.error?.name === undefined ? '' : ` (${bootstrap.error.name})`}`,
        )
      }
      await this.restore(slot, kernel, startupSignal)
      if (this.disposed || slot.disposed || startupSignal.aborted)
        throw new Error('RLM provider disposed during kernel startup')
      appendRlmSessionEvent(slot.agent.session, 'rlm/kernel-generation', {
        version: 1,
        generation,
        python,
        runtimeVersion,
        reason: slot.restartReason,
      })
      slot.restartReason = 'restart'
      await writeFile(
        join(slot.sessionDirectory, 'runtime.json'),
        `${JSON.stringify({ version: 1, generation, python, runtimeVersion }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      try {
        await chmod(slot.sessionDirectory, 0o700)
      } catch {
        // Windows inherits user ACLs; POSIX mode is best effort.
      }
      slot.state = 'idle'
      return kernel
    } catch (error) {
      if (slot.kernel === kernel) slot.kernel = undefined
      abandonGeneration()
      await kernel.dispose().catch(() => undefined)
      throw error
    }
  }

  private async restore(
    slot: KernelSlot,
    kernel: KernelManager,
    signal?: AbortSignal,
  ): Promise<void> {
    const event = eventSnapshot(slot.agent)
    if (event === undefined) return
    const expectedPayload = snapshotPathIn(slot.sessionDirectory)
    const expectedManifest = manifestPathIn(slot.sessionDirectory)
    let restored: string[] = []
    let failed: Array<{ name: string; reason: string }> = []
    const startedAt = Date.now()
    if (
      resolve(event.path) !== resolve(expectedPayload) ||
      resolve(event.manifestPath) !== resolve(expectedManifest)
    ) {
      failed = [
        {
          name: '*',
          reason: 'authoritative snapshot event points outside this session artifact layout',
        },
      ]
    } else {
      try {
        const manifest = JSON.parse(await readFile(expectedManifest, 'utf8')) as {
          digest?: unknown
        }
        const actual = await digest(expectedPayload)
        if (manifest.digest !== event.digest || actual !== event.digest)
          throw new Error('snapshot digest mismatch')
        const result = await kernel.execute(buildRestoreCode(expectedPayload), {
          ...(signal === undefined ? {} : { signal }),
          internal: true,
          maxOutputBytes: this.config.maxOutputBytes,
        })
        const parsed = parseSnapshotRestore(result.stdout)
        if (parsed === undefined)
          throw new Error('restore helper returned no valid terminal marker')
        restored = parsed.restored
        failed = parsed.failed
      } catch (error) {
        failed = [{ name: '*', reason: error instanceof Error ? error.message : String(error) }]
      }
    }
    appendRlmSessionEvent(slot.agent.session, 'rlm/kernel-restore', {
      version: 1,
      digest: event.digest,
      restored,
      failed,
      generation: slot.generation,
    })
    this.emit(slot, 'restore', { durationMs: Date.now() - startedAt })
  }

  async execute(request: RlmExecuteRequest): Promise<RlmExecutionResult> {
    this.assertAgent(request.agent)
    if (typeof request.code !== 'string') throw new TypeError('RLM code must be a string')
    const slot = this.slot(request.agent)
    const executionSignal = AbortSignal.any([request.signal, slot.lifetime.signal])
    slot.activeCalls += 1
    try {
      const kernel = await this.ensureReady(slot, executionSignal)
      const generation = slot.generation
      const generationSignal = slot.generationLifetime?.signal
      const cellSignal =
        generationSignal === undefined
          ? executionSignal
          : AbortSignal.any([executionSignal, generationSignal])
      const result = await kernel.execute(
        applyShellSettings(request.code, {
          ...this.config,
          requireExplicitShell: process.platform === 'win32',
        }),
        {
          signal: cellSignal,
          maxOutputBytes: this.config.maxOutputBytes,
          callId: request.callId,
          ...(request.executionToken === undefined
            ? {}
            : { executionToken: request.executionToken }),
          onOutput: (channel, text) => request.onOutput?.({ channel, text }),
        },
      )
      if (result.kernelRestarted && slot.kernel === kernel) {
        slot.kernel = undefined
        slot.state = 'starting'
        this.emit(slot, 'restart', { forced: true })
      } else if (
        (this.config.snapshot.policy === 'after-cell' || this.config.snapshot.policy === 'idle') &&
        kernel.isRunning
      ) {
        await this.captureSnapshot(slot, kernel, cellSignal)
      }
      return { ...result, generation }
    } finally {
      slot.activeCalls -= 1
    }
  }

  info(agent: Agent): RlmKernelInfo | undefined {
    this.assertAgent(agent)
    const slot = this.slots.get(agent.id)
    if (slot === undefined || slot.python === undefined) return undefined
    return {
      sessionId: agent.id,
      generation: slot.generation,
      state: slot.state,
      python: slot.python,
      runtimeVersion,
    }
  }

  private async captureSnapshot(
    slot: KernelSlot,
    kernel: KernelManager,
    signal?: AbortSignal,
  ): Promise<RlmSnapshotResult | undefined> {
    if (!kernel.isRunning) return undefined
    const path = snapshotPathIn(slot.sessionDirectory)
    const manifestPath = manifestPathIn(slot.sessionDirectory)
    const startedAt = Date.now()
    const result = await kernel.execute(
      buildSnapshotCode(
        path,
        manifestPath,
        this.config.snapshot.maxBytes,
        this.config.snapshot.maxVariableBytes,
        runtimeVersion,
      ),
      {
        ...(signal === undefined ? {} : { signal }),
        internal: true,
        maxOutputBytes: this.config.maxOutputBytes,
      },
    )
    const parsed = parseSnapshotCapture(result.stdout)
    if (parsed === undefined) return undefined
    const snapshot: RlmSnapshotResult = {
      path,
      manifestPath,
      digest: parsed.digest,
      bytes: parsed.bytes,
      saved: parsed.saved,
      skipped: parsed.skipped,
      generation: slot.generation,
    }
    appendRlmSessionEvent(slot.agent.session, 'rlm/kernel-snapshot', {
      version: 1,
      ...snapshot,
      saved: [...snapshot.saved],
      skipped: snapshot.skipped.map((entry) => ({ ...entry })),
    })
    this.emit(slot, 'snapshot', { durationMs: Date.now() - startedAt, bytes: parsed.bytes })
    return snapshot
  }

  async snapshot(agent: Agent, signal?: AbortSignal): Promise<RlmSnapshotResult | undefined> {
    this.assertAgent(agent)
    const slot = this.slots.get(agent.id)
    if (slot?.kernel === undefined) return undefined
    return await this.captureSnapshot(slot, slot.kernel, signal)
  }

  async restart(agent: Agent, signal?: AbortSignal): Promise<void> {
    this.assertAgent(agent)
    const slot = this.slots.get(agent.id)
    if (slot === undefined) return
    if (signal?.aborted) throw new Error('RLM restart was cancelled')
    if (slot.kernel !== undefined && slot.activeCalls === 0) {
      await this.captureSnapshot(slot, slot.kernel, signal)
    }
    const startup = slot.startup
    slot.generationLifetime?.abort(new Error('RLM kernel restart requested'))
    slot.generationLifetime = undefined
    const kernel = slot.kernel
    slot.kernel = undefined
    slot.state = 'disposing'
    if (startup !== undefined) await startup.catch(() => undefined)
    if (kernel !== undefined) await kernel.dispose()
    slot.state = 'starting'
    this.emit(slot, 'restart')
  }

  async disposeAgent(agent: Agent): Promise<void> {
    const slot = this.slots.get(agent.id)
    if (slot === undefined || slot.agent !== agent) return
    slot.disposed = true
    slot.lifetime.abort(new Error('RLM agent kernel disposed'))
    slot.generationLifetime?.abort(new Error('RLM agent kernel disposed'))
    this.slots.delete(agent.id)
    await this.waitForQuiescentCalls(slot)
    if (slot.kernel !== undefined && slot.activeCalls === 0) {
      await this.captureSnapshot(slot, slot.kernel).catch(() => undefined)
    }
    slot.state = 'disposing'
    const kernel = slot.kernel
    slot.kernel = undefined
    if (kernel !== undefined) await kernel.dispose()
  }

  private async disposeAll(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const slots = [...this.slots.values()]
    this.slots.clear()
    for (const slot of slots) {
      slot.disposed = true
      slot.lifetime.abort(new Error('RLM provider disposed'))
      slot.generationLifetime?.abort(new Error('RLM provider disposed'))
    }
    const settled = await Promise.allSettled(
      slots.map(async (slot) => {
        await this.waitForQuiescentCalls(slot)
        if (slot.kernel !== undefined && slot.activeCalls === 0) {
          await this.captureSnapshot(slot, slot.kernel).catch(() => undefined)
        }
        slot.state = 'disposing'
        await slot.kernel?.dispose()
      }),
    )
    const failures = settled.flatMap((entry) => (entry.status === 'rejected' ? [entry.reason] : []))
    if (failures.length > 0)
      throw new AggregateError(failures, 'one or more RLM kernels failed to dispose')
  }

  /** Give an agent-owned cancellation a bounded opportunity to settle its outer cell before snapshot. */
  private async waitForQuiescentCalls(slot: KernelSlot): Promise<void> {
    const deadline = Date.now() + this.config.shutdownGraceMs
    while (slot.activeCalls > 0 && Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10))
    }
  }
}

export default JupyterRlmRuntime
