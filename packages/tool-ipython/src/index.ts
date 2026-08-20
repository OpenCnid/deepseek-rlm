import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-rlm/dsh-rlm'

export const name = 'tool-ipython'
export const inject = ['rlm', 'tools', 'systemPrompt']
export interface Config {}
export const Config: z<Config> = z.object({})

const prompt = `The ipython tool runs Python in one persistent Jupyter namespace for this exact agent. Variables survive later calls and are best-effort snapshotted, but external side effects are not replayed. Use %%bash for shell commands; on Windows it requires the deployment's configured Bash executable. The callable rlm(prompt, name=..., model=..., thinking=...) returns an admission handle immediately, never the child's answer. Children are ordinary DeepSeek Harness agents and must explicitly report useful results with agent_message.send(..., receiver_role="parent"). A parent follows up with agent_message.send(..., receiver_role="child", receiver_name=handle.name). dsh_tools calls preserve Harness policy only while the enclosing ipython call remains open. This kernel is not a sandbox: Python, subprocesses, files, network calls, and %%bash run with the kernel process's OS authority and may bypass DeepSeek Harness tool guards.`

function renderedText(value: { stdout: string; stderr: string; result?: string }): string {
  return [value.stdout, value.stderr, value.result]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('')
}

export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'tool:ipython',
        order: 116,
        text: prompt,
      }),
    'ipython.promptSection()',
  )
  const definition = defineTool({
    name: 'ipython',
    description:
      'Execute Python in this agent’s persistent Jupyter kernel. State is isolated per agent and preserved across calls.',
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: 'Python source or an IPython cell magic such as %%bash.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok'], required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          result: { type: 'string' },
          durationMs: { type: 'number', required: true },
          generation: { type: 'number', required: true },
          kernelRestarted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderedText(value) }],
    },
    async execute(args, exec) {
      const unknown = Object.keys(args).find((key) => key !== 'code')
      if (unknown !== undefined)
        throw new Error(`ipython has unknown argument ${JSON.stringify(unknown)}`)
      if (exec.agent === undefined) throw new Error('ipython requires an exact live Agent')
      const result = await ctx.rlm.execute({
        agent: exec.agent as Agent,
        callId: exec.callId,
        code: args.code,
        signal: exec.signal,
        executionToken: exec.token,
        onOutput: (chunk) =>
          ctx.emit('rlm/output', {
            agent: exec.agent as Agent,
            callId: exec.callId,
            chunk,
          }),
      })
      if (result.status === 'aborted') {
        throw new Error(
          `ipython execution was aborted${result.kernelRestarted ? '; its kernel generation was retired' : ''}`,
        )
      }
      if (result.status === 'error') {
        const traceback = result.error?.traceback.join('\n') ?? ''
        throw new Error(
          [
            result.error === undefined
              ? 'Python execution failed'
              : `${result.error.name}: ${result.error.message}`,
            traceback,
            result.stdout,
            result.stderr,
          ]
            .filter((part) => part.length > 0)
            .join('\n'),
        )
      }
      return {
        status: 'ok' as const,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.result === undefined ? {} : { result: result.result }),
        durationMs: result.durationMs,
        generation: result.generation,
        kernelRestarted: result.kernelRestarted,
      }
    },
  })
  ctx.effect(
    () =>
      ctx.tools.register({
        ...definition,
        parameters: { ...definition.parameters, additionalProperties: false },
      }),
    'ipython.registerTool()',
  )
}
