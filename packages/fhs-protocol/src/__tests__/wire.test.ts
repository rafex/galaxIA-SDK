import { describe, expect, it } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  EnvelopeSchema,
  PingMessageSchema,
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
});
