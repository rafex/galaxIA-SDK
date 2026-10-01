import { generateKeyPair } from "@libp2p/crypto/keys";
import { describe, expect, it } from "vitest";
import {
  envelopeSignaturePayload as protoEnvelope,
  missionAssignSignaturePayload as protoAssign,
  missionBidSignaturePayload as protoBid,
  missionOfferSignaturePayload as protoOffer,
  nodeAdvertiseSignaturePayload as protoAdvertise,
  publicKeyToDid,
} from "@rafex/galaxia-fhs-protocol";
import * as local from "./signing.js";

describe("firmas del navegador", () => {
  it("producen los mismos payloads que el protocolo", () => {
    expect(local.envelopeSignaturePayload("m", "s", "d", 5, "ab")).toBe(protoEnvelope("m", "s", "d", 5, "ab"));
    expect(local.nodeAdvertiseSignaturePayload("did", "h", 1, 60)).toBe(protoAdvertise("did", "h", 1, 60));
    expect(local.missionOfferSignaturePayload("m", "n", "tool_call", 2000, 9)).toBe(protoOffer("m", "n", "tool_call", 2000, 9));
    expect(local.missionBidSignaturePayload("m", "p", ["b", "a"], 3)).toBe(protoBid("m", "p", ["b", "a"], 3));
    expect(local.missionAssignSignaturePayload("m", "n", "p", 4)).toBe(protoAssign("m", "n", "p", 4));
  });

  it("deriva el mismo did:key y verifica firmas Ed25519", async () => {
    const key = await generateKeyPair("Ed25519");
    const did = local.didFromRaw(key.publicKey.raw);
    expect(did).toBe(publicKeyToDid(Buffer.from(key.publicKey.raw)));
    expect(local.rawFromDid(did)).toEqual(key.publicKey.raw);
    const signature = await local.signPayload(key, "hola");
    expect(await local.verifyPayload(did, "hola", signature)).toBe(true);
    expect(await local.verifyPayload(did, "adios", signature)).toBe(false);
    expect(await local.verifyPayload(did, "hola", new Uint8Array())).toBe(false);
    expect(local.peerIdFromDid(did)).toBe(key.publicKey ? (await import("@libp2p/peer-id")).peerIdFromPublicKey(key.publicKey).toString() : "");
  });
});
