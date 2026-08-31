interface ByteBudgetAcceptance {
  readonly text: string
  readonly reportTruncation: boolean
}

/** Shared UTF-8 byte budget for every rendered channel of one cell. */
export class ByteBudget {
  private remainingBytes: number
  private truncationReported = false

  constructor(readonly maximumBytes: number) {
    this.remainingBytes = maximumBytes
  }

  take(text: string): ByteBudgetAcceptance {
    if (text.length === 0) return { text: '', reportTruncation: false }
    const bytes = Buffer.from(text)
    if (bytes.length <= this.remainingBytes) {
      this.remainingBytes -= bytes.length
      return { text, reportTruncation: false }
    }
    let accepted = bytes.subarray(0, Math.max(0, this.remainingBytes)).toString('utf8')
    if (accepted.endsWith('\uFFFD')) accepted = accepted.slice(0, -1)
    this.remainingBytes -= Buffer.byteLength(accepted)
    const reportTruncation = !this.truncationReported
    this.truncationReported = true
    return { text: accepted, reportTruncation }
  }
}

/** Append-only UTF-8 byte-capped text accumulator. */
export class ByteAccumulator {
  private value = ''
  private usedBytes = 0
  private truncated = false
  private readonly budget: ByteBudget

  constructor(maximumBytesOrBudget: number | ByteBudget) {
    this.budget =
      typeof maximumBytesOrBudget === 'number'
        ? new ByteBudget(maximumBytesOrBudget)
        : maximumBytesOrBudget
  }

  /** Append as much complete UTF-8 text as fits and return the accepted fragment. */
  append(text: string): string {
    if (this.truncated || text.length === 0) return ''
    const { text: accepted, reportTruncation } = this.budget.take(text)
    this.value += accepted
    this.usedBytes += Buffer.byteLength(accepted)
    this.truncated = reportTruncation
    return accepted
  }

  /** Render the retained text with an explicit truncation diagnostic. */
  render(): string {
    return this.truncated
      ? `${this.value}\n[... output truncated at ${this.budget.maximumBytes} bytes ...]`
      : this.value
  }

  /** Retained UTF-8 bytes, excluding the diagnostic. */
  get bytes(): number {
    return this.usedBytes
  }
}
