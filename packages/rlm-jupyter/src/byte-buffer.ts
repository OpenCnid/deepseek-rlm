/** Append-only UTF-8 byte-capped text accumulator. */
export class ByteAccumulator {
  private value = ''
  private usedBytes = 0
  private truncated = false

  constructor(private readonly maximumBytes: number) {}

  /** Append as much complete UTF-8 text as fits and return the accepted fragment. */
  append(text: string): string {
    if (this.truncated || text.length === 0) return ''
    const available = this.maximumBytes - this.usedBytes
    const bytes = Buffer.from(text)
    if (bytes.length <= available) {
      this.value += text
      this.usedBytes += bytes.length
      return text
    }
    let accepted = bytes.subarray(0, Math.max(0, available)).toString('utf8')
    if (accepted.endsWith('\uFFFD')) accepted = accepted.slice(0, -1)
    this.value += accepted
    this.usedBytes += Buffer.byteLength(accepted)
    this.truncated = true
    return accepted
  }

  /** Render the retained text with an explicit truncation diagnostic. */
  render(): string {
    return this.truncated
      ? `${this.value}\n[... output truncated at ${this.maximumBytes} bytes ...]`
      : this.value
  }

  /** Retained UTF-8 bytes, excluding the diagnostic. */
  get bytes(): number {
    return this.usedBytes
  }
}
