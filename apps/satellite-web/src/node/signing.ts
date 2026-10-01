/**
 * Firmas y DIDs FHS aptos para el navegador (sin `node:crypto`).
 *
 * Los payloads replican a `packages/fhs-protocol/src/identity.ts` (que importa
 * `node:crypto` y no se puede cargar en el navegador); `signing.test.ts` los
 * compara contra el original para que no se desalineen.
 */
import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { base58btc } from "multiformats/bases/base58";

export interface Signer {
  sign(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function didFromRaw(raw: Uint8Array): string {
  return `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...raw]))}`;
}

export function rawFromDid(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new Error("DID FHS inválido");
  const encoded = base58btc.decode(did.slice("did:key:".length));
  if (encoded[0] !== 0xed || encoded[1] !== 0x01 || encoded.byteLength !== 34) {
    throw new Error("DID FHS no es Ed25519");
  }
  return encoded.slice(2);
}

/** PeerId libp2p de un `did:key` Ed25519 (misma llave). */
export function peerIdFromDid(did: string): string {
  return peerIdFromPublicKey(publicKeyFromRaw(rawFromDid(did))).toString();
}

export function envelopeSignaturePayload(
  messageId: string,
  source: string,
  dest: string,
  timestamp: number,
  payloadHex: string,
): string {
  return `${messageId}:${source}:${dest}:${timestamp}:${payloadHex}`;
}

export function nodeAdvertiseSignaturePayload(did: string, beaconSha256Hex: string, timestamp: number, ttlSeconds: number): string {
  return `${did}:${beaconSha256Hex}:${timestamp}:${ttlSeconds}`;
}

export function missionOfferSignaturePayload(missionId: string, navigatorDid: string, missionType: string, bidDeadlineMs: number, timestamp: number): string {
  return `${missionId}:${navigatorDid}:${missionType}:${bidDeadlineMs}:${timestamp}`;
}

export function missionBidSignaturePayload(missionId: string, providerDid: string, offeredCapabilities: string[], timestamp: number): string {
  return `${missionId}:${providerDid}:${[...offeredCapabilities].sort().join(",")}:${timestamp}`;
}

export function missionAssignSignaturePayload(missionId: string, navigatorDid: string, assignedProvider: string, timestamp: number): string {
  return `${missionId}:${navigatorDid}:${assignedProvider}:${timestamp}`;
}

const encoder = new TextEncoder();

export async function signPayload(signer: Signer, payload: string): Promise<Uint8Array> {
  return await signer.sign(encoder.encode(payload));
}

/** Verifica una firma Ed25519 de `did` sobre el texto `payload`. */
export async function verifyPayload(did: string, payload: string, signature: Uint8Array): Promise<boolean> {
  if (signature.byteLength === 0) return false;
  try {
    return await publicKeyFromRaw(rawFromDid(did)).verify(encoder.encode(payload), signature);
  } catch {
    return false;
  }
}
