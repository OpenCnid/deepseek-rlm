import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import * as spawnProvider from '../src/spawn-provider.js'

describe('bundle spawn-provider readiness', () => {
  it('publishes only after provider registration and disposes both identities together', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    let readinessDuringAddedEvent: unknown = 'not observed'
    ctx.on('subagent/provider-added', () => {
      readinessDuringAddedEvent = ctx.get('rlmSpawnReady')
    })

    const fiber = await ctx.plugin(spawnProvider, { providerName: 'rlm-spawn' })
    const provider = ctx.subagents.getProvider('rlm-spawn')
    const readiness = ctx.get('rlmSpawnReady')

    expect(readinessDuringAddedEvent).toBeUndefined()
    expect(provider).toBeDefined()
    expect(readiness?.providerName).toBe('rlm-spawn')
    expect(readiness?.provider).toBe(provider)

    await fiber.dispose()
    expect(ctx.subagents.getProvider('rlm-spawn')).toBeUndefined()
    expect(ctx.get('rlmSpawnReady')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
