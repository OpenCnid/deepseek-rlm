import { describe, expect, it } from 'vitest'
import {
  createConnectionInfo,
  createMessage,
  decodeMessage,
  encodeMessage,
  parseConnectionInfo,
} from '../src/protocol.js'

describe('Jupyter protocol', () => {
  it('round-trips authenticated frames', () => {
    const key = 'test-key'
    const message = createMessage('execute_request', { code: 'x = 41' }, 'session')
    expect(decodeMessage(encodeMessage(message, key), key)).toEqual(message)
  })

  it('rejects a forged content frame', () => {
    const frames = encodeMessage(createMessage('execute_request', { code: 'safe' }, 's'), 'key')
    frames[5] = Buffer.from('{"code":"forged"}')
    expect(decodeMessage(frames, 'key')).toBeUndefined()
  })

  it('creates a unique non-empty key and accepts only resolved loopback ports', () => {
    const first = createConnectionInfo()
    const second = createConnectionInfo()
    expect(first.key).not.toBe(second.key)
    expect(first.ip).toBe('127.0.0.1')
    expect(parseConnectionInfo(first)).toBeUndefined()
    expect(
      parseConnectionInfo({
        ...first,
        shell_port: 1,
        iopub_port: 2,
        stdin_port: 3,
        control_port: 4,
        hb_port: 5,
      }),
    ).toBeDefined()
    expect(parseConnectionInfo({ ...first, ip: '0.0.0.0' })).toBeUndefined()
  })
})
