/** Prime-compatible transformation for configured IPython `%%bash` cells. */

const bashCellPattern = /^((?:[ \t]*\r?\n)*)([ \t]*)%%bash\b([^\r\n]*)(\r?\n|$)/u

interface BashCell {
  readonly leadingWhitespace: string
  readonly indent: string
  readonly magicArguments: string
  readonly lineBreak: string
  readonly body: string
}

function parseBashCell(code: string): BashCell | undefined {
  const match = bashCellPattern.exec(code)
  if (match === null) return undefined
  return {
    leadingWhitespace: match[1] ?? '',
    indent: match[2] ?? '',
    magicArguments: match[3] ?? '',
    lineBreak: match[4] ?? '',
    body: code.slice(match[0].length),
  }
}

function quoteMagicArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`
}

/** Apply a shell override and/or prefix only to a leading `%%bash` cell magic. */
export function applyShellSettings(
  code: string,
  options: {
    readonly commandPrefix?: string
    readonly shellPath?: string
    readonly requireExplicitShell?: boolean
  },
): string {
  const cell = parseBashCell(code)
  if (
    cell !== undefined &&
    options.requireExplicitShell === true &&
    options.shellPath === undefined
  ) {
    throw new Error('%%bash on Windows requires an absolute shellPath (for example Git Bash)')
  }
  if (options.commandPrefix === undefined && options.shellPath === undefined) return code
  if (cell === undefined) return code
  const firstLine =
    options.shellPath !== undefined && cell.magicArguments.trim().length === 0
      ? `${cell.indent}%%script ${quoteMagicArgument(options.shellPath)}`
      : `${cell.indent}%%bash${cell.magicArguments}`
  const body =
    options.commandPrefix === undefined
      ? cell.body
      : `${options.commandPrefix}${cell.body.length === 0 ? '' : `\n${cell.body}`}`
  return `${cell.leadingWhitespace}${firstLine}${cell.lineBreak || '\n'}${body}`
}
