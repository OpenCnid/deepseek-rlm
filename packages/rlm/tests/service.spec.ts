import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { appendRlmSessionEvent, RlmCompatibilityError, RlmRuntime } from '../src/index.js'
import type {
  RlmExecuteRequest,
  RlmExecutionResult,
  RlmKernelInfo,
  RlmSnapshotResult,
} from '../src/index.js'

class StubRlmRuntime extends RlmRuntime {
  disposed = false

  override execute(request: RlmExecuteRequest): Promise<RlmExecutionResult> {
    return Promise.resolve({
      status: 'ok',
      stdout: request.code,
      stderr: '',
      durationMs: 0,
      generation: 1,
      kernelRestarted: false,
    })
  }

  override info(): RlmKernelInfo | undefined {
    return undefined
  }

  override snapshot(): Promise<RlmSnapshotResult | undefined> {
    return Promise.resolve(undefined)
  }

  override restart(): Promise<void> {
    return Promise.resolve()
  }

  override disposeAgent(_agent: Agent): Promise<void> {
    this.disposed = true
    return Promise.resolve()
  }
}

describe('RlmRuntime service seam', () => {
  it('requires the public ignorable-event compatibility seam', () => {
    expect(() =>
      appendRlmSessionEvent({} as never, 'rlm/host-request', {
        version: 1,
        requestId: 'request-1',
        requestType: 'test',
        generation: 1,
        durationMs: 0,
        status: 'ok',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RlmCompatibilityError>>({
        code: 'UNSUPPORTED_IGNORABLE_SESSION_EVENTS',
      }),
    )
  })

  it('writes RLM events only through appendIgnorable', () => {
    const appendIgnorable = vi.fn()
    appendRlmSessionEvent({ appendIgnorable } as never, 'rlm/kernel-generation', {
      version: 1,
      generation: 1,
      python: 'python',
      runtimeVersion: 'test',
      reason: 'start',
    })
    expect(appendIgnorable).toHaveBeenCalledWith('rlm/kernel-generation', expect.any(Object))
  })

  it('registers one provider as ctx.rlm and removes it on fiber disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubRlmRuntime)
    expect(ctx.rlm).toBeInstanceOf(StubRlmRuntime)
    await fiber.dispose()
    expect(ctx.rlm).toBeUndefined()
  })

  it('rejects duplicate providers through the Cordis service invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(StubRlmRuntime)
    await expect(ctx.plugin(StubRlmRuntime)).rejects.toThrow(/service "rlm" has been registered/u)
  })
})
