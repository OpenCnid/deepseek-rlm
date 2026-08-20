import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { kernelEnvironment, resolveConfig } from '../src/config.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rootsForTest(): { artifactRoot: string; managedRuntimeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-config-'))
  roots.push(root)
  return {
    artifactRoot: join(root, 'artifacts'),
    managedRuntimeRoot: join(root, 'runtime'),
  }
}

describe('Jupyter RLM configuration', () => {
  it('rejects unsafe numbers, relative executables, owned env, and duplicate allowlist entries', () => {
    const paths = rootsForTest()
    expect(() => resolveConfig({ ...paths, maxOutputBytes: 0 })).toThrow(/maxOutputBytes/u)
    expect(() => resolveConfig({ ...paths, python: 'python' })).toThrow(/absolute path/u)
    expect(() => resolveConfig({ ...paths, env: { RLM_DEPTH: '99' } })).toThrow(/RLM-owned/u)
    expect(() => resolveConfig({ ...paths, envAllowlist: ['TEMP', 'TEMP'] })).toThrow(/duplicate/u)
  })

  it('copies only explicit values and allowlisted ambient variables', () => {
    const paths = rootsForTest()
    const variable = `DSH_RLM_TEST_${process.pid}`
    process.env[variable] = 'allowed'
    try {
      const config = resolveConfig({ ...paths, env: { EXPLICIT: 'yes' }, envAllowlist: [variable] })
      expect(kernelEnvironment(config)).toEqual({ EXPLICIT: 'yes', [variable]: 'allowed' })
    } finally {
      delete process.env[variable]
    }
  })
})
