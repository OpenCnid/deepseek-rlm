import { describe, expect, it } from 'vitest'
import { applyShellSettings } from '../src/shell.js'

describe('configured %%bash cells', () => {
  it('leaves Python and explicitly parameterized bash magics unchanged', () => {
    expect(applyShellSettings('x = 41', { commandPrefix: 'set -e' })).toBe('x = 41')
    expect(applyShellSettings('%%bash -s value\necho "$1"', { shellPath: '/bin/zsh' })).toBe(
      '%%bash -s value\necho "$1"',
    )
  })

  it('selects the configured shell and prepends the configured command', () => {
    expect(
      applyShellSettings('%%bash\necho ready', {
        shellPath: 'C:/Program Files/Git/bin/bash.exe',
        commandPrefix: 'set -euo pipefail',
      }),
    ).toBe("%%script 'C:/Program Files/Git/bin/bash.exe'\nset -euo pipefail\necho ready")
  })

  it('fails explanatorily when Windows has no configured bash strategy', () => {
    expect(() => applyShellSettings('%%bash\necho ready', { requireExplicitShell: true })).toThrow(
      /requires an absolute shellPath/u,
    )
  })
})
