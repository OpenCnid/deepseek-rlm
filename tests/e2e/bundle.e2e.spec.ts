import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '../..')
const execFileAsync = promisify(execFile)

const coldBootScript = String.raw`
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const mode = process.env.RLM_BUNDLE_TEST_MODE
const stateRoot = process.env.RLM_BUNDLE_TEST_STATE
if (mode === undefined || stateRoot === undefined) throw new Error('missing test configuration')

const ctx = new Context()
ctx.provide('agents', { list: () => [], get: () => undefined })
ctx.provide('llm', {})
ctx.provide('tools', { register: () => () => {} })
ctx.provide('systemPrompt', { section: () => () => {} })
await ctx.plugin(Loader, { baseUrl: pathToFileURL(resolve('package.json')).href })
await ctx.plugin(SubagentRuntime)

const providerRow = {
  id: 'rlm-spawn-provider',
  name: '@deepseek-rlm/dsh-rlm-bundle/spawn-provider',
  config: { providerName: 'rlm-spawn' },
}
const jupyterRow = {
  id: 'rlm-jupyter',
  name: '@deepseek-rlm/dsh-rlm-jupyter',
  inject: ['rlmSpawnReady'],
  config: {
    artifactRoot: stateRoot + '/artifacts',
    managedRuntimeRoot: stateRoot + '/runtime',
    subagentProvider: 'rlm-spawn',
    maxDepth: 1,
  },
}
const toolRow = { id: 'rlm-ipython-tool', name: '@deepseek-rlm/dsh-tool-ipython' }
const rows = mode === 'missing' ? [jupyterRow, toolRow] : [toolRow, jupyterRow, providerRow]

await ctx.loader.root.update(rows)
await ctx.loader.await()

function activationFailures() {
  return [...ctx.loader.entries()].flatMap((entry) => {
    const fiber = entry.fiber
    if (fiber?.state === 2) return []
    const missing = fiber === undefined
      ? []
      : Object.keys(fiber.inject).filter((service) => ctx.get(service) === undefined)
    return [entry.id + ': pending (waiting for service: ' + missing.join(', ') + ')']
  })
}

const initialFailures = activationFailures()
if (initialFailures.length > 0) {
  throw new Error('bundle activation failed\n' + initialFailures.join('\n'))
}

const provider = ctx.subagents.getProvider('rlm-spawn')
const readiness = ctx.get('rlmSpawnReady')
if (provider === undefined || readiness?.provider !== provider || readiness.providerName !== 'rlm-spawn') {
  throw new Error('readiness did not preserve the registered provider identity')
}
if (ctx.get('rlm') === undefined) throw new Error('rlm-jupyter did not activate')

await ctx.loader.remove('rlm-spawn-provider')
await ctx.loader.await()
if (ctx.subagents.getProvider('rlm-spawn') !== undefined) throw new Error('provider survived disposal')
if (ctx.get('rlmSpawnReady') !== undefined) throw new Error('readiness survived disposal')
if (ctx.get('rlm') !== undefined) throw new Error('dependent Jupyter service survived disposal')

await ctx.loader.create(providerRow)
await ctx.loader.await()
const replacement = ctx.subagents.getProvider('rlm-spawn')
const replacementReadiness = ctx.get('rlmSpawnReady')
if (replacement === undefined || replacementReadiness?.provider !== replacement) {
  throw new Error('provider readiness did not reactivate after HMR-style replacement')
}
if (ctx.get('rlm') === undefined) throw new Error('rlm-jupyter did not reactivate')

const activeRows = [...ctx.loader.entries()].map((entry) => entry.id).sort()
process.stdout.write(JSON.stringify({ activeRows, providerName: replacementReadiness.providerName }))
await ctx.fiber.dispose()
`

async function runColdBundle(mode: 'complete' | 'missing') {
  const stateRoot = await mkdtemp(join(tmpdir(), 'deepseek-rlm-bundle-e2e-'))
  try {
    return await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', coldBootScript],
      {
        cwd: root,
        env: {
          ...process.env,
          RLM_BUNDLE_TEST_MODE: mode,
          RLM_BUNDLE_TEST_STATE: stateRoot.replaceAll('\\', '/'),
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    )
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}

async function sourceFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const child = resolve(path, entry.name)
        return entry.isDirectory() ? sourceFiles(child) : [child]
      }),
    )
  ).flat()
}

