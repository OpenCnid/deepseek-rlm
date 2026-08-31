import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { appendRlmSessionEvent } from '@deepseek-rlm/dsh-rlm'
import { HostRequestError, type KernelHostRequestContext } from './kernel.js'
import type { ResolvedConfig } from './config.js'

interface PatchedSubagentCapabilities {
  readonly deletion: boolean
}

interface DeletedSubagent {
  readonly id: SessionId
  readonly label: string
}

interface PatchedSubagents {
  deleteContinuable?(
    parent: Agent,
    childId: SessionId,
    options: { signal: AbortSignal },
  ): Promise<DeletedSubagent>
}

type JsonObject = Readonly<Record<string, unknown>>

function ownKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const set = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !set.has(key))
  if (unknown.length > 0) {
    throw new HostRequestError(
      `${label} has unknown field ${JSON.stringify(unknown[0])}`,
      'INVALID_ARGUMENT',
    )
  }
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostRequestError(`${label} must be an object`, 'INVALID_ARGUMENT')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new HostRequestError(`${label} must be a plain object`, 'INVALID_ARGUMENT')
  }
  return value as JsonObject
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new HostRequestError(
      `${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string`,
      'INVALID_ARGUMENT',
    )
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

function assertCurrent(context: KernelHostRequestContext): void {
  if (context.signal.aborted) throw new HostRequestError('host request was cancelled', 'CANCELLED')
  if (!context.isCurrent()) {
    throw new HostRequestError('kernel generation was retired', 'STALE_GENERATION')
  }
}

function failureCode(error: unknown): string {
  return error instanceof HostRequestError ? error.code : 'HOST_REQUEST_FAILED'
}

function patchedCapabilities(ctx: Context): PatchedSubagentCapabilities {
  const patched = ctx.subagents as typeof ctx.subagents & PatchedSubagents
  return {
    deletion: typeof patched.deleteContinuable === 'function',
  }
}

/** FIFO keyed critical section used only for parent-scoped label admission. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

function childRow(entry: SubagentListEntry, ctx: Context, artifactRoot: string): JsonObject {
  const path = join(artifactRoot, 'sessions', entry.id)
  if (entry.kind === 'diagnostic') {
    return {
      rlm_child_id: entry.id,
      active_session_id: null,
      session_id: entry.id,
      session_name: entry.id,
      session_dir: path,
      status: 'error',
      diagnostic: entry.reason,
    }
  }
  const live = ctx.agents.get(entry.id)
  const label = entry.label ?? entry.id
  return {
    rlm_child_id: entry.id,
    active_session_id: live?.id ?? null,
    session_id: entry.id,
    session_name: label,
    session_dir: path,
    status: live?.status === 'running' ? 'running' : 'completed',
  }
}

function labelOf(entry: SubagentListEntry): string | undefined {
  return entry.kind === 'child' ? entry.label : undefined
}

/** Translation only: DSH remains the sole owner of agents, models, tools and policy. */
export class HostBridge {
  private readonly labelLock = new KeyedLock()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async dispatch(
    agent: Agent,
    type: string,
    payload: JsonObject,
    request: KernelHostRequestContext,
  ): Promise<JsonObject> {
    const startedAt = Date.now()
    let status: 'ok' | 'error' | 'aborted' = 'ok'
    let errorCode: string | undefined
    try {
      assertCurrent(request)
      const result = await this.route(agent, type, payload, request)
      assertCurrent(request)
      return result
    } catch (error) {
      errorCode = failureCode(error)
      status = request.signal.aborted ? 'aborted' : 'error'
      if (error instanceof HostRequestError) throw error
      throw new HostRequestError(
        error instanceof Error ? error.message : String(error),
        errorCode,
        { cause: error },
      )
    } finally {
      appendRlmSessionEvent(agent.session, 'rlm/host-request', {
        version: 1,
        requestId: request.requestId,
        requestType: type,
        generation: request.generation,
        durationMs: Date.now() - startedAt,
        status,
        ...(errorCode === undefined ? {} : { errorCode }),
      })
    }
  }

  private async route(
    agent: Agent,
    type: string,
    payload: JsonObject,
    request: KernelHostRequestContext,
  ): Promise<JsonObject> {
    switch (type) {
      case 'rlm.run':
        return await this.run(agent, payload, request)
      case 'rlm.find_models':
        return await this.findModels(payload, request)
      case 'rlm.list_subagents':
        return await this.listSubagents(agent, payload, request)
      case 'rlm.delete_subagent':
        return await this.deleteSubagent(agent, payload, request)
      case 'agent_message.list_agents':
        return await this.listAgents(agent, payload, request)
      case 'agent_message.send':
        return await this.sendMessage(agent, payload, request)
      case 'dsh_tools.list':
        return this.listTools(agent, payload)
      case 'dsh_tools.call':
        return await this.callTool(agent, payload, request)
      default:
        throw new HostRequestError(
          `unsupported host request ${JSON.stringify(type)}`,
          'UNSUPPORTED_REQUEST',
        )
    }
  }

