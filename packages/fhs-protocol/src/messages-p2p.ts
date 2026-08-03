/**
 * Mensajes del protocolo FHS P2P — DEC-P2P-001, DEC-0086, DEC-0087.
 * Mapeo TypeScript 1:1 del IDL Protobuf (idl/fhs-protocol.proto).
 * Reemplazan los tipos WebSocket de messages.ts (marcados @deprecated).
 */

// ── Tipos base del protocolo ──────────────────────────────────────────────────

export interface P2pMessage {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: P2pToolCall[];
}

export interface P2pToolDefinition {
  name: string;
  description: string;
  inputSchema: string;
}

export interface P2pToolCall {
  id: string;
  type: string;
  function: P2pToolCallFunction;
}

export interface P2pToolCallFunction {
  name: string;
  arguments: string;
}

// ── Tipos auxiliares ──────────────────────────────────────────────────────────

export type TrustLevel = 'standard' | 'delegated' | 'community' | 'unverified';
export type MissionType = 'chat' | 'tool_call' | 'agent';
export type FhsScope = 'local' | 'network' | 'community' | 'external';
export type ProviderType = 'star' | 'satellite' | 'nova';

export type AgentStatus =
  | 'thinking'
  | 'offering'
  | 'waiting_bid'
  | 'assigning'
  | 'calling_star'
  | 'calling_satellite'
  | 'streaming'
  | 'completed'
  | 'error';

export type P2pFhsErrorCode =
  | 'FHS_ERROR_CODE_UNSPECIFIED'
  | 'NOT_IDENTIFIED'
  | 'INVALID_MANIFEST'
  | 'INVALID_SIGNATURE'
  | 'UNSUPPORTED_VERSION'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'INVALID_ARGUMENTS'
  | 'UNSUPPORTED_CAPABILITY'
  | 'UNAUTHORIZED'
  | 'CANCELLED'
  | 'OVERLOADED'
  | 'INTERNAL_ERROR'
  | 'DELEGATION_INVALID'
  | 'DELEGATION_EXPIRED'
  | 'WASM_HASH_MISMATCH'
  | 'PEER_UNREACHABLE'
  | 'DHT_RECORD_INVALID'
  | 'BID_TIMEOUT'
  | 'BID_REJECTED';

// ── Envelope — Frame de stream directo FHS (/fhs/v1/0.1.0) ──────────────────
// En modo JSON (Sec-WebSocket-Protocol: fhs.v1.json) el campo `type` actúa
// como discriminador del oneof payload. Ver idl/framing.md.

export interface EnvelopeHeader {
  messageId: string;
  sourcePeerId: string;
  destPeerId: string;
  timestamp: number;
  version: string;
  signature: string;
}

export type EnvelopePayload =
  | { type: 'handshake';          payload: HandshakeMessage }
  | { type: 'handshake_ack';      payload: HandshakeAckMessage }
  | { type: 'ping';               payload: PulseMessage }
  | { type: 'pong';               payload: PulseAckMessage }
  | { type: 'error';              payload: FhsErrorMessage }
  | { type: 'chat_request';       payload: ChatP2pRequestMessage }
  | { type: 'chat_cancel';        payload: ChatP2pCancelMessage }
  | { type: 'chat_delta';         payload: ChatP2pDeltaMessage }
  | { type: 'chat_completed';     payload: ChatP2pCompletedMessage }
  | { type: 'chat_error';         payload: ChatP2pErrorMessage }
  | { type: 'dispatch_ack';       payload: DispatchP2pAckMessage }
  | { type: 'tool_call';          payload: ToolP2pCallRequestMessage }
  | { type: 'tool_cancel';        payload: ToolP2pCancelMessage }
  | { type: 'tool_result';        payload: ToolP2pCallResultMessage }
  | { type: 'tool_error';         payload: ToolP2pCallErrorMessage }
  | { type: 'tool_list';          payload: ToolP2pListRequestMessage }
  | { type: 'tool_list_resp';     payload: ToolP2pListResponseMessage }
  | { type: 'node_advertise';     payload: NodeAdvertiseMessage }
  | { type: 'mission_offer';      payload: MissionOfferMessage }
  | { type: 'mission_bid';        payload: MissionBidMessage }
  | { type: 'mission_assign';     payload: MissionAssignMessage }
  | { type: 'dht_beacon';         payload: DhtBeaconRecord }
  | { type: 'dht_reputation';     payload: DhtReputationRecord }
  | { type: 'agent_start';        payload: AgentStartMessage }
  | { type: 'agent_status';       payload: AgentStatusMessage }
  | { type: 'star_selected';      payload: StarSelectedMessage }
  | { type: 'tool_selected';      payload: ToolSelectedMessage }
  | { type: 'assistant_delta';    payload: AssistantDeltaMessage }
  | { type: 'assistant_completed'; payload: AssistantCompletedMessage }
  | { type: 'mission_feedback';   payload: MissionFeedbackMessage }
  | { type: 'reputation_update';  payload: ReputationUpdateMessage };

export type Envelope = EnvelopeHeader & EnvelopePayload;

// ── Ciclo de vida del stream directo ─────────────────────────────────────────

export interface HandshakeMessage {
  fhsVersion: string;
  listenAddrs: string[];
  beacon: string;
  delegationToken?: DelegationToken;
}

export interface HandshakeAckMessage {
  fhsVersion: string;
  leaseSeconds: number;
  heartbeatSeconds: number;
  leaseExpires: number;
  acceptedServices: number;
  trustLevel: TrustLevel;
}

export interface PulseMessage {}

export interface PulseAckMessage {
  serverTimestamp: number;
}

export interface FhsErrorMessage {
  code: P2pFhsErrorCode;
  message: string;
}

