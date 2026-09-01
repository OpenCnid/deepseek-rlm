import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const revision = 'dd6322d604e00eec1ba5e0c8541159906a21094a'
const names = [
  '0002-continuable-child-deletion.patch',
  '0003-public-ignorable-session-events.patch',
  '0004-pi-ai-agent-session-cleanup.patch',
  '0005-bounded-process-shutdown.patch',
]
const paths = names.map((name) => resolve(root, 'patches/deepseek-harness', name))

for (const path of paths) {
  const content = await readFile(path, 'utf8')
  if (!content.startsWith('diff --git ')) throw new Error(`${path} is not a unified Git patch`)
  if (content.includes('\r')) throw new Error(`${path} must use reproducible LF line endings`)
}

const source = process.env.DSH_SOURCE
if (source !== undefined) {
  const sourceRoot = resolve(source)
  const { stdout } = await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'])
  if (stdout.trim() !== revision) throw new Error(`DSH_SOURCE must be at ${revision}`)
  const worktree = await mkdtemp(resolve(tmpdir(), 'dsh-rlm-patch-check-'))
  await rm(worktree, { recursive: true, force: true })
  try {
    await execFileAsync('git', [
      '-C',
      sourceRoot,
      'worktree',
      'add',
      '--detach',
      worktree,
      revision,
    ])
    for (const patch of paths)
      await execFileAsync('git', ['-C', worktree, 'apply', '--check', patch])
    for (const patch of paths) await execFileAsync('git', ['-C', worktree, 'apply', patch])
    await execFileAsync('git', ['-C', worktree, 'diff', '--check'])
  } finally {
    await execFileAsync('git', ['-C', sourceRoot, 'worktree', 'remove', '--force', worktree]).catch(
      () => undefined,
    )
    await rm(worktree, { recursive: true, force: true })
  }
}

console.log(
  `DSH patch series ok: ${names.length} patches against ${revision}${source === undefined ? ' (static)' : ''}`,
)
