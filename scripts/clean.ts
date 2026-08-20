import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const targets = [
  'packages/rlm/lib',
  'packages/rlm-jupyter/lib',
  'packages/tool-ipython/lib',
  'packages/prime-runtime/lib',
  'packages/bundle/lib',
  'artifacts/packages',
]

for (const target of targets) await rm(resolve(root, target), { recursive: true, force: true })
