import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import * as Auth from "../authorization.js";
import * as Fhs from "../generated/fhs-protocol_pb.js";

const fixtures = JSON.parse(
  readFileSync(new URL("../../../../../galaxIA/idl/fixtures/authorization-digests.json", import.meta.url), "utf8"),
) as { version: string; cases: Record<string, string> };

const str = (value: string) => create(Fhs.DynamicValueSchema, { kind: { case: "stringValue", value } });
const obj = (fields: Record<string, Fhs.DynamicValue>) =>
  create(Fhs.DynamicValueSchema, { kind: { case: "objectValue", value: create(Fhs.DynamicObjectSchema, { fields }) } });

describe("digests de autorización (paridad con Rust)", () => {
  it("usa la misma versión", () => {
    expect(fixtures.version).toBe(Auth.DIGEST_VERSION);
  });

  it("coincide con los fixtures compartidos", () => {
    const c = fixtures.cases;
    expect(Auth.toHex(Auth.userMessageDigest("hola"))).toBe(c["user_message:hola"]);
    expect(Auth.toHex(Auth.userMessageDigest("¿Qué es un Navigator? ñ 日本 \u{1F680}"))).toBe(c["user_message:unicode"]);
    expect(Auth.toHex(Auth.documentDigest(Uint8Array.of(0, 1, 2, 3, 255)))).toBe(c["document:bytes"]);
    expect(
      Auth.toHex(Auth.ipfsDigest("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", new TextEncoder().encode("contenido"))),
    ).toBe(c["ipfs:cid"]);
    expect(Auth.toHex(Auth.chunksDigest(Auth.DOMAIN_DERIVED_TEXT, ["primer fragmento", "segundo ñandú"]))).toBe(c["derived_text:chunks"]);
    expect(Auth.toHex(Auth.commandArgsDigest("arithmetic_solve", obj({ expression: str("(12+8)*3^2/4") })))).toBe(c["command_args:calc"]);
    const mixed = obj({
      zeta: create(Fhs.DynamicValueSchema, { kind: { case: "integerValue", value: -5n } }),
      alfa: create(Fhs.DynamicValueSchema, { kind: { case: "numberValue", value: 1.5 } }),
      beta: create(Fhs.DynamicValueSchema, { kind: { case: "booleanValue", value: true } }),
      lista: create(Fhs.DynamicValueSchema, {
        kind: { case: "listValue", value: create(Fhs.DynamicListSchema, { values: [str("x"), str("y")] }) },
      }),
    });
    expect(Auth.toHex(Auth.valueDigest(Auth.DOMAIN_TOOL_ARGS, mixed))).toBe(c["tool_args:mixed"]);
    const batch = Auth.batchDigest({
      authorizationId: "auth-1",
      conversationId: "conv-1",
      turnId: "turn-1",
      expiresAt: 1_790_000_000_000n,
      items: [
        { itemId: "b", capabilityId: "document.ocr", providerDid: "did:key:zOCR", payloadDigest: Auth.documentDigest(new TextEncoder().encode("pdf")), dataClass: 3, destination: 2, retention: 1, dependsOn: [] },
        { itemId: "a", capabilityId: "document.index", providerDid: "did:key:zRAG", payloadDigest: Auth.textDigest(Auth.DOMAIN_DERIVED_TEXT, "texto"), dataClass: 2, destination: 2, retention: 2, dependsOn: ["b"] },
      ],
    });
    expect(Auth.toHex(batch)).toBe(c["batch:two_items"]);
    const commandBatch = Auth.batchDigest({
      authorizationId: "auth-2",
      conversationId: "conv-1",
      turnId: "turn-2",
      expiresAt: 1_790_000_000_000n,
      items: [
        {
          itemId: "calc-0",
          capabilityId: "math.arithmetic.solve",
          providerDid: "did:key:zPHONE",
          payloadDigest: Auth.commandArgsDigest("arithmetic_solve", obj({ expression: str("(12+8)*3^2/4") })),
          dataClass: 4,
          destination: 2,
          retention: 1,
          dependsOn: [],
          contractFingerprint: "ab".repeat(32),
          toolName: "arithmetic_solve",
          registryDigest: "cd".repeat(32),
        },
      ],
    });
    expect(Auth.toHex(commandBatch)).toBe(c["batch:command_item"]);
  });

  it("rechaza lo que no es canonizable y no depende del orden de claves", () => {
    expect(() => Auth.valueDigest(Auth.DOMAIN_TOOL_ARGS, create(Fhs.DynamicValueSchema, { kind: { case: "numberValue", value: Number.NaN } }))).toThrow();
    const a = obj({ a: str("1"), b: str("2") });
    const b = obj({ b: str("2"), a: str("1") });
    expect(Auth.toHex(Auth.valueDigest(Auth.DOMAIN_TOOL_ARGS, a))).toBe(Auth.toHex(Auth.valueDigest(Auth.DOMAIN_TOOL_ARGS, b)));
  });
});
