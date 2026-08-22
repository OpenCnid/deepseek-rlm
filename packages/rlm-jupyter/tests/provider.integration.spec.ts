import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  CallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as ipythonTool from '../../tool-ipython/src/index.js'
import JupyterRlmRuntime from '../src/index.js'

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
    let resolvePromise!: (value: T | PromiseLike<T>) => void
    let rejectPromise!: (reason?: unknown) => void
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    return { promise, resolve: resolvePromise, reject: rejectPromise }
  }
}

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

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function toolCall(callId: string, code: string): StreamChunk[] {
  const id = CallId(callId)
  const argumentsJson = JSON.stringify({ code })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id,
      name: 'ipython',
      argumentsDelta: argumentsJson,
    },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id, name: 'ipython', arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class IpythonLoopAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly script = [
    toolCall('set-x', 'x = 41'),
    toolCall('read-x', 'x + 1'),
    textResponse('RLM_OK'),
  ]

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: 'Scripted IPython model' })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('scripted IPython adapter exhausted')
    for (const chunk of response) yield chunk
  }
}

describe('Jupyter RLM provider recovery', () => {
  it('dispatches a nested Python tool call through the optional live DSH tools service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-tools-adapter-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawnProvider, { providerName: 'rlm-spawn' })
    const agent = ctx.agentLoop.create(SessionId('provider-tools-adapter'), {
      provider: 'unused',
      model: 'unused',
    })
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          name: 'nested_probe',
          description: 'Synthetic nested-tool bridge probe.',
          parameters: {
            value: { type: 'string', required: true },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                accepted: { type: 'boolean', required: true },
                session_id: { type: 'string', required: true },
              },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          isConcurrencySafe: () => true,
          execute: (args, exec) =>
            Promise.resolve({
              accepted: args.value === 'synthetic',
              session_id: String(exec.agent?.id),
            }),
        }),
      ),
    )
    await ctx.plugin(JupyterRlmRuntime, {
      artifactRoot: join(root, 'artifacts'),
      managedRuntimeRoot: resolve('.dsh-rlm/test-runtime'),
      subagentProvider: 'rlm-spawn',
      adapters: { tools: true },
    })
    await ctx.plugin(ipythonTool)

    const result = await ctx.tools.execute({
      callId: CallId('nested-probe-cell'),
      name: 'ipython',
      arguments: {
        code: `
import json as _json
_probe = await dsh_tools.call("nested_probe", {"value": "synthetic"})
print("NESTED_PROBE=" + _json.dumps(_probe["value"], sort_keys=True))
del _probe
`.trim(),
      },
      agent,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      isError: false,
      value: {
        stdout: expect.stringContaining(
          'NESTED_PROBE={"accepted": true, "session_id": "provider-tools-adapter"}',
        ),
      },
    })
  }, 120_000)

  it('runs persistent IPython through the real DSH agent loop and tool registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-loop-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawnProvider, { providerName: 'rlm-spawn' })
    const adapter = new IpythonLoopAdapter()
    ctx.llm.registerAdapter(['scripted'], adapter)
    const agent = ctx.agentLoop.create(SessionId('provider-agent-loop'), {
      provider: 'scripted',
      model: 'ipython',
    })
    await ctx.plugin(JupyterRlmRuntime, {
      artifactRoot: join(root, 'artifacts'),
      managedRuntimeRoot: resolve('.dsh-rlm/test-runtime'),
      subagentProvider: 'rlm-spawn',
    })
    await ctx.plugin(ipythonTool)

    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'prove persistent Python state' }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    const finalRequest = adapter.requests[2]
    const toolResultTexts = finalRequest?.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool-result')
      .flatMap((block) => block.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
    expect(toolResultTexts).toContain('42')
    expect(agent.session.events.filter((event) => event.type === 'tool/call')).toHaveLength(2)
    expect(agent.session.events.filter((event) => event.type === 'tool/result')).toHaveLength(2)
    expect(
      agent.session
        .deriveMessages()
        .some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some((block) => block.type === 'text' && block.text === 'RLM_OK'),
        ),
    ).toBe(true)
  }, 120_000)

  it('restores across an HMR provider generation without replaying cell side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-provider-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawnProvider, { providerName: 'rlm-spawn' })
    const agent = ctx.agentLoop.create(SessionId('provider-recovery'), {
      provider: 'unused',
      model: 'unused',
    })
    const config = {
      artifactRoot: join(root, 'artifacts'),
      managedRuntimeRoot: resolve('.dsh-rlm/test-runtime'),
      subagentProvider: 'rlm-spawn',
    }
    const firstProvider = await ctx.plugin(JupyterRlmRuntime, config)
    const sideEffect = join(root, 'side-effect.txt')
    expect(
      await ctx.rlm.execute({
        agent,
        callId: CallId('first-cell'),
        code: `
from pathlib import Path
_p = Path(${JSON.stringify(sideEffect)})
_p.write_text(str(int(_p.read_text()) + 1) if _p.exists() else "1")
x = 41
`.trim(),
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ status: 'ok' })

    const controller = new AbortController()
    const interrupted = ctx.rlm.execute({
      agent,
      callId: CallId('interrupted-cell'),
      code: 'import time; time.sleep(30)',
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 100)
    await expect(interrupted).resolves.toMatchObject({ status: 'aborted' })
    await expect(
      ctx.rlm.execute({
        agent,
        callId: CallId('post-interrupt-cell'),
        code: 'x + 1',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'ok', result: '42' })

    await firstProvider.dispose()
    await ctx.plugin(JupyterRlmRuntime, config)
    expect(
      await ctx.rlm.execute({
        agent,
        callId: CallId('restored-cell'),
        code: 'x + 1',
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ status: 'ok', result: '42', generation: 1 })
    expect(await readFile(sideEffect, 'utf8')).toBe('1')
    expect(agent.session.events.some((event) => event.type === 'rlm/kernel-restore')).toBe(true)
  }, 120_000)
})
