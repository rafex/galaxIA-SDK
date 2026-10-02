/**
 * Nodo FHS móvil (navegador): se anuncia, puja y atiende `arithmetic_solve`
 * bajo la regla de despacho DEC-0096 — solo ejecuta con oferta, puja y
 * asignación válidas. No escucha conexiones: marca a Atlas y al Navigator, y
 * el Navigator abre el stream sobre esa conexión.
 */
import { create } from "@bufbuild/protobuf";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { generateKeyPair } from "@libp2p/crypto/keys";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { webSockets } from "@libp2p/websockets";
import { CODE_P2P, multiaddr } from "@multiformats/multiaddr";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  FHS_STREAM_PROTOCOL,
  TOPIC_MISSIONS_ASSIGN,
  TOPIC_MISSIONS_BID,
  TOPIC_MISSIONS_OFFER,
  TOPIC_NODES_ADVERTISE,
} from "@rafex/galaxia-fhs-protocol/constants";
import * as FhsProto from "@rafex/galaxia-fhs-protocol/generated";
import {
  decodeEnvelopeFrame,
  decodeMessage,
  encodeEnvelopeFrame,
  encodeMessage,
  newEnvelope,
} from "@rafex/galaxia-fhs-protocol/wire";
import { createLibp2p } from "libp2p";
import { CALC_COMMAND } from "./command.js";
import { CAPABILITY, TOOL, solve, type SolveFn } from "./engine.js";
import { MissionLog, ResourceSampler, type MissionRecord, type MissionSummary, type ResourceSnapshot } from "./metrics.js";
import { AssignmentBook, ASSIGNMENT_WAIT_MS } from "./provider-core.js";
import {
  bytesToHex,
  didFromRaw,
  envelopeSignaturePayload,
  missionAssignSignaturePayload,
  missionBidSignaturePayload,
  missionOfferSignaturePayload,
  nodeAdvertiseSignaturePayload,
  peerIdFromDid,
  signPayload,
  verifyPayload,
} from "./signing.js";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>;

const ADVERTISE_INTERVAL_MS = 30_000;
const ADVERTISE_TTL_SECONDS = 60;
const MAINTENANCE_INTERVAL_MS = 10_000;
const CLOCK_SKEW_MS = 120_000;
const MAX_ACTIVE = 2;
const MAX_FRAME_BYTES = 8 * 1024;

export interface NodeState {
  did: string;
  bootstrapConnected: boolean;
  navigatorDid?: string;
  navigatorConnected: boolean;
  /** Solo datos operativos: nunca contenido de una misión. */
  summary: MissionSummary;
  missions: MissionRecord[];
  resources: ResourceSnapshot;
}

export interface NodeOptions {
  bootstrap: string[];
  key: PrivateKey;
  solve: SolveFn;
  resetEngine: () => void;
  /** Interruptor activo y página visible. */
  isAccepting: () => boolean;
  log: (line: string) => void;
  onState: (state: NodeState) => void;
}

export interface RunningNode {
  did: string;
  /** Anuncia ya (al activar el interruptor o volver a primer plano). */
  advertiseNow: () => void;
  stop: () => Promise<void>;
}

interface Stream extends AsyncIterable<unknown> {
  send(data: Uint8Array): unknown;
  close?: () => Promise<void>;
}

interface PubsubEvent {
  detail?: { topic?: string; data?: Uint8Array };
}

const PAYLOAD_SCHEMAS = {
  handshake: FhsProto.HandshakeMessageSchema,
  handshakeAck: FhsProto.HandshakeAckMessageSchema,
  error: FhsProto.ErrorMessageSchema,
  ping: FhsProto.PingMessageSchema,
  pong: FhsProto.PongMessageSchema,
  dispatchAck: FhsProto.DispatchAckMessageSchema,
  toolCall: FhsProto.ToolCallRequestMessageSchema,
  toolCancel: FhsProto.ToolCancelMessageSchema,
  toolResult: FhsProto.ToolCallResultMessageSchema,
  toolError: FhsProto.ToolCallErrorMessageSchema,
  toolList: FhsProto.ToolListRequestMessageSchema,
  toolListResp: FhsProto.ToolListResponseMessageSchema,
} as const;

function payloadBytes(payload: FhsProto.Envelope["payload"]): Uint8Array {
  if (!payload.case) return new Uint8Array();
  const schema = PAYLOAD_SCHEMAS[payload.case as keyof typeof PAYLOAD_SCHEMAS];
  if (!schema) throw new TypeError(`payload sin schema: ${payload.case}`);
  return encodeMessage(schema, payload.value as never);
}