describe('installable DSH bundle', () => {
  it('matches the pinned Loader patch shape, order, and declared dependency closure', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(root, 'packages/bundle/package.json'), 'utf8'),
    ) as {
      dsh?: { bundle?: { patch?: string } }
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./dsh.bundle.patch')
    const document = parse(
      await readFile(resolve(root, 'packages/bundle/dsh.bundle.patch'), 'utf8'),
    ) as unknown
    expect(document).toEqual([
      {
        insert: [
          expect.objectContaining({
            id: 'rlm-spawn-provider',
            name: '@deepseek-rlm/dsh-rlm-bundle/spawn-provider',
          }),
          expect.objectContaining({
            id: 'rlm-jupyter',
            name: '@deepseek-rlm/dsh-rlm-jupyter',
            inject: ['rlmSpawnReady'],
          }),
          expect.objectContaining({
            id: 'rlm-ipython-tool',
            name: '@deepseek-rlm/dsh-tool-ipython',
          }),
        ],
      },
    ])
    for (const name of ['@deepseek-rlm/dsh-rlm-jupyter', '@deepseek-rlm/dsh-tool-ipython']) {
      expect(manifest.dependencies?.[name]).toBeDefined()
    }
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-subagent-spawn-in-process']).toBe(
      '0.1.2-alpha.3',
    )
    expect(
      Object.keys(manifest.dependencies ?? {}).filter(
        (name) => name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/dsh-'),
      ),
    ).toEqual([])
    await expect(
      readFile(resolve(root, 'packages/prime-runtime/python/managed-requirements.lock')),
    ).resolves.toBeInstanceOf(Buffer)
  })

  it('cold-boots all three Loader rows in reverse order and survives provider replacement', async () => {
    const { stdout, stderr } = await runColdBundle('complete')
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      activeRows: ['rlm-ipython-tool', 'rlm-jupyter', 'rlm-spawn-provider'],
      providerName: 'rlm-spawn',
    })
  })

  it('fails a cold boot loudly when the configured provider readiness is genuinely absent', async () => {
    let failure: unknown
    try {
      await runColdBundle('missing')
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error & { stderr?: string }).stderr).toContain(
      'rlm-jupyter: pending (waiting for service: rlmSpawnReady)',
    )
  })

  it('keeps Prime/ACP agent drivers and Python provider clients out of production paths', async () => {
    const paths = [
      ...(await sourceFiles(resolve(root, 'packages/rlm/src'))),
      ...(await sourceFiles(resolve(root, 'packages/rlm-jupyter/src'))),
      ...(await sourceFiles(resolve(root, 'packages/tool-ipython/src'))),
      ...(await sourceFiles(resolve(root, 'python/dsh-rlm-runtime/src'))),
    ]
    const production = (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n')
    expect(production).not.toMatch(/AgentSession|prime-agent|@agentclientprotocol|acp\.connect/iu)
    const python = (
      await Promise.all(
        (await sourceFiles(resolve(root, 'python/dsh-rlm-runtime/src'))).map((path) =>
          readFile(path, 'utf8'),
        ),
      )
    ).join('\n')
    expect(python).not.toMatch(/\b(?:openai|anthropic|litellm)\b|requests\.(?:post|get)\s*\(/iu)
  })

  it('ships deletion and downstream-event patches while using native reasoning support', async () => {
    const patches = await Promise.all(
      ['0002-continuable-child-deletion.patch', '0003-public-ignorable-session-events.patch'].map(
        (name) => readFile(resolve(root, 'patches/deepseek-harness', name), 'utf8'),
      ),
    )
    expect(patches[0]).toContain('deleteContinuable')
    expect(patches[0]).toContain("'subagent/deleted'")
    expect(patches[1]).toContain('appendIgnorable')
  })
})
