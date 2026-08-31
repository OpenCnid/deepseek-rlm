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
    if (name.startsWith('@deepseek-ai/dsh-') && version !== '0.1.2-alpha.3') {
      throw new Error(`${manifest.name}: ${name} must be 0.1.2-alpha.3`)
    }
  }
}

const bundle = JSON.parse(
  await readFile(resolve(root, 'packages/bundle/package.json'), 'utf8'),
) as PackageManifest
const patch = await readFile(resolve(root, 'packages/bundle/dsh.bundle.patch'), 'utf8')
for (const name of [
  '@deepseek-rlm/dsh-rlm-bundle/spawn-provider',
  '@deepseek-rlm/dsh-rlm-jupyter',
  '@deepseek-rlm/dsh-tool-ipython',
]) {
  if (!patch.includes(`name: '${name}'`)) throw new Error(`bundle patch does not mount ${name}`)
}
for (const dependency of ['@deepseek-rlm/dsh-rlm-jupyter', '@deepseek-rlm/dsh-tool-ipython']) {
  if (bundle.dependencies?.[dependency] === undefined)
    throw new Error(`bundle does not declare ${dependency}`)
}
for (const dependency of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
]) {
  if (bundle.peerDependencies?.[dependency] === undefined)
    throw new Error(`bundle does not declare host peer ${dependency}`)
  if (bundle.dependencies?.[dependency] !== undefined)
    throw new Error(
      `bundle must not shadow the DSH installation with host dependency ${dependency}`,
    )
}
if (!patch.includes('inject: [rlmSpawnReady]'))
  throw new Error('bundle Jupyter row does not inject rlmSpawnReady')
console.log(`package check ok: ${packageDirs.length} packages and bundle closure`)