  private async selectModel(
    agent: Agent,
    selector: string | undefined,
    thinking: string | undefined,
    signal: AbortSignal,
  ): Promise<{ provider: string; model: string; options: AgentOptions }> {
    let provider: string
    let model: string
    if (selector === undefined) {
      // During a live tool step, the latest request header is the exact route
      // after Agent-scoped selection middleware. Construction options are only
      // authoritative before the AgentLoop has logged its first request.
      const active = agent.session.requestHeader()?.config
      const inherited = active ?? agent.options
      if (inherited.provider === undefined || inherited.model === undefined) {
        throw new HostRequestError(
          'parent agent has no complete model selection',
          'MODEL_UNAVAILABLE',
        )
      }
      provider = inherited.provider
      model = inherited.model
    } else {
      const providers = this.ctx.llm
        .listProviders()
        .map((entry) => entry.id)
        .sort((left, right) => right.length - left.length || left.localeCompare(right))
      const matched = providers.find((candidate) => selector.startsWith(`${candidate}/`))
      if (matched === undefined) {
        throw new HostRequestError(
          `model selector ${JSON.stringify(selector)} has no active provider`,
          'MODEL_UNAVAILABLE',
        )
      }
      provider = matched
      model = selector.slice(matched.length + 1)
      if (model.length === 0) {
        throw new HostRequestError('model selector must include a model id', 'INVALID_ARGUMENT')
      }
    }
    const models = await this.ctx.llm.listModels(provider)
    if (!models.some((entry) => entry.id === model)) {
      throw new HostRequestError(
        `model ${provider}/${model} is not advertised by its active route`,
        'MODEL_UNAVAILABLE',
      )
    }
    const info = await this.ctx.llm.resolveModelInfo(provider, model, signal)
    const options: AgentOptions = { provider, model }
    if (thinking !== undefined) {
      if (!info.reasoning?.efforts.some((entry) => entry.id === thinking)) {
        throw new HostRequestError(
          `reasoning effort ${JSON.stringify(thinking)} is not supported by ${provider}/${model}`,
          'REASONING_UNAVAILABLE',
        )
      }
      ;(options as AgentOptions & { reasoningEffort: ReasoningEffortId }).reasoningEffort =
        ReasoningEffortId(thinking)
    }
    return { provider, model, options }
  }

