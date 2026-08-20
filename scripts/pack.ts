import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const destination = resolve(root, 'artifacts/packages')
const packages = ['rlm', 'prime-runtime', 'rlm-jupyter', 'tool-ipython', 'bundle']
const pnpm = process.env.npm_execpath
if (pnpm === undefined) throw new Error('package:bundle must run through pnpm')

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
for (const directory of packages) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [pnpm, 'pack', '--pack-destination', destination],
    { cwd: resolve(root, 'packages', directory) },
  )
  process.stdout.write(stdout)
}
console.log(`packed ${packages.length} packages into ${destination}`)
