import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const target = resolve(root, 'packages/prime-runtime/python')
const isRuntimeAsset = (path: string): boolean =>
  !path.includes(`${sep}.venv${sep}`) &&
  !path.endsWith(`${sep}.venv`) &&
  !path.includes(`${sep}.pytest_cache${sep}`) &&
  !path.endsWith(`${sep}.pytest_cache`) &&
  !path.includes(`${sep}__pycache__${sep}`) &&
  !path.endsWith(`${sep}__pycache__`) &&
  !path.includes(`${sep}test${sep}`) &&
  !path.endsWith(`${sep}test`) &&
  !path.includes(`${sep}tests${sep}`) &&
  !path.endsWith(`${sep}tests`) &&
  !path.endsWith('.pyc')

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(resolve(root, 'vendor/prime-agent-runtime'), resolve(target, 'prime-agent-runtime'), {
  recursive: true,
  filter: isRuntimeAsset,
})
await cp(resolve(root, 'python/dsh-rlm-runtime'), resolve(target, 'dsh-rlm-runtime'), {
  recursive: true,
  filter: isRuntimeAsset,
})
await cp(
  resolve(root, 'python/managed-requirements.lock'),
  resolve(target, 'managed-requirements.lock'),
)
