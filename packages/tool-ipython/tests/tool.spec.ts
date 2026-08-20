import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RlmRuntime, {
  type RlmExecuteRequest,
  type RlmExecutionResult,
  type RlmKernelInfo,
  type RlmSnapshotResult,
} from '@deepseek-rlm/dsh-rlm'
import * as ipythonTool from '../src/index.js'

class StubRuntime extends RlmRuntime {
  execute = vi.fn<(request: RlmExecuteRequest) => Promise<RlmExecutionResult>>()

  info(): RlmKernelInfo | undefined {
    return undefined
  }

  snapshot(): Promise<RlmSnapshotResult | undefined> {
    return Promise.resolve(undefined)
  }

  restart(): Promise<void> {
    return Promise.resolve()
  }

  disposeAgent(): Promise<void> {
    return Promise.resolve()
  }
}

async function setup(): Promise<{ ctx: Context; runtime: StubRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubRuntime)
  await ctx.plugin(ipythonTool)
  return { ctx, runtime: ctx.rlm as StubRuntime }
}

function execution(agent: Agent): ToolRunContext {
  const callId = CallId('ipython-call')
  return {
    agent,
    callId,
    rootCallId: callId,
    name: 'ipython',
    arguments: { code: 'x = 41' },
    signal: new AbortController().signal,
    token: Symbol('execution') as never,
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
  }
}

describe('native ipython tool consumer', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('registers the exact exclusive schema and OS-authority prompt guidance', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('ipython')
    expect(definition?.parameters).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { code: { type: 'string', description: expect.any(String) } },
      required: ['code'],
    })
    expect(definition?.isConcurrencySafe).toBeUndefined()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map((section) => section.text).join('\n')).toContain('not a sandbox')
  })

  it('passes exact authority and execution identity to ctx.rlm', async () => {
    const { ctx, runtime } = await setup()
    runtime.execute.mockResolvedValue({
      status: 'ok',
      stdout: '41\n',
      stderr: '',
      result: '42',
      durationMs: 7,
      generation: 2,
      kernelRestarted: false,
    })
    const agent = { id: SessionId('agent') } as Agent
    const exec = execution(agent)
    const value = await ctx.tools.get('ipython')?.execute({ code: 'x + 1' }, exec)
    expect(runtime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        callId: exec.callId,
        signal: exec.signal,
        executionToken: exec.token,
        code: 'x + 1',
      }),
    )
    expect(value).toMatchObject({ status: 'ok', stdout: '41\n', result: '42', generation: 2 })
  })

  it('turns Python failures into ordinary tool failures', async () => {
    const { ctx, runtime } = await setup()
    runtime.execute.mockResolvedValue({
      status: 'error',
      stdout: '',
      stderr: '',
      durationMs: 2,
      generation: 1,
      kernelRestarted: false,
      error: { name: 'ValueError', message: 'bad value', traceback: ['trace line'] },
    })
    await expect(
      ctx.tools
        .get('ipython')
        ?.execute({ code: 'raise ValueError()' }, execution({ id: SessionId('agent') } as Agent)),
    ).rejects.toThrow(/ValueError: bad value[\s\S]*trace line/u)
  })
})
