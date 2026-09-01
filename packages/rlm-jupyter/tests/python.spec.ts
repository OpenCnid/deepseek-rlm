import { cp, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePythonRuntimeAssets } from '@deepseek-rlm/dsh-rlm-prime-runtime'
import { stagePythonRuntimeAssets } from '../src/python.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed Python runtime staging', () => {
  it('copies build projects out of a pnpm virtual-store path containing plus signs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-python-stage-'))
    roots.push(root)
    const source = await resolvePythonRuntimeAssets()
    const hostile = join(
      root,
      'node_modules',
      '.pnpm',
      '@deepseek-rlm+dsh-rlm-prime_hash',
      'node_modules',
      '@deepseek-rlm',
      'dsh-rlm-prime-runtime',
      'python',
    )
    const assets = {
      primeRuntime: join(hostile, 'prime-agent-runtime'),
      dshRuntime: join(hostile, 'dsh-rlm-runtime'),
      requirementsLock: join(hostile, 'managed-requirements.lock'),
    }
    await mkdir(hostile, { recursive: true })
    await Promise.all([
      cp(source.primeRuntime, assets.primeRuntime, { recursive: true }),
      cp(source.dshRuntime, assets.dshRuntime, { recursive: true }),
      copyFile(source.requirementsLock, assets.requirementsLock),
    ])

    const staged = await stagePythonRuntimeAssets(assets, join(root, 'runtime-sources'))

    expect(staged.primeRuntime).not.toContain('.pnpm')
    expect(staged.dshRuntime).not.toContain('+')
    await expect(readFile(join(staged.primeRuntime, 'pyproject.toml'), 'utf8')).resolves.toContain(
      '[project]',
    )
    await expect(readFile(join(staged.dshRuntime, 'pyproject.toml'), 'utf8')).resolves.toContain(
      '[project]',
    )
    await expect(readFile(staged.requirementsLock, 'utf8')).resolves.toContain('ipykernel==')
  })
})
