import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface PackageManifest {
  readonly name: string
  readonly main?: string
  readonly types?: string
  readonly license?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

const root = resolve(import.meta.dirname, '..')
const packageDirs = ['rlm', 'prime-runtime', 'rlm-jupyter', 'tool-ipython', 'bundle']
for (const directory of packageDirs) {
  const packageRoot = resolve(root, 'packages', directory)
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
  ) as PackageManifest
  if (manifest.license !== 'MIT') throw new Error(`${manifest.name} must declare MIT`)
  if (manifest.main !== undefined) await access(resolve(packageRoot, manifest.main))
  if (manifest.types !== undefined) await access(resolve(packageRoot, manifest.types))
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  })) {
    if (name.startsWith('@deepseek-ai/dsh-') && version !== '0.1.0-rc.7') {
      throw new Error(`${manifest.name}: ${name} must be 0.1.0-rc.7`)
    }
  }
}

const bundle = JSON.parse(
  await readFile(resolve(root, 'packages/bundle/package.json'), 'utf8'),
) as PackageManifest
const patch = await readFile(resolve(root, 'packages/bundle/dsh.bundle.patch'), 'utf8')
for (const name of [
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-rlm/dsh-rlm-jupyter',
  '@deepseek-rlm/dsh-tool-ipython',
]) {
  if (!patch.includes(`name: '${name}'`)) throw new Error(`bundle patch does not mount ${name}`)
  if (bundle.dependencies?.[name] === undefined) throw new Error(`bundle does not declare ${name}`)
}
console.log(`package check ok: ${packageDirs.length} packages and bundle closure`)
