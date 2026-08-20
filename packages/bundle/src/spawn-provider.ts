import { Service, type Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import {
  Config as SpawnProviderConfigSchema,
  apply as applySpawnProvider,
} from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { Config as SpawnProviderConfig } from '@deepseek-ai/dsh-subagent-spawn-in-process'

/** Hard-dependency service published only after the named spawn provider commits. */
export const RLM_SPAWN_READY_SERVICE = 'rlmSpawnReady'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rlmSpawnReady: RlmSpawnReady
  }
}

/** Exact provider identity made available to bundle consumers after registration. */
export class RlmSpawnReady extends Service {
  constructor(
    ctx: Context,
    readonly providerName: string,
    readonly provider: SubagentProvider,
  ) {
    super(ctx, RLM_SPAWN_READY_SERVICE)
  }
}

export const name = 'rlm-spawn-provider'
export const inject = ['subagents']
export type Config = SpawnProviderConfig
export const Config: typeof SpawnProviderConfigSchema = SpawnProviderConfigSchema

/** Register the native DSH provider, then publish the bundle readiness edge. */
export function apply(ctx: Context, config: Config): void {
  applySpawnProvider(ctx, config)
  const provider = ctx.subagents.getProvider(config.providerName)
  if (provider === undefined) {
    throw new Error(
      `spawn provider ${JSON.stringify(config.providerName)} did not commit registration`,
    )
  }
  new RlmSpawnReady(ctx, config.providerName, provider)
}
