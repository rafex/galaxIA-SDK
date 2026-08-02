import { describe, it, expect } from "vitest";
import {
  generateIdentity,
  signPayload,
  verifySignature,
  canonicalJson,
  sha256CanonicalHex,
  helloSignaturePayload,
  registerSignaturePayload,
  welcomeSignaturePayload,
  invokeSignaturePayload,
} from "../identity.js";
import { flattenManifest, type MultiBeacon } from "../manifest.js";

describe("canonicalJson", () => {
  it("produce la misma cadena sin importar el orden de llaves", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } })).toBe(
      canonicalJson({ a: { c: "x", d: [2, 1] }, b: 1 })
    );
  });

  it("omite undefined igual que JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("preserva el orden de arrays (solo ordena llaves de objetos)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("payloads de firma", () => {
  const identity = generateIdentity();

  it("hello: firma y verifica contra el did", () => {
    const ts = Date.now();
    const payload = helloSignaturePayload(identity.did, ts);
    const sig = signPayload(identity.privateKey, payload);
    expect(verifySignature(identity.did, payload, sig)).toBe(true);
  });

  it("register: ancla el manifiesto — cambiar el manifiesto invalida la firma", () => {
    const ts = Date.now();
    const manifest = { fhsVersion: "0.1", provider: { id: identity.did } };
    const sig = signPayload(identity.privateKey, registerSignaturePayload(identity.did, ts, manifest));
    expect(
      verifySignature(identity.did, registerSignaturePayload(identity.did, ts, manifest), sig)
    ).toBe(true);
    const tampered = { ...manifest, provider: { id: "did:key:zImpostor" } };
    expect(
      verifySignature(identity.did, registerSignaturePayload(identity.did, ts, tampered), sig)
    ).toBe(false);
  });

  it("register: el hash es estable ante reordenamiento de llaves del manifiesto", () => {
    const a = { provider: { name: "n", id: "x" }, fhsVersion: "0.1" };
    const b = { fhsVersion: "0.1", provider: { id: "x", name: "n" } };
    expect(sha256CanonicalHex(a)).toBe(sha256CanonicalHex(b));
  });

  it("welcome e invocación: firman y verifican", () => {
    const ts = Date.now();
    const w = welcomeSignaturePayload(identity.did, ts);
    expect(verifySignature(identity.did, w, signPayload(identity.privateKey, w))).toBe(true);
    const i = invokeSignaturePayload(identity.did, "req-1", ts);
    expect(verifySignature(identity.did, i, signPayload(identity.privateKey, i))).toBe(true);
  });
});

describe("flattenManifest (nodos multi)", () => {
  it("genera sub-ids como DID URL con fragmento, verificables recortando el fragmento", () => {
    const identity = generateIdentity();
    const manifest: MultiBeacon = {
      fhsVersion: "0.1",
      provider: { id: identity.did, name: "multi", type: "multi", visibility: "community" },
      services: [
        { kind: "llm", endpoint: { protocol: "fhs", url: "ws://x/chat" }, models: [] },
        { kind: "mcp", endpoint: { protocol: "fhs", url: "ws://x/tools" }, capabilities: [] },
      ],
    };
    const flat = [...flattenManifest(manifest)];
    expect(flat.map((f) => f.provider.id)).toEqual([`${identity.did}#llm`, `${identity.did}#mcp`]);
    // El did base (antes del fragmento) sigue siendo verificable.
    const baseDid = flat[0].provider.id.split("#")[0];
    const payload = helloSignaturePayload(baseDid, 123);
    expect(verifySignature(baseDid, payload, signPayload(identity.privateKey, payload))).toBe(true);
  });
});
