/**
 * Autorización explícita por uso (SPEC-AUTH-0001, DEC-0099): digests canónicos.
 *
 * Apto para el navegador (sin `node:crypto`). Replica byte a byte a
 * `rust/fhs/src/authorization.rs`; ambos se prueban con los fixtures
 * compartidos de `galaxIA/idl/fixtures/authorization-digests.json`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { AuthorizationItem, DynamicValue } from "./generated/fhs-protocol_pb.js";

export const DIGEST_VERSION = "1";

export const DOMAIN_USER_MESSAGE = "fhs/auth/user_message";
export const DOMAIN_DOCUMENT = "fhs/auth/document";
export const DOMAIN_DERIVED_TEXT = "fhs/auth/derived_text";
export const DOMAIN_COMMAND_ARGS = "fhs/auth/command_args";
export const DOMAIN_QUERY = "fhs/auth/query";
export const DOMAIN_TOOL_ARGS = "fhs/auth/tool_args";
export const DOMAIN_TOOL_OUTPUT = "fhs/auth/tool_output";
export const DOMAIN_IPFS = "fhs/auth/ipfs";
export const DOMAIN_BATCH = "fhs/auth/batch";

const encoder = new TextEncoder();

class Bytes {
  private parts: Uint8Array[] = [];
  byte(value: number): void {
    this.parts.push(Uint8Array.of(value));
  }
  raw(bytes: Uint8Array): void {
    this.parts.push(bytes);
  }
  len(value: number): void {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    this.parts.push(out);
  }
  bytes(bytes: Uint8Array): void {
    this.len(bytes.byteLength);
    this.parts.push(bytes);
  }
  text(value: string): void {
    this.bytes(encoder.encode(value));
  }
  done(): Uint8Array {
    const total = this.parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

/** `SHA-256(dominio ‖ 0x00 ‖ versión ‖ 0x00 ‖ cuerpo)`. */
export function framed(domain: string, body: Uint8Array): Uint8Array {
  const input = new Bytes();
  input.raw(encoder.encode(domain));
  input.byte(0);
  input.raw(encoder.encode(DIGEST_VERSION));
  input.byte(0);
  input.raw(body);
  return sha256(input.done());
}

/** Texto exacto en UTF-8, sin normalización Unicode adicional. */
export function textDigest(domain: string, text: string): Uint8Array {
  return framed(domain, encoder.encode(text));
}

export function userMessageDigest(text: string): Uint8Array {
  return textDigest(DOMAIN_USER_MESSAGE, text);
}

/** Los bytes reales de un archivo (no su descriptor). */
export function documentDigest(bytes: Uint8Array): Uint8Array {
  return framed(DOMAIN_DOCUMENT, bytes);
}

/** Un archivo subido a IPFS: el CID y el digest de los bytes del contenido. */
export function ipfsDigest(cid: string, content: Uint8Array): Uint8Array {
  const body = new Bytes();
  body.text(cid);
  body.bytes(documentDigest(content));
  return framed(DOMAIN_IPFS, body.done());
}

/** Un conjunto de fragmentos, en el orden en que se envían. */
export function chunksDigest(domain: string, chunks: readonly string[]): Uint8Array {
  const body = new Bytes();
  body.len(chunks.length);
  for (const chunk of chunks) body.text(chunk);
  return framed(domain, body.done());
}

function byteCompare(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** Forma canónica `cv1` de un valor dinámico (ver SPEC-AUTH-0001). */
export function encodeValue(value: DynamicValue, out: Bytes = new Bytes()): Bytes {
  const kind = value.kind;
  switch (kind.case) {
    case undefined:
      out.byte(0x00);
      break;
    case "booleanValue":
      out.byte(0x01);
      out.byte(kind.value ? 1 : 0);
      break;
    case "integerValue": {
      out.byte(0x02);
      const buffer = new Uint8Array(8);
      new DataView(buffer.buffer).setBigInt64(0, BigInt(kind.value), false);
      out.raw(buffer);
      break;
    }
    case "numberValue": {
      if (!Number.isFinite(kind.value)) throw new Error("número no finito");
      const normalized = kind.value === 0 ? 0 : kind.value;
      out.byte(0x03);
      const buffer = new Uint8Array(8);
      new DataView(buffer.buffer).setFloat64(0, normalized, false);
      out.raw(buffer);
      break;
    }
    case "stringValue":
      out.byte(0x04);
      out.text(kind.value);
      break;
    case "bytesValue":
      out.byte(0x05);
      out.bytes(kind.value);
      break;
    case "listValue":
      out.byte(0x06);
      out.len(kind.value.values.length);
      for (const item of kind.value.values) encodeValue(item, out);
      break;
    case "objectValue": {
      out.byte(0x07);
      const keys = Object.keys(kind.value.fields).sort(byteCompare);
      out.len(keys.length);
      for (const key of keys) {
        out.text(key);
        encodeValue(kind.value.fields[key], out);
      }
      break;
    }
    default:
      throw new Error("un archivo se autoriza por el digest de sus bytes, no dentro de argumentos");
  }
  return out;
}

/** Argumentos de herramienta o de comando (valores dinámicos). */
export function valueDigest(domain: string, value: DynamicValue): Uint8Array {
  return framed(domain, encodeValue(value).done());
}

export interface BatchFields {
  authorizationId: string;
  conversationId: string;
  turnId: string;
  expiresAt: bigint | number;
  items: readonly Pick<
    AuthorizationItem,
    "itemId" | "payloadDigest" | "providerDid" | "capabilityId" | "dataClass" | "destination" | "retention" | "dependsOn"
  >[];
}

/** Digest del lote: identifica exactamente lo que se le muestra al usuario. */
export function batchDigest(batch: BatchFields): Uint8Array {
  const body = new Bytes();
  body.text(batch.authorizationId);
  body.text(batch.conversationId);
  body.text(batch.turnId);
  body.text(String(batch.expiresAt));
  const items = [...batch.items].sort((a, b) => byteCompare(a.itemId, b.itemId));
  body.len(items.length);
  for (const item of items) {
    body.text(item.itemId);
    body.bytes(item.payloadDigest);
    body.text(item.providerDid);
    body.text(item.capabilityId);
    body.text(String(item.dataClass));
    body.text(String(item.destination));
    body.text(String(item.retention));
    const deps = [...item.dependsOn].sort(byteCompare);
    body.len(deps.length);
    for (const dep of deps) body.text(dep);
  }
  return framed(DOMAIN_BATCH, body.done());
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
