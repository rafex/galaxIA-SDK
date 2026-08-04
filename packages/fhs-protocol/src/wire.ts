import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type Message,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  EnvelopeSchema,
  type Envelope,
} from "./generated/fhs-protocol_pb.js";

/**
 * Límite defensivo para un frame FHS antes de asignar memoria.
 * Este codec es el único punto de entrada del SDK para el wire Protobuf/LPP.
 */
export const MAX_FHS_FRAME_BYTES = 16 * 1024 * 1024;

export interface DecodedFrame {
  payload: Uint8Array;
  bytesConsumed: number;
}

export function encodeMessage<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): Uint8Array {
  return toBinary(schema, message);
}

export function decodeMessage<Desc extends DescMessage>(schema: Desc, bytes: Uint8Array): MessageShape<Desc> {
  return fromBinary(schema, bytes);
}

export function encodeEnvelope(envelope: Envelope): Uint8Array {
  return encodeMessage(EnvelopeSchema, envelope);
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  return decodeMessage(EnvelopeSchema, bytes);
}

/**
 * FHS LPP framing: varint con la longitud del Envelope seguido de sus bytes.
 * El framing no agrega JSON ni otro formato de aplicación.
 */
export function encodeLengthPrefixed(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_FHS_FRAME_BYTES) {
    throw new RangeError(`Frame FHS demasiado grande: ${payload.byteLength} bytes`);
  }

  const prefix = encodeVarint(payload.byteLength);
  const frame = new Uint8Array(prefix.byteLength + payload.byteLength);
  frame.set(prefix, 0);
  frame.set(payload, prefix.byteLength);
  return frame;
}

export function encodeEnvelopeFrame(envelope: Envelope): Uint8Array {
  return encodeLengthPrefixed(encodeEnvelope(envelope));
}

export function decodeLengthPrefixed(frame: Uint8Array): DecodedFrame {
  const { value: payloadLength, bytesConsumed: prefixLength } = decodeVarint(frame);
  if (payloadLength > MAX_FHS_FRAME_BYTES) {
    throw new RangeError(`Frame FHS demasiado grande: ${payloadLength} bytes`);
  }

  const frameLength = prefixLength + payloadLength;
  if (frame.byteLength < frameLength) {
    throw new Error(`Frame FHS incompleto: faltan ${frameLength - frame.byteLength} bytes`);
  }

  return {
    payload: frame.slice(prefixLength, frameLength),
    bytesConsumed: frameLength,
  };
}

export function decodeEnvelopeFrame(frame: Uint8Array): { envelope: Envelope; bytesConsumed: number } {
  const decoded = decodeLengthPrefixed(frame);
  return { envelope: decodeEnvelope(decoded.payload), bytesConsumed: decoded.bytesConsumed };
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining > 0 ? next | 0x80 : next);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

function decodeVarint(bytes: Uint8Array): { value: number; bytesConsumed: number } {
  let value = 0;
  let multiplier = 1;

  for (let index = 0; index < bytes.byteLength && index < 8; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, bytesConsumed: index + 1 };
    multiplier *= 128;
  }

  throw new Error("Varint LPP inválido o incompleto");
}

export function newEnvelope(fields: Partial<Envelope> = {}): Envelope {
  return create(EnvelopeSchema, {
    messageId: fields.messageId ?? crypto.randomUUID(),
    sourcePeerId: fields.sourcePeerId ?? "",
    destPeerId: fields.destPeerId ?? "",
    timestamp: fields.timestamp ?? BigInt(Date.now()),
    version: fields.version ?? "1",
    signature: fields.signature ?? new Uint8Array(),
    payload: fields.payload,
  });
}
