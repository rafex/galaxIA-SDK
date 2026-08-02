/**
 * Identidad criptográfica de nodo (DEC-0004, DEC-0030) — Ed25519 real vía
 * `did:key` (método W3C), usando el módulo `crypto` nativo de Node (soporta
 * Ed25519 desde Node 12+, sin dependencias nuevas). El identificador del
 * nodo (`providerId`) ES la clave pública codificada — no requiere un
 * directorio de claves separado ni distribución previa.
 */

import { generateKeyPairSync, createPublicKey, createPrivateKey, createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Multicodec de Ed25519 public key (0xed) codificado como varint: [0xed, 0x01].
const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);
// SPKI DER de Ed25519: 12 bytes de header fijo + 32 bytes de clave pública cruda.
const SPKI_ED25519_HEADER = Buffer.from("302a300506032b6570032100", "hex");

export function base58Encode(bytes: Uint8Array): string {
  let value = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (value > 0n) {
    const remainder = value % 58n;
    out = BASE58_ALPHABET[Number(remainder)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) out = BASE58_ALPHABET[0] + out;
    else break;
  }
  return out;
}

export function base58Decode(str: string): Uint8Array {
  let value = 0n;
  for (const char of str) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Carácter base58 inválido: ${char}`);
    value = value * 58n + BigInt(index);
  }
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const bytes = Buffer.from(hex, "hex");
  let leadingZeros = 0;
  for (const char of str) {
    if (char === BASE58_ALPHABET[0]) leadingZeros++;
    else break;
  }
  return Uint8Array.from([...Buffer.alloc(leadingZeros), ...bytes]);
}

/** Deriva un `did:key:z...` a partir de una clave pública Ed25519 cruda (32 bytes). */
export function publicKeyToDid(rawPublicKey: Uint8Array): string {
  const prefixed = Uint8Array.from([...ED25519_MULTICODEC_PREFIX, ...rawPublicKey]);
  return `did:key:z${base58Encode(prefixed)}`;
}

/** Decodifica un `did:key:z...` de vuelta a la clave pública Ed25519 cruda (32 bytes). */
export function didToPublicKeyRaw(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) {
    throw new Error(`did:key inválido (esperaba prefijo "did:key:z"): ${did}`);
  }
  const decoded = base58Decode(did.slice("did:key:z".length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error(`did:key con multicodec inesperado (se esperaba Ed25519, 0xed01): ${did}`);
  }
  return decoded.slice(2);
}

function rawPublicKeyToKeyObject(rawPublicKey: Uint8Array): KeyObject {
  const der = Buffer.concat([SPKI_ED25519_HEADER, Buffer.from(rawPublicKey)]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export interface NodeIdentity {
  did: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
  /** PEM de la clave privada, para persistir en disco entre reinicios. */
  privateKeyPem: string;
}

/** Genera una identidad Ed25519 nueva — llamar solo una vez por nodo y persistir `privateKeyPem`. */
export function generateIdentity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  return {
    did: publicKeyToDid(rawPublicKey),
    publicKey,
    privateKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

/** Reconstruye una identidad ya generada a partir de su clave privada persistida (PEM). */
export function loadIdentity(privateKeyPem: string): NodeIdentity {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const rawPublicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  return { did: publicKeyToDid(rawPublicKey), publicKey, privateKey, privateKeyPem };
}

/**
 * Serialización JSON canónica (llaves ordenadas recursivamente, sin espacios)
 * — necesaria para que dos implementaciones calculen el mismo hash del mismo
 * manifiesto sin importar el orden de inserción de llaves de su lenguaje.
 * Los `undefined` se omiten (igual que `JSON.stringify`).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/** SHA-256 (hex) de la forma canónica de un objeto — usado para anclar el manifiesto a la firma de `register`. */
export function sha256CanonicalHex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// ── Payloads de firma estandarizados (revisión del protocolo, 2026-07-10) ──
// Cualquier implementación (TS, Python, Rust...) debe construir exactamente
// estas cadenas antes de firmar/verificar. `timestamp` siempre en ms.

/** Payload de `hello`: prueba posesión de la clave del `providerId`. */
export function helloSignaturePayload(providerId: string, timestamp: number): string {
  return `${providerId}:${timestamp}`;
}

/**
 * Payload de `register`: además de identidad y frescura, ancla el contenido
 * del manifiesto — sin el hash, un MITM podía sustituir el manifiesto entero
 * (endpoint incluido) conservando una firma válida.
 */
export function registerSignaturePayload(providerId: string, timestamp: number, manifest: unknown): string {
  return `${providerId}:${timestamp}:${sha256CanonicalHex(manifest)}`;
}

/**
 * Payload de `welcome`: el Registry (Atlas) también se autentica — su
 * `registryId` es un did:key propio y firma su saludo, para que un nodo no
 * entregue su manifiesto a un Atlas impostor en la misma LAN.
 */
export function welcomeSignaturePayload(registryId: string, timestamp: number): string {
  return `${registryId}:${timestamp}`;
}

/**
 * Payload de invocación (`chat.request`/`tool.call`/`tool.list`): el
 * invocador (Navigator u otro agente) prueba su identidad ante el provider —
 * sin esto, cualquier peer de la LAN podía consumir el LLM/tools de un nodo.
 */
export function invokeSignaturePayload(callerId: string, missionId: string, timestamp: number): string {
  return `${callerId}:${missionId}:${timestamp}`;
}

/** Firma un payload (ej. `${providerId}:${timestamp}`) con la clave privada del nodo. */
export function signPayload(privateKey: KeyObject, payload: string): string {
  return cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
}

/**
 * Verifica una firma contra el `did:key` que la reclama como autora — la
 * clave pública se deriva del propio `did`, no de un directorio separado.
 * Devuelve `false` (nunca lanza) ante cualquier `did`/firma malformados.
 */
export function verifySignature(did: string, payload: string, signatureBase64: string): boolean {
  try {
    const rawPublicKey = didToPublicKeyRaw(did);
    const publicKey = rawPublicKeyToKeyObject(rawPublicKey);
    const signature = Buffer.from(signatureBase64, "base64");
    return cryptoVerify(null, Buffer.from(payload, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}
