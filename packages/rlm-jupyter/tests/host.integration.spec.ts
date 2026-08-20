import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type SessionPreparation,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionPersistence, {
  PersistenceCoordinator,
  SessionPersistenceRevision,
  type SessionInspection,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { HostBridge } from '../src/host.js'
import type { KernelHostRequestContext } from '../src/kernel.js'

const contexts: Context[] = []
const roots: string[] = []

// The pinned DSH rc.7 build uses the ES2024 helper despite advertising the
// spec's Node 20 floor. Keep this compatibility oracle local to the test; the
// upstream compatibility finding is documented rather than hidden in runtime code.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }
}

// The full bundle requires patch 0003. This compatibility-oracle test runs
// against the pristine pin, so add only the missing public method and delegate
// to rc.7's ordinary typed append; production code has no such fallback.
const sessionPrototype = Session.prototype as Session & {
  appendIgnorable?: (type: string, data: unknown) => unknown
}
if (typeof sessionPrototype.appendIgnorable !== 'function') {
  sessionPrototype.appendIgnorable = function appendIgnorable(
    type: string,
    data: unknown,
  ): unknown {
    return (this.append as (eventType: string, eventData: unknown) => unknown)(type, data)
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class LocalAdapter extends LlmAdapter {
  private releaseFirst!: () => void
  private firstGate = new Promise<void>((resolve) => {
    this.releaseFirst = resolve
  })
  private requests = 0

  release(): void {
    this.releaseFirst()
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'local', name: 'Local scripted model' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Local scripted model',
      reasoning: { efforts: [{ id: 'low' as never, name: 'Low' }] },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.requests === 1) await this.firstGate
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'READY' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'READY' } }
    yield { type: 'finish', reason: 'stop' }
  }
}

class BlockingAdapter extends LlmAdapter {
  private releaseAll!: () => void
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseAll = resolve
  })

  release(): void {
    this.releaseAll()
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'local', name: 'Local blocking model' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: 'Local blocking model' })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.gate
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'DONE' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DONE' } }
    yield { type: 'finish', reason: 'stop' }
  }
}

/** Node-20-safe in-memory persistence seam for the real continuation manager. */
class MemoryPersistence extends SessionPersistence {
  static inject = ['sessions']
  readonly supportsRawArtifacts = false
  override readonly name = 'memory-persistence'
  private readonly records = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
  private readonly coordinator: PersistenceCoordinator<void>

  constructor(ctx: Context) {
    super(ctx)
    this.coordinator = new PersistenceCoordinator(ctx, this, {
      preparedSessionCacheSize: 2,
      writeBatchMaxDelayMs: 1,
    })
  }

  locate(): undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  list(): Promise<SessionHeader[]> {
    return Promise.resolve([...this.records.values()].map((record) => structuredClone(record.meta)))
  }

  listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    return Promise.resolve(
      [...this.records.values()].map((record) => ({
        header: structuredClone(record.meta),
        revision: this.revision(record.meta.id, record.events.length),
      })),
    )
  }

  loadStored(id: SessionId): Promise<StoredPrefix<void> | undefined> {
    const record = this.records.get(id)
    if (record === undefined) return Promise.resolve(undefined)
    return Promise.resolve({
      meta: structuredClone(record.meta),
      events: structuredClone(record.events),
      revision: this.revision(id, record.events.length),
    })
  }

  readStoredRevision(
    id: SessionId,
  ): Promise<ReturnType<typeof SessionPersistenceRevision> | undefined> {
    const record = this.records.get(id)
    return Promise.resolve(
      record === undefined ? undefined : this.revision(id, record.events.length),
    )
  }

  appendBatch(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const current = this.records.get(meta.id) ?? { meta: structuredClone(meta), events: [] }
    if (events[0]?.seq !== current.events.length) throw new Error('non-contiguous memory append')
    current.events.push(...structuredClone(events))
    this.records.set(meta.id, current)
    return Promise.resolve()
  }

  commitRepair(
    meta: SessionHeader,
    _marker: undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    return this.appendBatch(meta, closers)
  }

  private revision(id: SessionId, length: number): ReturnType<typeof SessionPersistenceRevision> {
    return SessionPersistenceRevision(`dsh-rlm-test-memory:${id}:${length}`)
  }
}

function request(generation = 1): KernelHostRequestContext {
  const controller = new AbortController()
  return {
    requestId: `request-${Math.random()}`,
    generation,
    signal: controller.signal,
    execution: undefined,
    isCurrent: () => true,
  }
}

