/** Cordis Service Definition for one persistent RLM kernel per DSH Agent. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'

/** One streamed text fragment from a running IPython cell. */
export interface RlmOutputChunk {
  readonly channel: 'stdout' | 'stderr'
  readonly text: string
}

/** Inputs needed to run one model-visible IPython call. */
export interface RlmExecuteRequest {
  readonly agent: Agent
  readonly callId: ToolCallId
  readonly code: string
  readonly signal: AbortSignal
  /** Opaque enclosing DSH tool execution, used only for policy-preserving nested dispatch. */
  readonly executionToken?: symbol
  readonly onOutput?: (chunk: RlmOutputChunk) => void
}

/** A Python exception returned as an ordinary tool outcome. */
export interface RlmExecutionError {
  readonly name: string
  readonly message: string
  readonly traceback: readonly string[]
}

/** Settled result of one cell. Substrate and caller-contract failures reject instead. */
export interface RlmExecutionResult {
  readonly status: 'ok' | 'error' | 'aborted'
  readonly stdout: string
  readonly stderr: string
  readonly result?: string
  readonly durationMs: number
  readonly generation: number
  readonly kernelRestarted: boolean
  readonly error?: RlmExecutionError
}

/** Public non-secret state of one live kernel. */
export interface RlmKernelInfo {
  readonly sessionId: SessionId
  readonly generation: number
  readonly state: 'starting' | 'idle' | 'busy' | 'disposing'
  readonly python: string
  readonly runtimeVersion: string
}

/** One variable omitted from a best-effort namespace snapshot. */
export interface RlmSnapshotSkip {
  readonly name: string
  readonly reason: string
}

/** Durable facts for one atomically published namespace snapshot. */
export interface RlmSnapshotResult {
  readonly path: string
  readonly manifestPath: string
  readonly digest: string
  readonly bytes: number
  readonly saved: readonly string[]
  readonly skipped: readonly RlmSnapshotSkip[]
  readonly generation: number
}

/** Phases emitted by the provider without exposing cell source or environment values. */
export type RlmKernelLifecyclePhase =
  | 'start'
  | 'ready'
  | 'busy'
  | 'idle'
  | 'interrupt'
  | 'restart'
  | 'snapshot'
  | 'restore'
  | 'stop'

/** Structured Cordis lifecycle payload for one kernel generation. */
export interface RlmKernelLifecycleEvent {
  readonly sessionId: SessionId
  readonly generation: number
  readonly phase: RlmKernelLifecyclePhase
  readonly durationMs?: number
  readonly bytes?: number
  readonly forced?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    rlm: RlmRuntime
  }

  interface Events {
    /** @mode emit */
    'rlm/kernel'(event: RlmKernelLifecycleEvent): void
    /** @mode emit */
    'rlm/output'(event: {
      readonly agent: Agent
      readonly callId: ToolCallId
      readonly chunk: RlmOutputChunk
    }): void
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only identity and runtime metadata for one kernel generation. */
    'rlm/kernel-generation': {
      readonly version: 1
      readonly generation: number
      readonly python: string
      readonly runtimeVersion: string
      readonly reason: 'start' | 'restart'
    }
    /** Log-only snapshot locator and integrity metadata. */
    'rlm/kernel-snapshot': {
      readonly version: 1
      readonly path: string
      readonly manifestPath: string
      readonly digest: string
      readonly bytes: number
      readonly saved: string[]
      readonly skipped: Array<{ name: string; reason: string }>
      readonly generation: number
    }
    /** Log-only result of restoring the authoritative namespace snapshot. */
    'rlm/kernel-restore': {
      readonly version: 1
      readonly digest: string
      readonly restored: string[]
      readonly failed: Array<{ name: string; reason: string }>
      readonly generation: number
    }
    /** Log-only terminal facts for one authenticated Python-to-host request. */
    'rlm/host-request': {
      readonly version: 1
      readonly requestId: string
      readonly requestType: string
      readonly generation: number
      readonly durationMs: number
      readonly status: 'ok' | 'error' | 'aborted'
      readonly errorCode?: string
    }
  }
}

type RlmSessionEventType = Extract<keyof SessionEventMap, `rlm/${string}`>

interface IgnorableEventSession {
  appendIgnorable(type: string, data: unknown): unknown
}

/** Stable failure when DSH cannot safely persist out-of-repository events. */
export class RlmCompatibilityError extends Error {
  readonly code = 'UNSUPPORTED_IGNORABLE_SESSION_EVENTS'

  constructor() {
    super(
      'this DeepSeek Harness build cannot mark downstream session events ignorable; ' +
        'apply patches/deepseek-harness/0003-public-ignorable-session-events.patch',
    )
    this.name = 'RlmCompatibilityError'
  }
}

/**
 * Append a typed RLM event through DSH's public forward-compatible event seam.
 * No unsafe mutation of the immutable event envelope is attempted.
 */
export function appendRlmSessionEvent<T extends RlmSessionEventType>(
  session: Session,
  type: T,
  data: SessionEventMap[T],
): void {
  const append = (session as Session & Partial<IgnorableEventSession>).appendIgnorable
  if (typeof append !== 'function') throw new RlmCompatibilityError()
  append.call(session, type, data)
}

/**
 * Provider-neutral RLM service. Implementations own kernels and Python transport;
 * DSH continues to own models, tools, agents, sessions, policy, and persistence.
 */
export abstract class RlmRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'rlm')
  }

  /** Execute one serialized cell for the exact Agent. */
  abstract execute(request: RlmExecuteRequest): Promise<RlmExecutionResult>

  /** Return live kernel metadata without starting a kernel. */
  abstract info(agent: Agent): RlmKernelInfo | undefined

  /** Best-effort namespace snapshot; absent when no kernel exists. */
  abstract snapshot(agent: Agent, signal?: AbortSignal): Promise<RlmSnapshotResult | undefined>

  /** Stop the current generation and prepare a fresh lazy generation. */
  abstract restart(agent: Agent, signal?: AbortSignal): Promise<void>

  /** Snapshot when possible, then stop all kernel resources for one Agent. */
  abstract disposeAgent(agent: Agent): Promise<void>
}

export default RlmRuntime
