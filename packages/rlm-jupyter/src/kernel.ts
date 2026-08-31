/**
 * Persistent Jupyter transport adapted from Prime Agent at
 * f8f0036cc2da1a640aad990ae8dcb7c4820ce32e. This version is owned by a DSH
 * service provider and adds verified inbound HMAC, generation fencing,
 * request cancellation, configurable lifecycle bounds, and whole-tree cleanup.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Dealer, Subscriber } from 'zeromq'
import { ByteAccumulator, ByteBudget } from './byte-buffer.js'
import {
  createConnectionInfo,
  createMessage,
  decodeMessage,
  encodeMessage,
  isRecord,
  parseConnectionInfo,
  type JupyterConnectionInfo,
  type JupyterMessage,
} from './protocol.js'

export const HOST_REQUEST_TARGET = 'host.request'
const startupTimeoutMs = 15_000
const subscribeDelayMs = 75
const diagnosticTailBytes = 64 * 1024

/** Stable coded failure returned to the Python shim. */
export class HostRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'HostRequestError'
  }
}

/** Authority and cancellation supplied to one authenticated comm request. */
export interface KernelHostRequestContext {
  readonly requestId: string
  readonly generation: number
  readonly signal: AbortSignal
  readonly execution:
    | {
        readonly callId: string
        readonly token?: symbol
        readonly signal: AbortSignal
        readonly isOpen: () => boolean
        readonly nextNestedCallSequence: () => number
      }
    | undefined
  isCurrent(): boolean
}

/** Host dispatcher. Payload excludes the request's routing `type` field. */
export type KernelHostRequestDispatcher = (
  type: string,
  payload: Readonly<Record<string, unknown>>,
  context: KernelHostRequestContext,
) => Promise<Readonly<Record<string, unknown>>>

/** Inputs for one ordinary or provider-internal cell. */
export interface KernelExecuteOptions {
  readonly signal?: AbortSignal
  readonly maxOutputBytes: number
  readonly internal?: boolean
  readonly callId?: string
  readonly executionToken?: symbol
  readonly onOutput?: (channel: 'stdout' | 'stderr', text: string) => void
}

/** Raw settled cell result before the RLM service adds generation metadata. */
export interface KernelExecutionResult {
  readonly status: 'ok' | 'error' | 'aborted'
  readonly stdout: string
  readonly stderr: string
  readonly result?: string
  readonly durationMs: number
  readonly kernelRestarted: boolean
  readonly error?: {
    readonly name: string
    readonly message: string
    readonly traceback: readonly string[]
  }
}

/** Configuration already resolved and validated by the Cordis provider. */
export interface KernelManagerOptions {
  readonly python: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly sessionId: string
  readonly generation: number
  readonly interruptGraceMs: number
  readonly shutdownGraceMs: number
  readonly hostRequestDrainMs: number
  readonly dispatchHostRequest: KernelHostRequestDispatcher
  readonly isGenerationCurrent: () => boolean
  readonly onPhase: (
    phase: 'start' | 'ready' | 'busy' | 'idle' | 'interrupt' | 'stop',
    fields?: { durationMs?: number; forced?: boolean },
  ) => void
}

interface ActiveExecution {
  readonly requestId: string
  readonly startedAt: number
  readonly stdout: ByteAccumulator
  readonly stderr: ByteAccumulator
  readonly outputBudget: ByteBudget
  readonly options: KernelExecuteOptions
  resolve: (result: KernelExecutionResult) => void
  reject: (error: Error) => void
  result?: string
  error?: KernelExecutionResult['error']
  status: KernelExecutionResult['status']
  settled: boolean
  open: boolean
  restartForced: boolean
  nestedCallCount: number
}

interface RequestTask {
  readonly controller: AbortController
  readonly task: Promise<void>
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function parentMessageId(message: JupyterMessage): string | undefined {
  return typeof message.parent_header.msg_id === 'string' ? message.parent_header.msg_id : undefined
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    const onExit = (): void => finish(true)
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    child.once('exit', onExit)
  })
}

async function forceKillTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', () => resolve())
      killer.once('exit', () => resolve())
    })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The complete tree already exited.
      }
    }
  }
  await waitForExit(child, 2_000)
}