describe('native DSH continuation host bridge', () => {
  it('admits before child completion, reports, lists, and follows up through public seams', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-host-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(MemoryPersistence)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawnProvider, { providerName: 'rlm-spawn' })
    const adapter = new LocalAdapter()
    ctx.llm.registerAdapter(['local'], adapter)
    const parent = ctx.agentLoop.create(SessionId('rlm-parent'), {
      provider: 'local',
      model: 'local',
    })
    const bridge = new HostBridge(
      ctx,
      resolveConfig({
        artifactRoot: join(root, 'artifacts'),
        managedRuntimeRoot: join(root, 'runtime'),
        subagentProvider: 'rlm-spawn',
        maxDepth: 1,
      }),
    )

    await expect(
      bridge.dispatch(
        parent,
        'rlm.run',
        { prompt: 'invalid', kwargs: { temperature: 0 } },
        request(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      bridge.dispatch(
        parent,
        'rlm.run',
        { prompt: 'unsupported reasoning', kwargs: { thinking: 'low' } },
        request(),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    await expect(
      bridge.dispatch(
        parent,
        'rlm.run',
        { prompt: 'missing model', kwargs: { model: 'missing/local' } },
        request(),
      ),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })

    const admission = bridge.dispatch(
      parent,
      'rlm.run',
      { prompt: 'reply with READY', kwargs: { name: 'worker' } },
      request(),
    )
    const handle = await Promise.race([
      admission,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => {
          adapter.release()
          reject(new Error('rlm.run waited for the child model instead of inbox admission'))
        }, 1_000),
      ),
    ])
    expect(handle).toMatchObject({ name: 'worker', model: 'local/local' })
    expect(handle).not.toHaveProperty('result')
    const childId = SessionId(handle.rlm_child_id as string)
    const child = ctx.agents.get(childId)
    expect(child).toBeDefined()
    expect(child?.status).toBe('running')

    let report: Readonly<Record<string, unknown>>
    let followup: Readonly<Record<string, unknown>>
    try {
      report = await bridge.dispatch(
        child!,
        'agent_message.send',
        { message: 'explicit progress', receiver_role: 'parent', receiver_name: null },
        request(),
      )
      expect(report.message_id).toEqual(expect.any(String))
      followup = await bridge.dispatch(
        parent,
        'agent_message.send',
        { message: 'second turn', receiver_role: 'child', receiver_name: 'worker' },
        request(),
      )
      expect(followup).toMatchObject({ receiver_role: 'child', receiver_name: 'worker' })
    } finally {
      adapter.release()
    }
    await child!.whenIdle()
    const listed = await bridge.dispatch(parent, 'rlm.list_subagents', {}, request())
    expect(listed.subagents).toEqual([
      expect.objectContaining({
        rlm_child_id: childId,
        session_name: 'worker',
        status: 'completed',
      }),
    ])

    expect(
      child!.session.events.filter((event) => event.type === 'user/message').length,
    ).toBeGreaterThanOrEqual(2)
  }, 30_000)

  it('admits concurrent children and native recursion only within absolute depth policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-recursion-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(MemoryPersistence)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawnProvider, { providerName: 'rlm-spawn' })
    const adapter = new BlockingAdapter()
    ctx.llm.registerAdapter(['local'], adapter)
    const parent = ctx.agentLoop.create(SessionId('recursive-parent'), {
      provider: 'local',
      model: 'local',
    })
    const bridge = new HostBridge(
      ctx,
      resolveConfig({
        artifactRoot: join(root, 'artifacts'),
        managedRuntimeRoot: join(root, 'runtime'),
        subagentProvider: 'rlm-spawn',
        maxDepth: 2,
      }),
    )

    const [first, second] = await Promise.all([
      bridge.dispatch(parent, 'rlm.run', { prompt: 'first', kwargs: { name: 'first' } }, request()),
      bridge.dispatch(
        parent,
        'rlm.run',
        { prompt: 'second', kwargs: { name: 'second' } },
        request(),
      ),
    ])
    expect(first.rlm_child_id).not.toBe(second.rlm_child_id)
    const child = ctx.agents.get(SessionId(first.rlm_child_id as string))
    expect(child?.session.header.delegationDepth).toBe(1)

    const nested = await bridge.dispatch(
      child!,
      'rlm.run',
      { prompt: 'grandchild', kwargs: { name: 'grandchild' } },
      request(),
    )
    const grandchild = ctx.agents.get(SessionId(nested.rlm_child_id as string))
    expect(grandchild?.session.header.delegationDepth).toBe(2)
    await expect(
      bridge.dispatch(grandchild!, 'rlm.run', { prompt: 'too deep', kwargs: {} }, request()),
    ).rejects.toMatchObject({ code: 'DEPTH_LIMIT' })
    adapter.release()
  }, 30_000)
})