function isLoopbackAddr(address: string): boolean {
  const host = /^\/(?:ip4|ip6|dns4|dns6|dns)\/([^/]+)/.exec(address)?.[1] ?? "";
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
}

export async function startSatelliteNode(options: NodeOptions): Promise<RunningNode> {
  const { key, log } = options;
  const did = didFromRaw(key.publicKey.raw);
  const missionLog = new MissionLog();
  const sampler = new ResourceSampler();
  sampler.start();
  const state: NodeState = {
    did,
    bootstrapConnected: false,
    navigatorConnected: false,
    summary: missionLog.summary(),
    missions: [],
    resources: sampler.snapshot(),
  };
  const book = new AssignmentBook(did);
  const bidded = new Set<string>();
  let navigator: { did: string; peerId: string; addrs: string[] } | undefined;
  let active = 0;
  let stopped = false;
  const publishState = () => {
    state.summary = missionLog.summary();
    state.missions = missionLog.list(8);
    state.resources = sampler.snapshot();
    options.onState({ ...state });
  };

  const node = await createLibp2p({
    privateKey: key,
    addresses: { listen: [] },
    transports: [webSockets()],
    connectionGater: { denyDialMultiaddr: (address) => !/\/tls\/ws/.test(address.toString()) },
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping(), pubsub: gossipsub() },
  });
  const pubsub = (node as unknown as {
    services: {
      pubsub: {
        subscribe(topic: string): void;
        publish(topic: string, data: Uint8Array): Promise<unknown>;
        addEventListener(type: "message", listener: (event: PubsubEvent) => void): void;
      };
    };
  }).services.pubsub;

  const publish = async (topic: string, data: Uint8Array): Promise<boolean> => {
    try {
      await pubsub.publish(topic, data);
      return true;
    } catch (error) {
      log(`no se pudo publicar en ${topic}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const connectedTo = (peerId: string): boolean =>
    node.getConnections().some((connection) => connection.remotePeer.toString() === peerId);

  // ── Anuncio ────────────────────────────────────────────────────────────────
  const beacon = create(FhsProto.BeaconSchema, {
    fhsVersion: "0.2",
    provider: create(FhsProto.ProviderIdentitySchema, {
      id: did,
      type: FhsProto.ProviderType.SATELLITE,
      visibility: FhsProto.Visibility.COMMUNITY,
      name: "Nodo móvil · aritmética",
      description: "Resuelve expresiones aritméticas en el navegador de un teléfono (Rust/WASM).",
      tags: [`tool:${TOOL}`, "ephemeral"],
    }),
    capabilities: [create(FhsProto.CapabilityDescriptorSchema, { id: CAPABILITY })],
    // SPEC-CMD-0001: el Navigator descubre `/calc` de este anuncio firmado.
    commands: [CALC_COMMAND],
  });
  const beaconHash = bytesToHex(sha256(encodeMessage(FhsProto.BeaconSchema, beacon)));

  const advertise = async (): Promise<void> => {
    if (stopped || !options.isAccepting() || !state.bootstrapConnected) return;
    const timestamp = Date.now();
    const signature = await signPayload(
      key,
      nodeAdvertiseSignaturePayload(did, beaconHash, timestamp, ADVERTISE_TTL_SECONDS),
    );
    const message = create(FhsProto.NodeAdvertiseMessageSchema, {
      did,
      beacon,
      multiaddrs: [],
      timestamp: BigInt(timestamp),
      ttlSeconds: ADVERTISE_TTL_SECONDS,
      trustLevel: "community",
      signature,
    });
    await publish(TOPIC_NODES_ADVERTISE, encodeMessage(FhsProto.NodeAdvertiseMessageSchema, message));
  };

  // ── Descubrimiento del Navigator ───────────────────────────────────────────
  const dialNavigator = async (): Promise<void> => {
    if (!navigator || connectedTo(navigator.peerId)) return;
    for (const address of navigator.addrs) {
      try {
        const base = multiaddr(address).decapsulateCode(CODE_P2P).toString();
        await node.dial(multiaddr(`${base}/p2p/${navigator.peerId}`));
        log(`conectado al Navigator (${address})`);
        break;
      } catch (error) {
        log(`no se pudo marcar al Navigator en ${address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    state.navigatorConnected = navigator ? connectedTo(navigator.peerId) : false;
    publishState();
  };

  const onAdvertise = async (bytes: Uint8Array): Promise<void> => {
    const message = decodeMessage(FhsProto.NodeAdvertiseMessageSchema, bytes);
    if (message.beacon?.provider?.id !== "navigator" || !message.did || !message.beacon) return;
    const now = Date.now();
    const timestamp = Number(message.timestamp);
    if (timestamp > now + CLOCK_SKEW_MS || timestamp + message.ttlSeconds * 1_000 < now - CLOCK_SKEW_MS) return;
    const hash = bytesToHex(sha256(encodeMessage(FhsProto.BeaconSchema, message.beacon)));
    if (!(await verifyPayload(message.did, nodeAdvertiseSignaturePayload(message.did, hash, timestamp, message.ttlSeconds), message.signature))) {
      log("anuncio de Navigator con firma inválida descartado");
      return;
    }
    const addrs = message.multiaddrs.filter((a) => /\/tls\/ws/.test(a) && !isLoopbackAddr(a));
    const known = navigator?.did === message.did;
    navigator = { did: message.did, peerId: peerIdFromDid(message.did), addrs };
    state.navigatorDid = message.did;
    if (!known) log(`Navigator verificado: ${message.did.slice(0, 20)}…`);
    if (addrs.length === 0) log("el anuncio del Navigator no trae direcciones alcanzables (¿FHS_ANNOUNCE_ADDRS?)");
    await dialNavigator();
  };

  // ── Subasta ────────────────────────────────────────────────────────────────
  const onOffer = async (bytes: Uint8Array): Promise<void> => {
    const offer = decodeMessage(FhsProto.MissionOfferMessageSchema, bytes);
    if (!navigator || offer.navigatorDid !== navigator.did || !offer.missionId) return;
    const verified = await verifyPayload(
      offer.navigatorDid,
      missionOfferSignaturePayload(offer.missionId, offer.navigatorDid, offer.missionType, Number(offer.bidDeadlineMs), Number(offer.timestamp)),
      offer.signature,
    );
    if (!verified) return;
    book.recordOffer({
      missionId: offer.missionId,
      navigatorDid: offer.navigatorDid,
      timestamp: Number(offer.timestamp),
      bidDeadlineMs: Number(offer.bidDeadlineMs),
    });
    const canServe =
      offer.missionType === "tool_call" &&
      offer.requiredCapabilities.length > 0 &&
      offer.requiredCapabilities.every((capability) => capability === CAPABILITY);
    if (!canServe || bidded.has(offer.missionId)) return;
    if (!options.isAccepting() || !connectedTo(navigator.peerId) || active >= MAX_ACTIVE) return;
    bidded.add(offer.missionId);
    const timestamp = Date.now();
    const signature = await signPayload(key, missionBidSignaturePayload(offer.missionId, did, [CAPABILITY], timestamp));
    const bid = create(FhsProto.MissionBidMessageSchema, {
      missionId: offer.missionId,
      providerDid: did,
      providerMultiaddrs: [],
      providerType: "satellite",
      offeredCapabilities: [CAPABILITY],
      reputationScore: 0.5,
      estimatedLatencyMs: 200,
      trustLevel: "community",
      timestamp: BigInt(timestamp),
      signature,
    });
    if (await publish(TOPIC_MISSIONS_BID, encodeMessage(FhsProto.MissionBidMessageSchema, bid))) {
      missionLog.touch(offer.missionId, { phase: "puja" });
      log(`puja enviada para la misión ${offer.missionId.slice(0, 8)}`);
      publishState();
    }
  };

  const onAssign = async (bytes: Uint8Array): Promise<void> => {
    const assign = decodeMessage(FhsProto.MissionAssignMessageSchema, bytes);
    if (!navigator || assign.assignedProvider !== did || assign.navigatorDid !== navigator.did) return;
    const verified = await verifyPayload(
      assign.navigatorDid,
      missionAssignSignaturePayload(assign.missionId, assign.navigatorDid, assign.assignedProvider, Number(assign.timestamp)),
      assign.signature,
    );
    if (!verified) return;
    book.recordAssign({
      missionId: assign.missionId,
      navigatorDid: assign.navigatorDid,
      assignedProvider: assign.assignedProvider,
      timestamp: Number(assign.timestamp),
    });
    missionLog.touch(assign.missionId, { phase: "asignada" });
    log(`misión ${assign.missionId.slice(0, 8)} asignada a este nodo`);
    publishState();
  };

  pubsub.subscribe(TOPIC_NODES_ADVERTISE);
  pubsub.subscribe(TOPIC_MISSIONS_OFFER);
  pubsub.subscribe(TOPIC_MISSIONS_ASSIGN);
  pubsub.addEventListener("message", (event) => {
    const { topic, data } = event.detail ?? {};
    if (!topic || !data) return;
    const handler =
      topic === TOPIC_NODES_ADVERTISE ? onAdvertise : topic === TOPIC_MISSIONS_OFFER ? onOffer : topic === TOPIC_MISSIONS_ASSIGN ? onAssign : undefined;
    void handler?.(data).catch(() => undefined);
  });

  // ── Stream de misión ───────────────────────────────────────────────────────
  async function* frames(stream: Stream): AsyncGenerator<FhsProto.Envelope> {
    let buffer = new Uint8Array();
    for await (const chunk of stream) {
      const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
      const joined = new Uint8Array(buffer.byteLength + bytes.byteLength);
      joined.set(buffer);
      joined.set(bytes, buffer.byteLength);
      buffer = joined;
      if (buffer.byteLength > MAX_FRAME_BYTES) throw new Error("frame demasiado grande");
      while (buffer.byteLength > 0) {
        let decoded: ReturnType<typeof decodeEnvelopeFrame>;
        try {
          decoded = decodeEnvelopeFrame(buffer);
        } catch (error) {
          if (error instanceof Error && error.message.includes("incompleto")) break;
          throw error;
        }
        buffer = buffer.slice(decoded.bytesConsumed);
        yield decoded.envelope;
      }
    }
  }

  const verifyEnvelope = async (envelope: FhsProto.Envelope, expectedSource: string): Promise<boolean> => {
    if (envelope.sourcePeerId !== expectedSource) return false;
    if (Math.abs(Date.now() - Number(envelope.timestamp)) > CLOCK_SKEW_MS) return false;
    return await verifyPayload(
      envelope.sourcePeerId,
      envelopeSignaturePayload(envelope.messageId, envelope.sourcePeerId, envelope.destPeerId, Number(envelope.timestamp), bytesToHex(payloadBytes(envelope.payload))),
      envelope.signature,
    );
  };

  const send = async (stream: Stream, dest: string, payload: FhsProto.Envelope["payload"]): Promise<void> => {
    const envelope = newEnvelope({ sourcePeerId: did, destPeerId: dest, payload });
    const signature = await signPayload(
      key,
      envelopeSignaturePayload(envelope.messageId, did, dest, Number(envelope.timestamp), bytesToHex(payloadBytes(payload))),
    );
    stream.send(encodeEnvelopeFrame(create(FhsProto.EnvelopeSchema, { ...envelope, signature })));
  };

  const toolError = (stream: Stream, dest: string, missionId: string, callId: string, error: string) =>
    send(stream, dest, {
      case: "toolError",
      value: create(FhsProto.ToolCallErrorMessageSchema, { missionId, toolCallId: callId, error }),
    });

  const serve = async (stream: Stream, remotePeerId: string): Promise<void> => {
    // (1) El peer remoto debe ser el Navigator verificado.
    if (!navigator || remotePeerId !== navigator.peerId) {
      log("stream rechazado: no viene del Navigator verificado");
      return;
    }
    const navigatorDid = navigator.did;
    const incoming = frames(stream);
    const first = await incoming.next();
    if (first.done || first.value.payload.case !== "handshake" || !(await verifyEnvelope(first.value, navigatorDid))) {
      log("stream rechazado: handshake inválido");
      return;
    }
    // (2) Handshake y ack.
    await send(stream, navigatorDid, {
      case: "handshakeAck",
      value: create(FhsProto.HandshakeAckMessageSchema, {
        fhsVersion: "0.2",
        leaseSeconds: 30,
        heartbeatSeconds: 10,
        leaseExpires: BigInt(Date.now() + 30_000),
        acceptedServices: 1,
        trustLevel: "community",
      }),
    });
    for await (const envelope of incoming) {
      if (!(await verifyEnvelope(envelope, navigatorDid))) {
        log("mensaje descartado: firma o ventana de tiempo inválida");
        continue;
      }
      const { payload } = envelope;
      if (payload.case === "ping") {
        await send(stream, navigatorDid, { case: "pong", value: create(FhsProto.PongMessageSchema, {}) });
        continue;
      }
      if (payload.case !== "toolCall") continue;
      // (3) Un solo ToolCall bien formado.
      const call = payload.value;
      const missionId = call.missionId;
      const only = call.toolCalls.length === 1 ? call.toolCalls[0] : undefined;
      const args = only?.function?.arguments?.kind;
      const fields = args?.case === "objectValue" ? args.value.fields : undefined;
      const expressionValue = fields?.expression?.kind;
      const expression = expressionValue?.case === "stringValue" ? expressionValue.value : undefined;
      if (!missionId || !only || only.function?.name !== TOOL || expression === undefined || Object.keys(fields ?? {}).length !== 1) {
        await toolError(stream, navigatorDid, missionId, only?.id ?? "", "MATH_SYNTAX");
        return;
      }
      // (4)+(5) La cadena oferta → asignación manda sobre todo lo demás.
      await book.waitForAssign(missionId, ASSIGNMENT_WAIT_MS);
      const authorization = book.consume(missionId, navigatorDid, Date.now());
      if (!authorization.ok) {
        missionLog.touch(missionId, { phase: "rechazada" });
        log(`misión ${missionId.slice(0, 8)} rechazada: ${authorization.reason}`);
        publishState();
        await toolError(stream, navigatorDid, missionId, only.id, "ASSIGNMENT_REQUIRED");
        return;
      }
      // (6) Ejecutar.
      const receivedAt = performance.now();
      missionLog.touch(missionId, { phase: "ejecutando" });
      publishState();
      active += 1;
      try {
        await send(stream, navigatorDid, {
          case: "dispatchAck",
          value: create(FhsProto.DispatchAckMessageSchema, { missionId, queuedAt: BigInt(Date.now()) }),
        });
        const computeStart = performance.now();
        const outcome = await solve(expression, options.solve);
        const computeEnd = performance.now();
        sampler.recordCompute(computeStart, computeEnd);
        if (outcome.ok) {
          await send(stream, navigatorDid, {
            case: "toolResult",
            value: create(FhsProto.ToolCallResultMessageSchema, {
              missionId,
              toolCallId: only.id,
              result: create(FhsProto.DynamicValueSchema, {
                kind: {
                  case: "objectValue",
                  value: create(FhsProto.DynamicObjectSchema, {
                    fields: { result: create(FhsProto.DynamicValueSchema, { kind: { case: "stringValue", value: outcome.result } }) },
                  }),
                },
              }),
            }),
          });
        } else {
          if (outcome.code === "MATH_TIMEOUT") options.resetEngine();
          await toolError(stream, navigatorDid, missionId, only.id, outcome.code);
        }
        missionLog.touch(missionId, {
          phase: outcome.ok ? "ok" : "error",
          totalMs: Math.round(performance.now() - receivedAt),
          computeMs: Math.round((computeEnd - computeStart) * 10) / 10,
        });
        log(`misión ${missionId.slice(0, 8)}: ${outcome.ok ? "ok" : "con error"} en ${Math.round(performance.now() - receivedAt)} ms`);
        publishState();
      } finally {
        active -= 1;
      }
      return;
    }
  };

  await node.handle(FHS_STREAM_PROTOCOL, (stream, connection) => {
    void serve(stream as unknown as Stream, connection.remotePeer.toString())
      .catch((error: unknown) => log(`error en el stream: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => void (stream as unknown as Stream).close?.().catch(() => undefined));
  });

  // ── Conexión y mantenimiento ───────────────────────────────────────────────
  const connectBootstrap = async (): Promise<void> => {
    if (state.bootstrapConnected && node.getConnections().length > 0) return;
    for (const address of options.bootstrap) {
      try {
        await node.dial(multiaddr(address));
        state.bootstrapConnected = true;
        log(`conectado al bootstrap (${address})`);
        publishState();
        return;
      } catch (error) {
        log(`bootstrap ${address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    state.bootstrapConnected = false;
    publishState();
  };

  const maintain = async (): Promise<void> => {
    if (stopped) return;
    if (node.getConnections().length === 0) state.bootstrapConnected = false;
    await connectBootstrap();
    await dialNavigator();
    state.navigatorConnected = navigator ? connectedTo(navigator.peerId) : false;
    publishState();
  };

  await connectBootstrap();
  void advertise();
  // La malla GossipSub tarda unos segundos en formarse: reintenta al arrancar.
  const earlyTimers = [4_000, 10_000].map((ms) => setTimeout(() => void advertise(), ms));
  const advertiseTimer = setInterval(() => void advertise(), ADVERTISE_INTERVAL_MS);
  const maintainTimer = setInterval(() => void maintain(), MAINTENANCE_INTERVAL_MS);
  const statsTimer = setInterval(publishState, 3_000);
  publishState();

  return {
    did,
    advertiseNow: () => void advertise(),
    stop: async () => {
      stopped = true;
      clearInterval(advertiseTimer);
      earlyTimers.forEach(clearTimeout);
      clearInterval(maintainTimer);
      sampler.stop();
      clearInterval(statsTimer);
      await node.stop();
    },
  };
}
