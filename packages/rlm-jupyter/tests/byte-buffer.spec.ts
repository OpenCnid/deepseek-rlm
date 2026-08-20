import { describe, expect, it } from 'vitest'
import { ByteAccumulator } from '../src/byte-buffer.js'

describe('ByteAccumulator', () => {
  it('caps complete Unicode by UTF-8 bytes', () => {
    const output = new ByteAccumulator(5)
    expect(output.append('a😀z')).toBe('a😀')
    expect(output.append('later')).toBe('')
    expect(output.bytes).toBe(5)
    expect(output.render()).toContain('truncated at 5 bytes')
  })
})
