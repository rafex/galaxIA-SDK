import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ArtifactRefSchema,
  ChatRequestMessageSchema,
  DocumentContextSchema,
  DynamicValueSchema,
  EnvelopeSchema,
  InlineArtifactSchema,
  KbRecommendedMessageSchema,
  OcrExtractedMessageSchema,
  PingMessageSchema,
  RagSource,
} from "../generated/fhs-protocol_pb.js";
import {
  decodeEnvelopeFrame,
  decodeLengthPrefixed,
  encodeEnvelopeFrame,
  encodeLengthPrefixed,
  newEnvelope,
} from "../wire.js";

describe("FHS Protobuf wire codec", () => {
  it("serializa un Envelope binario con framing LPP", () => {
    const envelope = newEnvelope({
      messageId: "message-1",
      sourcePeerId: "did:key:z6MkiSource",
      destPeerId: "did:key:z6MkiDestination",
      payload: { case: "ping", value: create(PingMessageSchema) },
    });

    const frame = encodeEnvelopeFrame(envelope);
    const decoded = decodeEnvelopeFrame(frame);

    expect(decoded.bytesConsumed).toBe(frame.byteLength);
    expect(decoded.envelope.messageId).toBe("message-1");
    expect(decoded.envelope.sourcePeerId).toBe("did:key:z6MkiSource");
    expect(decoded.envelope.payload.case).toBe("ping");
    expect(frame.includes(0x7b)).toBe(false);
  });

  it("acepta frames concatenados sin consumir el siguiente", () => {
    const first = encodeLengthPrefixed(Uint8Array.from([1, 2, 3]));
    const second = encodeLengthPrefixed(Uint8Array.from([4, 5]));
    const joined = new Uint8Array(first.byteLength + second.byteLength);
    joined.set(first);
    joined.set(second, first.byteLength);

    const decoded = decodeLengthPrefixed(joined);
    expect([...decoded.payload]).toEqual([1, 2, 3]);
    expect(decoded.bytesConsumed).toBe(first.byteLength);
  });

  it("rechaza un frame que supera el límite", () => {
    const oversized = toBinary(EnvelopeSchema, newEnvelope());
    const prefix = Uint8Array.from([0xff, 0xff, 0xff, 0x08]);
    expect(() => decodeLengthPrefixed(new Uint8Array([...prefix, ...oversized]))).toThrow(
      "demasiado grande",
    );
  });

  it("serializa ArtifactRef como oneof Protobuf dentro de DynamicValue", () => {
    const value = create(DynamicValueSchema, {
      kind: {
        case: "artifactRef",
        value: create(ArtifactRefSchema, {
          transport: {
            case: "inline",
            value: create(InlineArtifactSchema, {
              data: Uint8Array.from([1, 2, 3]),
              filename: "scan.png",
            }),
          },
        }),
      },
    });

    const decoded = fromBinary(DynamicValueSchema, toBinary(DynamicValueSchema, value));
    expect(decoded.kind.case).toBe("artifactRef");
    if (decoded.kind.case !== "artifactRef") return;
    expect(decoded.kind.value.transport.case).toBe("inline");
    if (decoded.kind.value.transport.case !== "inline") return;
    expect([...decoded.kind.value.transport.value.data]).toEqual([1, 2, 3]);
    expect(decoded.kind.value.transport.value.filename).toBe("scan.png");
  });

  it("serializa el ciclo Portal de OCR y contexto documental sin JSON", () => {
    const extracted = newEnvelope({
      sourcePeerId: "did:key:zNavigator",
      payload: {
        case: "ocrExtracted",
        value: create(OcrExtractedMessageSchema, { missionId: "m-1", filename: "scan.pdf", text: "texto" }),
      },
    });
    const recommendation = newEnvelope({
      sourcePeerId: "did:key:zNavigator",
      payload: {
        case: "kbRecommended",
        value: create(KbRecommendedMessageSchema, {
          missionId: "m-1",
          candidates: [{ providerId: "did:key:zKb", providerName: "KB", description: "documentos" }],
          chosenByLlm: false,
        }),
      },
    });
    const request = newEnvelope({
      sourcePeerId: "did:key:zPortal",
      payload: {
        case: "chatRequest",
        value: create(ChatRequestMessageSchema, {
          missionId: "m-1",
          messages: [{ role: "user", content: "¿qué contiene?" }],
          documentId: "doc-1",
          documentContext: create(DocumentContextSchema, {
            filename: "scan.pdf",
            documentId: "doc-1",
            source: RagSource.LOCAL,
            chunks: [{ chunkId: "chunk-1", filename: "scan.pdf", chunkIndex: 0, text: "texto", score: 0.9 }],
          }),
        }),
      },
    });

    expect(decodeEnvelopeFrame(encodeEnvelopeFrame(extracted)).envelope.payload.case).toBe("ocrExtracted");
    expect(decodeEnvelopeFrame(encodeEnvelopeFrame(recommendation)).envelope.payload.case).toBe("kbRecommended");
    const decodedRequest = decodeEnvelopeFrame(encodeEnvelopeFrame(request)).envelope;
    expect(decodedRequest.payload.case).toBe("chatRequest");
    if (decodedRequest.payload.case === "chatRequest") {
      expect(decodedRequest.payload.value.documentContext?.filename).toBe("scan.pdf");
      expect(decodedRequest.payload.value.documentId).toBe("doc-1");
      expect(decodedRequest.payload.value.documentContext?.chunks[0]?.text).toBe("texto");
      expect(decodedRequest.payload.value.documentContext?.text).toBe("");
    }
  });
});
