/**
 * Jupyter v5 framing adapted from Prime Agent at
 * f8f0036cc2da1a640aad990ae8dcb7c4820ce32e. Local changes verify inbound HMAC,
 * expose deterministic test helpers, and keep connection metadata loopback-only.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

const delimiter = Buffer.from('<IDS|MSG>')
const protocolVersion = '5.3'

/** Loopback-only Jupyter connection metadata. */
export interface JupyterConnectionInfo {
  readonly ip: '127.0.0.1'
  readonly transport: 'tcp'
  readonly shell_port: number
  readonly iopub_port: number
  readonly stdin_port: number
  readonly control_port: number
  readonly hb_port: number
  readonly signature_scheme: 'hmac-sha256'
  readonly key: string
  readonly kernel_name: 'python3'
}

/** JSON fields carried by one Jupyter wire message. */
export interface JupyterMessage {
  readonly header: {
    readonly msg_id: string
    readonly session: string
    readonly username: string
    readonly date: string
    readonly msg_type: string
    readonly version: string
  }
  readonly parent_header: Readonly<Record<string, unknown>>
  readonly metadata: Readonly<Record<string, unknown>>
  readonly content: Readonly<Record<string, unknown>>
}

/** Create a unique connection record whose ports ipykernel will fill. */
export function createConnectionInfo(): JupyterConnectionInfo {
  return {
    ip: '127.0.0.1',
    transport: 'tcp',
    shell_port: 0,
    iopub_port: 0,
    stdin_port: 0,
    control_port: 0,
    hb_port: 0,
    signature_scheme: 'hmac-sha256',
    key: randomBytes(32).toString('hex'),
    kernel_name: 'python3',
  }
}

/** Validate a connection file read after ipykernel selected its ports. */
export function parseConnectionInfo(value: unknown): JupyterConnectionInfo | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.ip !== '127.0.0.1' ||
    value.transport !== 'tcp' ||
    value.signature_scheme !== 'hmac-sha256' ||
    typeof value.key !== 'string' ||
    value.key.length === 0
  ) {
    return undefined
  }
  const ports = [
    value.shell_port,
    value.iopub_port,
    value.stdin_port,
    value.control_port,
    value.hb_port,
  ]
  if (ports.some((port) => !Number.isInteger(port) || (port as number) <= 0)) return undefined
  return {
    ip: value.ip,
    transport: value.transport,
    shell_port: value.shell_port as number,
    iopub_port: value.iopub_port as number,
    stdin_port: value.stdin_port as number,
    control_port: value.control_port as number,
    hb_port: value.hb_port as number,
    signature_scheme: value.signature_scheme,
    key: value.key,
    kernel_name: 'python3',
  }
}

/** Build a host-originated request with a fresh message id. */
export function createMessage(
  type: string,
  content: Readonly<Record<string, unknown>>,
  session: string,
  username = 'deepseek-rlm',
): JupyterMessage {
  return {
    header: {
      msg_id: randomUUID(),
      session,
      username,
      date: new Date().toISOString(),
      msg_type: type,
      version: protocolVersion,
    },
    parent_header: {},
    metadata: {},
    content,
  }
}

function signature(parts: readonly Buffer[], key: string): Buffer {
  const hmac = createHmac('sha256', key)
  for (const part of parts) hmac.update(part)
  return Buffer.from(hmac.digest('hex'))
}

/** Encode and authenticate the four JSON frames of one Jupyter message. */
export function encodeMessage(message: JupyterMessage, key: string): Buffer[] {
  const parts = [
    Buffer.from(JSON.stringify(message.header)),
    Buffer.from(JSON.stringify(message.parent_header)),
    Buffer.from(JSON.stringify(message.metadata)),
    Buffer.from(JSON.stringify(message.content)),
  ]
  return [delimiter, signature(parts, key), ...parts]
}

/** Decode one authenticated multipart message; malformed or forged input is rejected. */
export function decodeMessage(
  incomingFrames: readonly Uint8Array[],
  key: string,
): JupyterMessage | undefined {
  const frames = incomingFrames.map((frame) => Buffer.from(frame))
  const delimiterIndex = frames.findIndex((frame) => frame.equals(delimiter))
  if (delimiterIndex < 0 || delimiterIndex + 5 >= frames.length) return undefined
  const sentSignature = frames[delimiterIndex + 1]
  const parts = frames.slice(delimiterIndex + 2, delimiterIndex + 6)
  if (sentSignature === undefined || parts.length !== 4) return undefined
  const expected = signature(parts, key)
  if (sentSignature.length !== expected.length || !timingSafeEqual(sentSignature, expected)) {
    return undefined
  }
  try {
    const header = JSON.parse(parts[0]!.toString()) as unknown
    const parentHeader = JSON.parse(parts[1]!.toString()) as unknown
    const metadata = JSON.parse(parts[2]!.toString()) as unknown
    const content = JSON.parse(parts[3]!.toString()) as unknown
    if (!isRecord(header) || !isRecord(parentHeader) || !isRecord(metadata) || !isRecord(content)) {
      return undefined
    }
    if (
      typeof header.msg_id !== 'string' ||
      typeof header.session !== 'string' ||
      typeof header.username !== 'string' ||
      typeof header.date !== 'string' ||
      typeof header.msg_type !== 'string' ||
      typeof header.version !== 'string'
    ) {
      return undefined
    }
    return {
      header: {
        msg_id: header.msg_id,
        session: header.session,
        username: header.username,
        date: header.date,
        msg_type: header.msg_type,
        version: header.version,
      },
      parent_header: parentHeader,
      metadata,
      content,
    }
  } catch {
    return undefined
  }
}

/** Narrow one wire value to a plain non-array record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
