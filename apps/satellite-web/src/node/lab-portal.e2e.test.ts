/**
 * Prueba de laboratorio (manual): hace de Portal contra el Navigator real —
 * handshake, agentStart, chatRequest y respuesta a la tarjeta de autorización
 * (SPEC-AUTHZ-0001). Imprime la lista de comandos autodescubiertos
 * (`commands.available`, SPEC-CMD-0001).
 *
 *   FHS_LAB=1 FHS_LAB_NAVIGATOR=/ip4/192.168.1.139/tcp/4010/tls/ws/p2p/<id> \
 *   FHS_LAB_MESSAGE='/calc (12+8)*3^2/4' FHS_LAB_DECISION=allow \
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx vitest run src/node/lab-portal.e2e.test.ts --disable-console-intercept
 */
import { create } from "@bufbuild/protobuf";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { FHS_STREAM_PROTOCOL } from "@rafex/galaxia-fhs-protocol/constants";
import * as FhsProto from "@rafex/galaxia-fhs-protocol/generated";
import { decodeEnvelopeFrame, encodeEnvelopeFrame, encodeMessage, newEnvelope } from "@rafex/galaxia-fhs-protocol/wire";
import { createLibp2p } from "libp2p";
import { describe, it } from "vitest";
import { bytesToHex, didFromRaw, envelopeSignaturePayload, signPayload } from "./signing.js";

const enabled = process.env.FHS_LAB === "1";

const SCHEMAS = {
  handshake: FhsProto.HandshakeMessageSchema,
  agentStart: FhsProto.AgentStartMessageSchema,
  chatRequest: FhsProto.ChatRequestMessageSchema,
  authorizationDecision: FhsProto.AuthorizationDecisionMessageSchema,
} as const;

describe.skipIf(!enabled)("Portal simulado contra el Navigator", () => {
  it("envía el mensaje (p. ej. un comando) y responde a la autorización", async () => {
    const key = await generateKeyPair("Ed25519");
    const did = didFromRaw(key.publicKey.raw);
    const node = await createLibp2p({
      privateKey: key,
      addresses: { listen: [] },
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), ping: ping() },
    });
    const connection = await node.dial(multiaddr(process.env.FHS_LAB_NAVIGATOR ?? ""));
    const stream = await connection.newStream(FHS_STREAM_PROTOCOL);

    type Payload = { case: keyof typeof SCHEMAS; value: never };
    const send = async (payload: Payload) => {
      const bytes = encodeMessage(SCHEMAS[payload.case] as never, payload.value);
      const envelope = newEnvelope({ sourcePeerId: did, destPeerId: "", payload: payload as never });
      const signature = await signPayload(
        key,
        envelopeSignaturePayload(envelope.messageId, did, "", Number(envelope.timestamp), bytesToHex(bytes)),
      );
      stream.send(encodeEnvelopeFrame(create(FhsProto.EnvelopeSchema, { ...envelope, signature })));
    };

    const session = crypto.randomUUID();
    const decision = process.env.FHS_LAB_DECISION !== "deny";
    await send({
      case: "handshake",
      value: create(FhsProto.HandshakeMessageSchema, {
        fhsVersion: "0.2",
        listenAddrs: [],
        beacon: create(FhsProto.BeaconSchema, {
          fhsVersion: "0.2",
          provider: create(FhsProto.ProviderIdentitySchema, { id: did, type: FhsProto.ProviderType.MULTI, visibility: FhsProto.Visibility.COMMUNITY, name: "Portal simulado" }),
        }),
      }) as never,
    });
    await send({ case: "agentStart", value: create(FhsProto.AgentStartMessageSchema, { sessionId: session, scope: "community", kbMaxPerQuestion: 1 }) as never });
    await send({
      case: "chatRequest",
      value: create(FhsProto.ChatRequestMessageSchema, {
        missionId: session,
        messages: [create(FhsProto.MessageSchema, { role: "user", content: process.env.FHS_LAB_MESSAGE ?? "/calc 2+2" })],
      }) as never,
    });

    let buffer = new Uint8Array();
    let text = "";
    const deadline = Date.now() + 90_000;
    outer: for await (const chunk of stream as AsyncIterable<unknown>) {
      const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
      const joined = new Uint8Array(buffer.byteLength + bytes.byteLength);
      joined.set(buffer);
      joined.set(bytes, buffer.byteLength);
      buffer = joined;
      while (buffer.byteLength > 0) {
        let decoded: ReturnType<typeof decodeEnvelopeFrame>;
        try {
          decoded = decodeEnvelopeFrame(buffer);
        } catch {
          break;
        }
        buffer = buffer.slice(decoded.bytesConsumed);
        const payload = decoded.envelope.payload;
        if (payload.case === "assistantDelta") text += payload.value.delta;
        else if (payload.case === "commandsAvailable") {
          const list = payload.value.commands.map((c) => (c.conflict ? `/${c.name} (conflicto)` : `${c.usage} [${c.nodesCount}]`));
          console.log(`[portal] COMANDOS (rev ${payload.value.revision}): ${list.join(" | ") || "ninguno"}`);
        } else if (payload.case === "authorizationRequested") {
          const request = payload.value;
          for (const item of request.items) {
            console.log(
              `[portal] AUTORIZACIÓN ${item.itemId}: ${item.capabilityId} → ${item.providerName} · ${item.dataSummary}` +
                (item.toolName ? ` · tool=${item.toolName} huella=${item.contractFingerprint.slice(0, 12)}` : ""),
            );
          }
          console.log(`[portal] respondo ${decision ? "AUTORIZAR" : "RECHAZAR"}`);
          await send({
            case: "authorizationDecision",
            value: create(FhsProto.AuthorizationDecisionMessageSchema, {
              authorizationId: request.authorizationId,
              batchDigest: request.batchDigest,
              decisions: request.items.map((item) => ({ itemId: item.itemId, allow: decision })),
            }) as never,
          });
        } else if (payload.case === "assistantCompleted") {
          console.log(`[portal] RESPUESTA: ${text.replace(/\n+/g, " / ")}`);
          console.log(`[portal] PROCEDENCIA: modelo=${payload.value.provenance?.model} herramientas=${payload.value.provenance?.toolProviderIds.join(",") || "ninguna"} datosExportados=${payload.value.provenance?.dataExported}`);
          break outer;
        } else if (payload.case === "error") {
          console.log(`[portal] ERROR: ${payload.value.message}`);
          break outer;
        } else if (payload.case) console.log(`[portal] ${payload.case}`);
      }
      if (Date.now() > deadline) break;
    }
    await node.stop();
  }, 120_000);
});
