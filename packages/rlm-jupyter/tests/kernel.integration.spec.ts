import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/kernel.js'
import { resolveKernelPython } from '../src/python.js'
import {
  buildRestoreCode,
  buildSnapshotCode,
  manifestPathIn,
  parseSnapshotCapture,
  parseSnapshotRestore,
  snapshotPathIn,
} from '../src/snapshot.js'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function manager(python: string, cwd: string, sessionId: string): Promise<KernelManager> {
  let kernel!: KernelManager
  kernel = new KernelManager({
    python,
    cwd,
    env: {
      PATH: `${dirname(python)}${delimiter}${process.env.PATH ?? ''}`,
      PYTHONNOUSERSITE: '1',
      JUPYTER_PLATFORM_DIRS: '1',
      RLM_SESSION_DIR: cwd,
      RLM_HARNESS_STATE_DIR: join(cwd, 'harness'),
      RLM_DEPTH: '0',
      RLM_MAX_DEPTH: '1',
    },
    sessionId,
    generation: 1,
    interruptGraceMs: 1_000,
    shutdownGraceMs: 2_000,
    hostRequestDrainMs: 1_000,
    isGenerationCurrent: () => true,
    dispatchHostRequest: () => Promise.resolve({}),
    onPhase: () => undefined,
  })
  await kernel.start()
  return kernel
}

describe('real persistent Jupyter transport', () => {
  it('retains one namespace, isolates another, and removes connection artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-integration-'))
    roots.push(root)
    const python = await resolveKernelPython({
      managedRuntimeRoot: resolve('.dsh-rlm/test-runtime'),
      probeEnvironment: {},
    })
    const firstDir = join(root, 'first')
    const secondDir = join(root, 'second')
    await Promise.all([
      import('node:fs/promises').then(({ mkdir }) => mkdir(firstDir, { recursive: true })),
      import('node:fs/promises').then(({ mkdir }) => mkdir(secondDir, { recursive: true })),
    ])
    const first = await manager(python, firstDir, 'first')
    const second = await manager(python, secondDir, 'second')
    const connection = first.connectionPath
    try {
      expect(await first.execute('x = 41', { maxOutputBytes: 1024 * 1024 })).toMatchObject({
        status: 'ok',
      })
      expect(await first.execute('x + 1', { maxOutputBytes: 1024 * 1024 })).toMatchObject({
        status: 'ok',
        result: '42',
      })
      expect(
        await second.execute("'x' in globals()", { maxOutputBytes: 1024 * 1024 }),
      ).toMatchObject({ status: 'ok', result: 'False' })
      expect(
        await first.execute("raise ValueError('bad value')", { maxOutputBytes: 1024 * 1024 }),
      ).toMatchObject({
        status: 'error',
        error: { name: 'ValueError', message: 'bad value' },
      })
      const controller = new AbortController()
      const interrupted = first.execute('import time; time.sleep(30)', {
        maxOutputBytes: 1024 * 1024,
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 100)
      const cancelled = await interrupted
      expect(cancelled).toMatchObject({ status: 'aborted' })
      if (cancelled.kernelRestarted) {
        expect(first.isRunning).toBe(false)
      } else {
        expect(await first.execute('x + 1', { maxOutputBytes: 1024 * 1024 })).toMatchObject({
          status: 'ok',
          result: '42',
        })
      }
    } finally {
      await Promise.all([first.dispose(), second.dispose()])
    }
    expect(connection).toBeDefined()
    await expect(access(connection!)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  it('restores a dill snapshot without replaying the side-effecting historical cell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-restore-'))
    roots.push(root)
    const python = await resolveKernelPython({
      managedRuntimeRoot: resolve('.dsh-rlm/test-runtime'),
      probeEnvironment: {},
    })
    const session = join(root, 'session')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(session, { recursive: true }))
    const sideEffect = join(session, 'side-effect.txt')
    const payload = snapshotPathIn(session)
    const manifest = manifestPathIn(session)
    const first = await manager(python, session, 'snapshot-first')
    try {
      const historical = `
from pathlib import Path
_p = Path(${JSON.stringify(sideEffect)})
_p.write_text(str(int(_p.read_text()) + 1) if _p.exists() else "1")
x = 41
`.trim()
      expect(await first.execute(historical, { maxOutputBytes: 1024 * 1024 })).toMatchObject({
        status: 'ok',
      })
      const captured = await first.execute(
        buildSnapshotCode(payload, manifest, 16 * 1024 * 1024, 4 * 1024 * 1024, 'test'),
        { maxOutputBytes: 1024 * 1024, internal: true },
      )
      expect(parseSnapshotCapture(captured.stdout)).toMatchObject({
        saved: expect.arrayContaining(['x']),
      })
    } finally {
      await first.dispose()
    }

    const resumed = await manager(python, session, 'snapshot-resumed')
    try {
      const restored = await resumed.execute(buildRestoreCode(payload), {
        maxOutputBytes: 1024 * 1024,
        internal: true,
      })
      expect(parseSnapshotRestore(restored.stdout)).toMatchObject({
        restored: expect.arrayContaining(['x']),
      })
      expect(await resumed.execute('x + 1', { maxOutputBytes: 1024 * 1024 })).toMatchObject({
        status: 'ok',
        result: '42',
      })
      const count = await import('node:fs/promises').then(({ readFile }) =>
        readFile(sideEffect, 'utf8'),
      )
      expect(count).toBe('1')
    } finally {
      await resumed.dispose()
    }
  }, 60_000)

  it('settles an active cell and removes its process resources during disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-dispose-'))
    roots.push(root)
    const python = await resolveKernelPython({
      managedRuntimeRoot: resolve('.dsh-rlm/test-runtime'),
      probeEnvironment: {},
    })
    const session = join(root, 'session')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(session, { recursive: true }))
    const kernel = await manager(python, session, 'dispose-active')
    const connection = kernel.connectionPath!
    const active = kernel.execute('import time; time.sleep(30)', { maxOutputBytes: 1024 })
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100))
    await kernel.dispose()
    await expect(active).resolves.toMatchObject({ status: 'aborted', kernelRestarted: true })
    await expect(access(connection)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)
})