  private async run(
    agent: Agent,
    payload: JsonObject,
    request: KernelHostRequestContext,
  ): Promise<JsonObject> {
    ownKeys(payload, ['prompt', 'kwargs'], 'rlm.run request')
    const prompt = string(payload.prompt, 'rlm.run prompt')
    const kwargs = object(payload.kwargs ?? {}, 'rlm.run kwargs')
    ownKeys(kwargs, ['name', 'model', 'thinking'], 'rlm.run kwargs')
    const explicitName = optionalString(kwargs.name, 'rlm.run kwargs.name')
    const selector = optionalString(kwargs.model, 'rlm.run kwargs.model')
    const thinking = optionalString(kwargs.thinking, 'rlm.run kwargs.thinking')
    const depth = agent.session.header.delegationDepth ?? 0
    if (!Number.isSafeInteger(depth) || depth < 0 || depth + 1 > this.config.maxDepth) {
      throw new HostRequestError(
        `delegation depth ${depth + 1} exceeds configured maximum ${this.config.maxDepth}`,
        'DEPTH_LIMIT',
      )
    }
    return await this.labelLock.run(agent.id, async () => {
      assertCurrent(request)
      const existing = await this.ctx.subagents.listChildren(agent.id, request.signal)
      const names = new Set(
        existing.map(labelOf).filter((name): name is string => name !== undefined),
      )
      let label = explicitName
      if (label !== undefined && names.has(label)) {
        throw new HostRequestError(
          `direct child label ${JSON.stringify(label)} already exists`,
          'DUPLICATE_LABEL',
        )
      }
      if (label === undefined) {
        let sequence = 1
        while (names.has(`rlm-${sequence}`)) sequence += 1
        label = `rlm-${sequence}`
      }
      const selected = await this.selectModel(agent, selector, thinking, request.signal)
      assertCurrent(request)
      const started = await this.ctx.subagents.startContinuable({
        provider: this.config.subagentProvider,
        label,
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent: agent,
          agentOptions: selected.options,
          maxDepth: this.config.maxDepth,
        },
        signal: request.signal,
      })
      assertCurrent(request)
      const sessionDirectory = join(this.config.artifactRoot, 'sessions', started.childId)
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 })
      return {
        rlm_child_id: started.childId,
        name: label,
        session_dir: sessionDirectory,
        model: `${selected.provider}/${selected.model}`,
      }
    })
  }

  private async findModels(
    payload: JsonObject,
    request: KernelHostRequestContext,
  ): Promise<JsonObject> {
    ownKeys(payload, ['query', 'limit'], 'rlm.find_models request')
    const query = payload.query === undefined ? '' : string(payload.query, 'query', true)
    const limit = payload.limit === undefined ? 8 : payload.limit
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) {
      throw new HostRequestError(
        'rlm.find_models limit must be a safe integer from 1 through 50',
        'INVALID_ARGUMENT',
      )
    }
    const lowered = query.toLocaleLowerCase()
    const models: Array<{ provider: string; id: string; name: string; selector: string }> = []
    const providers = [...this.ctx.llm.listProviders()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
    for (const provider of providers) {
      assertCurrent(request)
      const entries = [...(await this.ctx.llm.listModels(provider.id))].sort((left, right) =>
        left.id.localeCompare(right.id),
      )
      for (const model of entries) {
        const selector = `${provider.id}/${model.id}`
        if (`${selector}\n${model.name}`.toLocaleLowerCase().includes(lowered)) {
          models.push({ provider: provider.id, id: model.id, name: model.name, selector })
        }
      }
    }
    return { models: models.slice(0, limit as number) }
  }

  private async children(
    agent: Agent,
    request: KernelHostRequestContext,
  ): Promise<SubagentListEntry[]> {
    assertCurrent(request)
    return await this.ctx.subagents.listChildren(agent.id, request.signal)
  }

  private async listSubagents(
    agent: Agent,
    payload: JsonObject,
    request: KernelHostRequestContext,
  ): Promise<JsonObject> {
    ownKeys(payload, [], 'rlm.list_subagents request')
    const entries = (await this.children(agent, request)).filter(
      (entry) => entry.kind === 'diagnostic' || entry.mode === 'continuable',
    )
    return {
      subagents: entries.map((entry) => childRow(entry, this.ctx, this.config.artifactRoot)),
    }
  }

  private resolveChild(entries: readonly SubagentListEntry[], selector: string): SubagentListEntry {
    const byId = entries.filter((entry) => entry.id === selector)
    const byName = entries.filter((entry) => labelOf(entry) === selector)
    const matches = byId.length > 0 ? byId : byName
    if (matches.length === 0)
      throw new HostRequestError(
        `no direct child matches ${JSON.stringify(selector)}`,
        'CHILD_NOT_FOUND',
      )
    if (matches.length > 1)
      throw new HostRequestError(
        `child label ${JSON.stringify(selector)} is ambiguous`,
        'AMBIGUOUS_CHILD',
      )
    return matches[0]!
  }

  private async deleteSubagent(
    agent: Agent,
    payload: JsonObject,
    request: KernelHostRequestContext,
  ): Promise<JsonObject> {
    ownKeys(payload, ['target'], 'rlm.delete_subagent request')
    const target = string(payload.target, 'rlm.delete_subagent target').trim()
    if (target.length === 0)
      throw new HostRequestError('rlm.delete_subagent target must not be blank', 'INVALID_ARGUMENT')
    const entry = this.resolveChild(await this.children(agent, request), target)
    if (entry.kind !== 'child' || entry.mode !== 'continuable') {
      throw new HostRequestError(
        'only a direct continuable child can be deleted',
        'CHILD_NOT_FOUND',
      )
    }
    const patched = this.ctx.subagents as typeof this.ctx.subagents & PatchedSubagents
    if (!patchedCapabilities(this.ctx).deletion || patched.deleteContinuable === undefined) {
      throw new HostRequestError(
        'this DeepSeek Harness build has no public durable continuable-deletion seam',
        'UNSUPPORTED_DELETION',
      )
    }
    await patched.deleteContinuable(agent, entry.id, { signal: request.signal })
    return { subagent: childRow(entry, this.ctx, this.config.artifactRoot) }
  }

  private async listAgents(
    agent: Agent,
    payload: JsonObject,
    request: KernelHostRequestContext,
  ): Promise<JsonObject> {
    ownKeys(payload, [], 'agent_message.list_agents request')
    const children = await this.children(agent, request)
    const parentId = agent.session.header.parentSession
    return {
      self: { role: 'self', session_id: agent.id },
      parent:
        parentId === undefined
          ? null
          : {
              role: 'parent',
              session_id: parentId,
              active: this.ctx.agents.get(parentId) !== undefined,
            },
      children: children
        .filter((entry) => entry.kind === 'child' && entry.mode === 'continuable')
        .map((entry) => ({
          role: 'child',
          name: entry.kind === 'child' ? entry.label : undefined,
          session_id: entry.id,
          active: this.ctx.agents.get(entry.id) !== undefined,
        })),
    }
  }

  private async sendMessage(
    agent: Agent,
    payload: JsonObject,
    request: KernelHostRequestContext,
  ): Promise<JsonObject> {
    ownKeys(
      payload,
      ['target', 'message', 'receiver_role', 'receiver_name'],
      'agent_message.send request',
    )
    if (payload.target === 'all') {
      throw new HostRequestError(
        'broadcast messaging is not provided by the DSH continuation seam',
        'UNSUPPORTED_RELATIONSHIP',
      )
    }
    const message = string(payload.message, 'agent_message.send message')
    const role = string(payload.receiver_role, 'agent_message.send receiver_role')
    const content: ContentBlock[] = [{ type: 'text', text: message }]
    if (role === 'parent') {
      if (payload.receiver_name !== null && payload.receiver_name !== undefined) {
        throw new HostRequestError(
          'receiver_name must be omitted for parent messages',
          'INVALID_ARGUMENT',
        )
      }
      const messageId = await this.ctx.subagents.reportFrom(agent, content, {
        delivery: 'next-step',
        signal: request.signal,
      })
      return { message_id: messageId, receiver_role: role }
    }
    if (role === 'sibling') {
      throw new HostRequestError(
        'sibling messaging is not available in the DSH public seam',
        'UNSUPPORTED_RELATIONSHIP',
      )
    }
    if (role !== 'child')
      throw new HostRequestError(
        `unknown receiver role ${JSON.stringify(role)}`,
        'INVALID_ARGUMENT',
      )
    const receiver = string(payload.receiver_name, 'agent_message.send receiver_name').trim()
    const child = this.resolveChild(await this.children(agent, request), receiver)
    if (child.kind !== 'child' || child.mode !== 'continuable') {
      throw new HostRequestError('receiver is not a direct continuable child', 'CHILD_NOT_FOUND')
    }
    const messageId = await this.ctx.subagents.followup(agent, child.id, content, {
      source: { kind: 'coordinator', form: 'relay', senderSessionId: agent.id },
      signal: request.signal,
    })
    return { message_id: messageId, receiver_role: role, receiver_name: child.label }
  }

  private listTools(agent: Agent, payload: JsonObject): JsonObject {
    ownKeys(payload, [], 'dsh_tools.list request')
    if (!this.config.adapters.tools) {
      throw new HostRequestError('the DSH tools adapter is not enabled', 'ADAPTER_DISABLED')
    }
    const tools = this.ctx.get('tools')
    if (tools === undefined) {
      throw new HostRequestError('the DSH tools service is unavailable', 'ADAPTER_UNAVAILABLE')
    }
    return { tools: tools.schemas(agent) }
  }

  private async callTool(
    agent: Agent,
    payload: JsonObject,
    request: KernelHostRequestContext,
  ): Promise<JsonObject> {
    ownKeys(payload, ['name', 'arguments'], 'dsh_tools.call request')
    if (!this.config.adapters.tools) {
      throw new HostRequestError('the DSH tools adapter is not enabled', 'ADAPTER_DISABLED')
    }
    const tools = this.ctx.get('tools')
    if (tools === undefined) {
      throw new HostRequestError('the DSH tools service is unavailable', 'ADAPTER_UNAVAILABLE')
    }
    const name = string(payload.name, 'dsh_tools.call name')
    const arguments_ = object(payload.arguments, 'dsh_tools.call arguments')
    const execution = request.execution
    if (execution === undefined || execution.token === undefined || !execution.isOpen()) {
      throw new HostRequestError(
        'the originating ipython execution has settled',
        'REQUEST_SCOPE_CLOSED',
      )
    }
    const count = execution.nextNestedCallSequence()
    const result = await tools.execute({
      callId: ToolCallId(`${execution.callId}:rlm:${count}`),
      rootCallId: ToolCallId(execution.callId),
      name,
      arguments: arguments_,
      agent,
      parent: execution.token as ToolExecutionToken,
      signal: execution.signal,
    })
    return result as unknown as JsonObject
  }
}
