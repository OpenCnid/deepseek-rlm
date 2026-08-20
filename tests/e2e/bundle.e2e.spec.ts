import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '../..')

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
    ) as { dsh?: { bundle?: { patch?: string } }; dependencies?: Record<string, string> }
    expect(manifest.dsh?.bundle?.patch).toBe('./dsh.bundle.patch')
    const document = parse(
      await readFile(resolve(root, 'packages/bundle/dsh.bundle.patch'), 'utf8'),
    ) as unknown
    expect(document).toEqual([
      {
        insert: [
          expect.objectContaining({
            id: 'rlm-spawn-provider',
            name: '@deepseek-ai/dsh-subagent-spawn-in-process',
          }),
          expect.objectContaining({ id: 'rlm-jupyter', name: '@deepseek-rlm/dsh-rlm-jupyter' }),
          expect.objectContaining({
            id: 'rlm-ipython-tool',
            name: '@deepseek-rlm/dsh-tool-ipython',
          }),
        ],
      },
    ])
    for (const name of [
      '@deepseek-ai/dsh-subagent-spawn-in-process',
      '@deepseek-rlm/dsh-rlm-jupyter',
      '@deepseek-rlm/dsh-tool-ipython',
    ]) {
      expect(manifest.dependencies?.[name]).toBeDefined()
    }
    await expect(
      readFile(resolve(root, 'packages/prime-runtime/python/managed-requirements.lock')),
    ).resolves.toBeInstanceOf(Buffer)
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

  it('ships the two full-parity patches plus the downstream-event prerequisite', async () => {
    const patches = await Promise.all(
      [
        '0001-persisted-child-reasoning-effort.patch',
        '0002-continuable-child-deletion.patch',
        '0003-public-ignorable-session-events.patch',
      ].map((name) => readFile(resolve(root, 'patches/deepseek-harness', name), 'utf8')),
    )
    expect(patches[0]).toContain('supportsContinuableReasoningEffort')
    expect(patches[0]).toContain('resolveModelInfo')
    expect(patches[1]).toContain('deleteContinuable')
    expect(patches[1]).toContain("'subagent/deleted'")
    expect(patches[2]).toContain('appendIgnorable')
  })
})