/** One kernel generation. A retired instance is never restarted in place. */
export class KernelManager {
  private readonly wireSession = randomUUID()
  private readonly generationAbort = new AbortController()
  private readonly commTargets = new Map<string, string>()
  private readonly handledComms = new Set<string>()
  private readonly requestTasks = new Set<RequestTask>()
  private process: ChildProcess | undefined
  private connection: JupyterConnectionInfo | undefined
  private connectionDirectory: string | undefined
  private shell: Dealer | undefined
  private iopub: Subscriber | undefined
  private control: Dealer | undefined
  private iopubPump: Promise<void> | undefined
  private startup: Promise<void> | undefined
  private executionTail: Promise<void> = Promise.resolve()
  private active: ActiveExecution | undefined
  private diagnostics = new ByteAccumulator(diagnosticTailBytes)
  private state: 'new' | 'starting' | 'running' | 'disposing' | 'retired' = 'new'

  constructor(private readonly options: KernelManagerOptions) {}

  get isRunning(): boolean {
    return this.state === 'running'
  }

  get connectionPath(): string | undefined {
    return this.connectionDirectory === undefined
      ? undefined
      : join(this.connectionDirectory, 'connection.json')
  }

  /** Start transport once; a failed startup can be retried only by a new generation. */
  start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('kernel startup aborted'))
    this.startup ??= this.startInner().catch((error: unknown) => {
      this.startup = undefined
      throw error
    })
    return raceAbort(this.startup, signal, 'kernel startup aborted')
  }

  private async startInner(): Promise<void> {
    if (this.state === 'running') return
    if (this.state !== 'new') throw new Error(`kernel generation is ${this.state}`)
    this.state = 'starting'
    const startedAt = Date.now()
    this.options.onPhase('start')

    const directory = await mkdtemp(join(tmpdir(), 'dsh-rlm-kernel-'))
    this.connectionDirectory = directory
    try {
      await chmod(directory, 0o700)
    } catch {
      // Windows ACLs are inherited; POSIX mode is best effort.
    }
    const connectionPath = join(directory, 'connection.json')
    await writeFile(connectionPath, JSON.stringify(createConnectionInfo(), null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })

    const child = spawn(this.options.python, ['-m', 'ipykernel_launcher', '-f', connectionPath], {
      cwd: this.options.cwd,
      env: { ...this.options.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    this.process = child
    child.stderr?.on('data', (chunk: Buffer) => {
      this.diagnostics.append(chunk.toString())
    })
    child.once('error', (error) => this.handleProcessFailure(error))
    child.once('exit', (code, signal) => {
      if (this.state !== 'disposing' && this.state !== 'retired') {
        this.handleProcessFailure(
          new Error(`kernel exited unexpectedly (code=${String(code)}, signal=${String(signal)})`),
        )
      }
    })

    try {
      this.connection = await this.waitForConnection(connectionPath, child)
      const connection = this.connection
      this.shell = new Dealer()
      this.iopub = new Subscriber()
      this.control = new Dealer()
      this.shell.connect(`tcp://${connection.ip}:${connection.shell_port}`)
      this.iopub.connect(`tcp://${connection.ip}:${connection.iopub_port}`)
      this.control.connect(`tcp://${connection.ip}:${connection.control_port}`)
      this.iopub.subscribe('')
      await delay(subscribeDelayMs)
      this.startIopubPump()
      await this.probeReady()
      if (!this.options.isGenerationCurrent())
        throw new Error('kernel generation retired during startup')
      this.state = 'running'
      this.options.onPhase('ready', { durationMs: Date.now() - startedAt })
    } catch (error) {
      await this.retire(true)
      throw error
    }
  }

  private async waitForConnection(
    path: string,
    child: ChildProcess,
  ): Promise<JupyterConnectionInfo> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < startupTimeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`kernel exited before selecting ports: ${this.diagnostics.render()}`)
      }
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as unknown
        const parsed = parseConnectionInfo(value)
        if (parsed !== undefined) return parsed
      } catch {
        // The kernel rewrites this file while ports are being selected.
      }
      await delay(25)
    }
    throw new Error(
      `kernel did not select ports within ${startupTimeoutMs}ms: ${this.diagnostics.render()}`,
    )
  }

  private async probeReady(): Promise<void> {
    const shell = this.shell
    const connection = this.connection
    if (shell === undefined || connection === undefined)
      throw new Error('kernel channels are absent')
    const request = createMessage('kernel_info_request', {}, this.wireSession)
    await shell.send(encodeMessage(request, connection.key))
    const deadline = Date.now() + startupTimeoutMs
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const received = await Promise.race([
        shell.receive().then((frames) => ({ kind: 'frames' as const, frames })),
        delay(remaining).then(() => ({ kind: 'timeout' as const })),
      ])
      if (received.kind === 'timeout') break
      const reply = decodeMessage(received.frames, connection.key)
      if (
        reply?.header.msg_type === 'kernel_info_reply' &&
        parentMessageId(reply) === request.header.msg_id
      ) {
        return
      }
    }
    throw new Error(`kernel readiness probe timed out: ${this.diagnostics.render()}`)
  }

  /** Serialize one cell behind every earlier cell in this generation. */
  async execute(code: string, options: KernelExecuteOptions): Promise<KernelExecutionResult> {
    if (typeof code !== 'string') throw new TypeError('kernel code must be a string')
    if (options.signal?.aborted) return abortedResult(0, false)
    await this.start(options.signal)
    const previous = this.executionTail
    let release = (): void => {}
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      if (options.signal?.aborted) return abortedResult(0, false)
      if (this.state !== 'running') throw new Error('kernel generation is not running')
      return await this.executeNow(code, options)
    } finally {
      release()
    }
  }

  private executeNow(code: string, options: KernelExecuteOptions): Promise<KernelExecutionResult> {
    const shell = this.shell
    const connection = this.connection
    if (shell === undefined || connection === undefined) {
      return Promise.reject(new Error('kernel shell channel is absent'))
    }
    if (this.active !== undefined)
      return Promise.reject(new Error('kernel already has an active cell'))
    const startedAt = Date.now()
    const message = createMessage(
      'execute_request',
      {
        code,
        silent: false,
        store_history: !options.internal,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      },
      this.wireSession,
    )

    return new Promise<KernelExecutionResult>((resolve, reject) => {
      const outputBudget = new ByteBudget(options.maxOutputBytes)
      const execution: ActiveExecution = {
        requestId: message.header.msg_id,
        startedAt,
        stdout: new ByteAccumulator(outputBudget),
        stderr: new ByteAccumulator(outputBudget),
        outputBudget,
        options,
        resolve,
        reject,
        status: 'ok',
        settled: false,
        open: true,
        restartForced: false,
        nestedCallCount: 0,
      }
      this.active = execution
      this.options.onPhase('busy')
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        execution.status = 'aborted'
        this.options.onPhase('interrupt')
        void this.interrupt()
        forceTimer = setTimeout(() => {
          if (this.active !== execution) return
          execution.restartForced = true
          execution.open = false
          this.active = undefined
          this.finishExecution(execution)
          void this.retire(true)
        }, this.options.interruptGraceMs)
        forceTimer.unref?.()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
      void shell.send(encodeMessage(message, connection.key)).catch((error: unknown) => {
        if (this.active === execution) {
          this.active = undefined
          execution.open = false
          execution.reject(asError(error))
        }
      })
      const originalResolve = execution.resolve
      const originalReject = execution.reject
      execution.resolve = (result): void => {
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        options.signal?.removeEventListener('abort', onAbort)
        originalResolve(result)
      }
      execution.reject = (error): void => {
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        options.signal?.removeEventListener('abort', onAbort)
        originalReject(error)
      }
    })
  }

  private startIopubPump(): void {
    this.iopubPump ??= this.runIopubPump()
  }

  private async runIopubPump(): Promise<void> {
    const iopub = this.iopub
    const connection = this.connection
    if (iopub === undefined || connection === undefined) return
    try {
      for await (const frames of iopub) {
        const message = decodeMessage(frames, connection.key)
        if (message === undefined) {
          this.diagnostics.append('[kernel] rejected unauthenticated or malformed IOPub message\n')
          continue
        }
        const type = message.header.msg_type
        if (type === 'comm_open' || type === 'comm_msg' || type === 'comm_close') {
          this.handleComm(message)
          continue
        }
        this.handleExecutionMessage(message)
      }
    } catch (error) {
      if (this.state !== 'disposing' && this.state !== 'retired')
        this.handleProcessFailure(asError(error))
    }
  }

  private handleExecutionMessage(message: JupyterMessage): void {
    const execution = this.active
    if (execution === undefined || parentMessageId(message) !== execution.requestId) return
    const type = message.header.msg_type
    if (type === 'stream') {
      const channel = message.content.name
      const text = message.content.text
      if ((channel !== 'stdout' && channel !== 'stderr') || typeof text !== 'string') return
      const accepted = execution[channel].append(text)
      if (accepted.length > 0) execution.options.onOutput?.(channel, accepted)
      return
    }
    if (type === 'execute_result') {
      const data = message.content.data
      if (isRecord(data) && typeof data['text/plain'] === 'string') {
        const result = new ByteAccumulator(execution.outputBudget)
        result.append(data['text/plain'])
        const rendered = result.render()
        if (rendered.length > 0) execution.result = rendered
      }
      return
    }
    if (type === 'error') {
      if (
        typeof message.content.ename === 'string' &&
        typeof message.content.evalue === 'string' &&
        Array.isArray(message.content.traceback)
      ) {
        const name = new ByteAccumulator(256)
        name.append(message.content.ename)
        const errorMessage = new ByteAccumulator(execution.outputBudget)
        const acceptedMessage = errorMessage.append(message.content.evalue)
        const traceback: string[] = []
        if (acceptedMessage === message.content.evalue) {
          for (const line of message.content.traceback) {
            if (typeof line !== 'string') continue
            const output = new ByteAccumulator(execution.outputBudget)
            const accepted = output.append(line)
            const rendered = output.render()
            if (rendered.length > 0) traceback.push(rendered)
            if (accepted !== line) break
          }
        }
        execution.error = {
          name: name.render(),
          message: errorMessage.render(),
          traceback,
        }
        execution.status = 'error'
      }
      return
    }
    if (
      type === 'status' &&
      message.content.execution_state === 'idle' &&
      this.active === execution
    ) {
      execution.open = false
      this.active = undefined
      this.finishExecution(execution)
    }
  }

  private finishExecution(execution: ActiveExecution): void {
    if (execution.settled) return
    execution.settled = true
    if (execution.options.signal?.aborted) execution.status = 'aborted'
    this.options.onPhase('idle')
    execution.resolve({
      status: execution.status,
      stdout: execution.stdout.render(),
      stderr: execution.stderr.render(),
      ...(execution.result === undefined ? {} : { result: execution.result }),
      durationMs: Date.now() - execution.startedAt,
      kernelRestarted: execution.restartForced,
      ...(execution.error === undefined ? {} : { error: execution.error }),
    })
  }

  private handleComm(message: JupyterMessage): void {
    const commId = message.content.comm_id
    if (typeof commId !== 'string' || commId.length === 0) return
    if (message.header.msg_type === 'comm_close') {
      this.commTargets.delete(commId)
      return
    }
    if (message.header.msg_type === 'comm_open') {
      const target = message.content.target_name
      if (typeof target !== 'string') return
      this.commTargets.set(commId, target)
      if (target === HOST_REQUEST_TARGET) this.startHostRequest(commId, message.content.data)
      return
    }
    if (
      message.header.msg_type === 'comm_msg' &&
      this.commTargets.get(commId) === HOST_REQUEST_TARGET
    ) {
      this.startHostRequest(commId, message.content.data)
    }
  }

  private startHostRequest(commId: string, data: unknown): void {
    if (this.handledComms.has(commId)) return
    this.handledComms.add(commId)
    const controller = new AbortController()
    const active = this.active
    const signals = [controller.signal, this.generationAbort.signal]
    if (active?.options.signal !== undefined) signals.push(active.options.signal)
    const signal = AbortSignal.any(signals)
    const context: KernelHostRequestContext = {
      requestId: randomUUID(),
      generation: this.options.generation,
      signal,
      execution:
        active?.options.callId === undefined
          ? undefined
          : {
              callId: active.options.callId,
              ...(active.options.executionToken === undefined
                ? {}
                : { token: active.options.executionToken }),
              signal: active.options.signal ?? this.generationAbort.signal,
              isOpen: () => active.open,
              nextNestedCallSequence: () => {
                active.nestedCallCount += 1
                return active.nestedCallCount
              },
            },
      isCurrent: () =>
        !signal.aborted &&
        this.state !== 'disposing' &&
        this.state !== 'retired' &&
        this.options.isGenerationCurrent(),
    }
    const task = this.dispatchAndReply(commId, data, context)
    const tracked: RequestTask = { controller, task }
    this.requestTasks.add(tracked)
    void task.finally(() => this.requestTasks.delete(tracked))
  }

  private async dispatchAndReply(
    commId: string,
    data: unknown,
    context: KernelHostRequestContext,
  ): Promise<void> {
    let reply: Readonly<Record<string, unknown>>
    try {
      if (!isRecord(data))
        throw new HostRequestError('host request must be an object', 'INVALID_REQUEST')
      const type = data.type
      if (typeof type !== 'string' || type.length === 0) {
        throw new HostRequestError(
          'host request type must be a non-empty string',
          'INVALID_REQUEST',
        )
      }
      const { type: _type, ...payload } = data
      const result = await this.options.dispatchHostRequest(type, payload, context)
      if (!context.isCurrent())
        throw new HostRequestError('kernel generation is stale', 'STALE_GENERATION')
      reply = { status: 'ok', ...result }
    } catch (error) {
      const failure = asError(error)
      reply = {
        status: 'error',
        error: failure.message,
        code: failure instanceof HostRequestError ? failure.code : 'HOST_REQUEST_FAILED',
      }
    }
    try {
      await this.sendCommReply(commId, reply)
    } catch (error) {
      this.diagnostics.append(`[kernel] host reply failed: ${asError(error).message}\n`)
    }
  }

  private async sendCommReply(
    commId: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const channel = this.control
    const connection = this.connection
    if (channel === undefined || connection === undefined) {
      throw new Error('kernel control channel is absent')
    }
    const message = createMessage('comm_msg', { comm_id: commId, data }, this.wireSession)
    await channel.send(encodeMessage(message, connection.key))
  }

  private async interrupt(): Promise<void> {
    if (this.control === undefined || this.connection === undefined) return
    const message = createMessage('interrupt_request', {}, this.wireSession)
    await this.control.send(encodeMessage(message, this.connection.key))
  }

  private handleProcessFailure(error: Error): void {
    this.diagnostics.append(`[kernel] ${error.message}\n`)
    const active = this.active
    this.active = undefined
    if (active !== undefined && !active.settled) {
      active.open = false
      active.reject(error)
    }
    this.generationAbort.abort(error)
    this.state = 'retired'
    this.closeChannels()
  }

  /** Abort host requests, drain them for a bound, then stop the complete process tree. */
  async dispose(): Promise<void> {
    if (this.state === 'retired') {
      await this.removeConnectionDirectory()
      return
    }
    this.state = 'disposing'
    this.generationAbort.abort(new Error('kernel generation disposed'))
    for (const request of this.requestTasks) request.controller.abort()
    const active = this.active
    if (active !== undefined && !active.settled) {
      this.active = undefined
      active.open = false
      active.status = 'aborted'
      active.restartForced = true
      this.finishExecution(active)
    }
    await boundedDrain(
      [...this.requestTasks].map((request) => request.task),
      this.options.hostRequestDrainMs,
    )
    await this.gracefulShutdown()
  }

  private async gracefulShutdown(): Promise<void> {
    const child = this.process
    if (this.control !== undefined && this.connection !== undefined) {
      try {
        const message = createMessage('shutdown_request', { restart: false }, this.wireSession)
        await this.control.send(encodeMessage(message, this.connection.key))
      } catch {
        // Forced tree cleanup below remains authoritative.
      }
    }
    let forced = false
    if (child !== undefined && !(await waitForExit(child, this.options.shutdownGraceMs))) {
      forced = true
      await forceKillTree(child)
    }
    this.state = 'retired'
    this.closeChannels()
    await this.removeConnectionDirectory()
    this.options.onPhase('stop', { forced })
  }

  private async retire(forced: boolean): Promise<void> {
    if (this.state === 'retired') return
    this.state = 'retired'
    this.generationAbort.abort(new Error('kernel generation retired'))
    for (const request of this.requestTasks) request.controller.abort()
    const child = this.process
    if (child !== undefined) await forceKillTree(child)
    this.closeChannels()
    await this.removeConnectionDirectory()
    this.options.onPhase('stop', { forced })
  }

  private closeChannels(): void {
    this.shell?.close()
    this.iopub?.close()
    this.control?.close()
    this.shell = undefined
    this.iopub = undefined
    this.control = undefined
    this.iopubPump = undefined
    this.connection = undefined
  }

  private async removeConnectionDirectory(): Promise<void> {
    const directory = this.connectionDirectory
    this.connectionDirectory = undefined
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
}

function abortedResult(durationMs: number, restarted: boolean): KernelExecutionResult {
  return {
    status: 'aborted',
    stdout: '',
    stderr: '',
    durationMs,
    kernelRestarted: restarted,
  }
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) throw new Error(message)
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => finish(() => reject(new Error(message)))
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      action()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

async function boundedDrain(tasks: readonly Promise<void>[], timeoutMs: number): Promise<void> {
  if (tasks.length === 0) return
  await Promise.race([
    Promise.allSettled(tasks).then(() => undefined),
    delay(timeoutMs).then(() => undefined),
  ])
}