// ── Mensajes de misión — Chat (Navigator ↔ Star) ─────────────────────────────

export interface ChatP2pRequestMessage {
  missionId: string;
  messages: P2pMessage[];
  tools: P2pToolDefinition[];
  model?: string;
}

export interface ChatP2pCancelMessage {
  missionId: string;
}

export interface ChatP2pDeltaMessage {
  missionId: string;
  delta: string;
}

export interface ChatP2pCompletedMessage {
  missionId: string;
  content: string;
  toolCalls: P2pToolCall[];
}

export interface ChatP2pErrorMessage {
  missionId: string;
  error: string;
}

export interface DispatchP2pAckMessage {
  missionId: string;
  queuedAt: number;
}

// ── Mensajes de misión — Tool (Navigator ↔ Satellite) ────────────────────────

export interface ToolP2pCallRequestMessage {
  missionId: string;
  toolCalls: P2pToolCall[];
}

export interface ToolP2pCancelMessage {
  missionId: string;
}

export interface ToolP2pCallResultMessage {
  missionId: string;
  toolCallId: string;
  result: string;
}

export interface ToolP2pCallErrorMessage {
  missionId: string;
  toolCallId: string;
  error: string;
}

export interface ToolP2pListRequestMessage {
  missionId: string;
}

export interface ToolP2pListResponseMessage {
  missionId: string;
  tools: P2pToolDefinition[];
}

// ── GossipSub — Presencia y descubrimiento ────────────────────────────────────
// Tópico: fhs/v1/nodes/advertise
// Publicado cada 30s por cada nodo activo; TTL default 60s.

export interface NodeAdvertiseMessage {
  did: string;
  beacon: string;
  multiaddrs: string[];
  timestamp: number;
  ttlSeconds: number;
  ephemeral?: boolean;
  delegatedBy?: string;
  trustLevel: TrustLevel;
  signature: Uint8Array;
}

// ── GossipSub — Dispatch de Missions ─────────────────────────────────────────
// Flujo: MissionOffer → MissionBid(s) → MissionAssign → stream directo

// Tópico: fhs/v1/missions/offer
export interface MissionOfferMessage {
  missionId: string;
  navigatorDid: string;
  navigatorMultiaddrs: string[];
  missionType: MissionType;
  requiredCapabilities: string[];
  preferredModel?: string;
  scope: FhsScope;
  bidDeadlineMs: number;
  timestamp: number;
  signature: Uint8Array;
}

// Tópico: fhs/v1/missions/bid
export interface MissionBidMessage {
  missionId: string;
  providerDid: string;
  providerMultiaddrs: string[];
  providerType: ProviderType;
  offeredCapabilities: string[];
  offeredModel?: string;
  reputationScore: number;
  estimatedLatencyMs: number;
  trustLevel: TrustLevel;
  timestamp: number;
  signature: Uint8Array;
}

// Tópico: fhs/v1/missions/assign
export interface MissionAssignMessage {
  missionId: string;
  navigatorDid: string;
  assignedProvider: string;
  timestamp: number;
  signature: Uint8Array;
}

// ── DHT Kademlia — Records ────────────────────────────────────────────────────
// Key DHT: DID del nodo; TTL recomendado: 24h

export interface DhtBeaconRecord {
  did: string;
  beacon: string;
  multiaddrs: string[];
  publishedAt: number;
  expiresAt: number;
  fhsVersion: string;
  signature: Uint8Array;
}

// Key DHT: "reputation/" + DID del provider
export interface DhtReputationRecord {
  providerDid: string;
  evaluatorDid: string;
  score: number;
  missionsSuccess: number;
  missionsFailed: number;
  avgLatencyMs: number;
  lastUpdated: number;
  signature: Uint8Array;
}

// ── GossipSub — Reputación ────────────────────────────────────────────────────
// Tópico: fhs/v1/reputation/update

export interface ReputationUpdateMessage {
  missionId: string;
  providerDid: string;
  navigatorDid: string;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  delegatedBy?: string;
  timestamp: number;
  signature: Uint8Array;
}

// ── Ephemeral Satellite (SPEC-EPHSAT-0001) ────────────────────────────────────

export interface DelegationToken {
  issuer: string;
  subject: string;
  capabilities: string[];
  wasmHash: string;
  expiresAt: number;
  signature: Uint8Array;
}

export interface MissionFeedbackMessage {
  missionId: string;
  providerDid: string;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  delegatedBy?: string;
}

// ── Portal ↔ Navigator ────────────────────────────────────────────────────────

export interface AgentStartMessage {
  sessionId: string;
  scope: FhsScope;
  model?: string;
}

export interface AgentStatusMessage {
  missionId: string;
  status: AgentStatus;
}

export interface StarSelectedMessage {
  missionId: string;
  providerId: string;
  model: string;
}

export interface ToolSelectedMessage {
  missionId: string;
  providerId: string;
  capabilityId: string;
}

export interface AssistantDeltaMessage {
  missionId: string;
  delta: string;
}

export interface P2pProvenanceInfo {
  providerId: string;
  model: string;
  completionTokens?: number;
  toolProviderIds: string[];
  dataExported: boolean;
  jurisdiction?: string;
  starReputation?: number;
}

export interface AssistantCompletedMessage {
  missionId: string;
  content: string;
  provenance: P2pProvenanceInfo;
}

// ── Entrada de peer en la caché local de Navigator ───────────────────────────
// No es un mensaje de protocolo; es la representación local que construye
// Navigator a partir de NodeAdvertiseMessage y DhtBeaconRecord.

export interface PeerCacheEntry {
  did: string;
  beacon: string;
  multiaddrs: string[];
  trustLevel: TrustLevel;
  reputationScore: number;
  lastSeen: number;
}
