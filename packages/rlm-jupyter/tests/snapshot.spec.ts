import { describe, expect, it } from 'vitest'
import {
  buildRestoreCode,
  buildSnapshotCode,
  parseSnapshotCapture,
  parseSnapshotRestore,
} from '../src/snapshot.js'

describe('snapshot helpers', () => {
  it('builds atomic digest-bearing code without historical replay', () => {
    const code = buildSnapshotCode('/tmp/state.dill', '/tmp/state.json', 100, 50, '1.0')
    expect(code).toContain('os.replace(payload_tmp')
    expect(code).toContain('hashlib.sha256')
    expect(code).toContain('aggregate = _Buffer(100)')
    expect(code).toContain('fh.write(encoded_payload)')
    expect(code).not.toContain('_b.str(_err)[:200]')
    expect(code).not.toContain('history')
    const restore = buildRestoreCode('/tmp/state.dill')
    expect(restore).toContain('for name, blob in payload.items()')
    expect(restore).not.toContain('_b.str(_err)[:200]')
  })

  it('parses marker results losslessly', () => {
    expect(
      parseSnapshotCapture(
        'noise\n__DSH_RLM_KERNEL_STATE__{"saved":["x"],"skipped":[{"name":"f","reason":"file"}],"bytes":7,"digest":"abc"}\n',
      ),
    ).toEqual({
      saved: ['x'],
      skipped: [{ name: 'f', reason: 'file' }],
      bytes: 7,
      digest: 'abc',
    })
    expect(parseSnapshotRestore('__DSH_RLM_KERNEL_STATE__{"restored":["x"],"failed":[]}')).toEqual({
      restored: ['x'],
      failed: [],
    })
  })
})
