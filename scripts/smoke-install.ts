import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const packages = resolve(root, 'artifacts/packages')
const pnpm = process.env.npm_execpath
if (pnpm === undefined) throw new Error('package:smoke must run through pnpm')

const archives = {
  '@deepseek-rlm/dsh-rlm': 'deepseek-rlm-dsh-rlm-0.1.0-preview.0.tgz',
  '@deepseek-rlm/dsh-rlm-prime-runtime': 'deepseek-rlm-dsh-rlm-prime-runtime-0.1.0-preview.0.tgz',
  '@deepseek-rlm/dsh-rlm-jupyter': 'deepseek-rlm-dsh-rlm-jupyter-0.1.0-preview.0.tgz',
  '@deepseek-rlm/dsh-tool-ipython': 'deepseek-rlm-dsh-tool-ipython-0.1.0-preview.0.tgz',
  '@deepseek-rlm/dsh-rlm-bundle': 'deepseek-rlm-dsh-rlm-bundle-0.1.0-preview.0.tgz',
} as const

for (const archive of Object.values(archives)) await readFile(join(packages, archive))

const temporary = await mkdtemp(join(tmpdir(), 'deepseek-rlm-install-'))
try {
  const specifications = Object.fromEntries(
    Object.entries(archives).map(([name, archive]) => [name, `file:${join(packages, archive)}`]),
  )
  await writeFile(
    join(temporary, 'package.json'),
    `${JSON.stringify(
      {
        name: 'deepseek-rlm-install-smoke',
        private: true,
        type: 'module',
        dependencies: specifications,
        pnpm: { overrides: specifications },
      },
      null,
      2,
    )}\n`,
  )
  await execFileAsync(process.execPath, [pnpm, 'install', '--ignore-scripts'], {
    cwd: temporary,
    maxBuffer: 16 * 1024 * 1024,
  })
  await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        `await import('@deepseek-rlm/dsh-rlm')`,
        `await import('@deepseek-rlm/dsh-rlm-prime-runtime')`,
        `await import('@deepseek-rlm/dsh-rlm-jupyter')`,
        `await import('@deepseek-rlm/dsh-tool-ipython')`,
        `await import('@deepseek-rlm/dsh-rlm-bundle/spawn-provider')`,
        `const bundle = await import('@deepseek-rlm/dsh-rlm-bundle')`,
        `if (bundle.bundleVersion !== '0.1.0-preview.0') process.exit(1)`,
      ].join(';'),
    ],
    { cwd: temporary },
  )
  console.log('tarball install smoke ok: 5 packages imported from an isolated project')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
