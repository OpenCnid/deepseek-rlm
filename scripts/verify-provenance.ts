import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'

interface VendorManifest {
  readonly revision: string
  readonly localChanges: boolean
  readonly files: Readonly<Record<string, string>>
}

const root = resolve(import.meta.dirname, '..')
const expectedDshRevision = 'dd6322d604e00eec1ba5e0c8541159906a21094a'
const expectedPrimeRevision = 'f8f0036cc2da1a640aad990ae8dcb7c4820ce32e'
const expectedDshVersion = '0.1.2-alpha.3'

function parseJson<T>(text: string, path: string): T {
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error })
  }
}

async function filesBelow(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (
        entry.name === '.venv' ||
        entry.name === '.pytest_cache' ||
        entry.name === '__pycache__' ||
        entry.name.endsWith('.pyc')
      ) {
        return []
      }
      const child = resolve(path, entry.name)
      return entry.isDirectory() ? filesBelow(child) : [child]
    }),
  )
  return nested.flat()
}

function workspacePath(path: string): string {
  return relative(root, path).split(sep).join('/')
}

const upstreamPath = resolve(root, 'provenance/upstreams.json')
const upstreams = parseJson<{
  upstreams: Array<{ name: string; revision: string }>
  adaptedFiles: Array<{ local: string; revision: string; localChanges: boolean }>
}>(await readFile(upstreamPath, 'utf8'), workspacePath(upstreamPath))

const dsh = upstreams.upstreams.find((entry) => entry.name === 'DeepSeek Harness')
const prime = upstreams.upstreams.find((entry) => entry.name === 'Prime Agent')
if (dsh?.revision !== expectedDshRevision)
  throw new Error('DeepSeek Harness provenance pin drifted')
if (prime?.revision !== expectedPrimeRevision) throw new Error('Prime Agent provenance pin drifted')
for (const adapted of upstreams.adaptedFiles) {
  if (!adapted.localChanges) throw new Error(`${adapted.local} must record localChanges=true`)
  if (adapted.revision !== expectedPrimeRevision)
    throw new Error(`${adapted.local} has the wrong Prime revision`)
  await readFile(resolve(root, adapted.local))
}

const vendorPath = resolve(root, 'provenance/vendor-files.json')
const vendor = parseJson<VendorManifest>(
  await readFile(vendorPath, 'utf8'),
  workspacePath(vendorPath),
)
if (vendor.revision !== expectedPrimeRevision || vendor.localChanges) {
  throw new Error('vendored Prime runtime provenance is not the exact unmodified pin')
}
const actualVendorFiles = (await filesBelow(resolve(root, 'vendor/prime-agent-runtime')))
  .map(workspacePath)
  .sort()
const expectedVendorFiles = Object.keys(vendor.files).sort()
if (JSON.stringify(actualVendorFiles) !== JSON.stringify(expectedVendorFiles)) {
  throw new Error('vendored Prime runtime file set differs from provenance/vendor-files.json')
}
for (const path of actualVendorFiles) {
  const bytes = await readFile(resolve(root, path))
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== vendor.files[path]) throw new Error(`${path} differs from the pinned Prime source`)
}

const rootPackage = parseJson<{
  devDependencies: Record<string, string>
}>(await readFile(resolve(root, 'package.json'), 'utf8'), 'package.json')
for (const [name, version] of Object.entries(rootPackage.devDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-') && version !== expectedDshVersion) {
    throw new Error(`${name} must be pinned exactly to ${expectedDshVersion}; found ${version}`)
  }
  if (/^(?:git\+|https?:).*#(?![0-9a-f]{40}$)/u.test(version)) {
    throw new Error(`${name} uses an unpinned Git dependency`)
  }
}

console.log(
  `provenance ok: DSH ${expectedDshRevision}, Prime ${expectedPrimeRevision}, ${actualVendorFiles.length} vendored files`,
)
