import { describe, expect, it } from 'vitest'
import { ByteAccumulator, ByteBudget } from '../src/byte-buffer.js'

describe('ByteAccumulator', () => {
  it('caps complete Unicode by UTF-8 bytes', () => {
    const output = new ByteAccumulator(5)
    expect(output.append('a😀z')).toBe('a😀')
    expect(output.append('later')).toBe('')
    expect(output.bytes).toBe(5)
    expect(output.render()).toContain('truncated at 5 bytes')
  })

  it('shares one aggregate cap across independently rendered channels', () => {
    const budget = new ByteBudget(7)
    const stdout = new ByteAccumulator(budget)
    const stderr = new ByteAccumulator(budget)
    const result = new ByteAccumulator(budget)

    expect(stdout.append('12345')).toBe('12345')
    expect(stderr.append('67890')).toBe('67')
    expect(result.append('later')).toBe('')
    expect(stdout.bytes + stderr.bytes + result.bytes).toBe(7)
    expect(stderr.render()).toContain('truncated at 7 bytes')
    expect(result.render()).toBe('')
  })
})
