/**
 * Mensajes del protocolo WebSocket entre proveedores y Registry FHS v0.1.
 */

import type { Beacon } from "./manifest.js";
import type { ArtifactRef } from "./types.js";
import type { ToolParameterSchema, GenerateRequest, GenerateResponse } from "./llm.js";

export interface BaseMessage {
  type: string;
  /** Milisegundos desde epoch Unix (`Date.now()`) — ver `TIMESTAMP_UNIT` en constants.ts. */
  timestamp?: number;
}

export interface HelloMessage extends BaseMessage {
  type: "hello";
  providerId: string;
  /** Milisegundos desde epoch Unix. */
  timestamp: number;
  /** Ed25519 base64 sobre `helloSignaturePayload(providerId, timestamp)`. */
  signature?: string;
  /**
   * Versión del protocolo que habla el nodo (negociación, revisión
   * 2026-07-10). Si el Registry no la soporta responde `error` con
   * `UNSUPPORTED_VERSION` en vez de fallar de formas opacas después.
   * Opcional por compatibilidad: ausente = se asume la versión del Registry.
   */
  fhsVersion?: string;
}

export interface WelcomeMessage extends BaseMessage {
  type: "welcome";
  /** did:key del Registry — con firma, deja de ser un string decorativo. */
  registryId: string;
  leaseSeconds: number;
  /** Intervalo de heartbeat que este Registry espera (segundos) — permite ajustarlo sin recompilar nodos. */
  heartbeatSeconds?: number;
  /** Versión del protocolo que habla el Registry. */
  fhsVersion?: string;
  /**
   * Ed25519 base64 sobre `welcomeSignaturePayload(registryId, timestamp)` —
   * el nodo puede verificar que no está entregando su manifiesto a un
   * Registry impostor (revisión 2026-07-10).
   */
  signature?: string;
}

export interface RegisterMessage extends BaseMessage {
  type: "register";
  providerId: string;
  manifest: Beacon;
  /** Milisegundos desde epoch Unix. */
  timestamp: number;
  /**
   * Ed25519 base64 sobre `registerSignaturePayload(providerId, timestamp,
   * manifest)` — la firma ancla el contenido del manifiesto (hash SHA-256
   * canónico), no solo identidad+frescura. Obligatorio: sin él (o sin
   * cubrir el manifiesto) el Registry responde `INVALID_SIGNATURE`
   * (DEC-0076 retiró el fallback al payload legado sin hash).
   */
  signature?: string;
}

export interface RegisteredMessage extends BaseMessage {
  type: "registered";
  /** Milisegundos desde epoch Unix (como todo timestamp del protocolo). */
  leaseExpires: number;
  acceptedServices: number;
}

export interface PingMessage extends BaseMessage {
  type: "ping";
}

export interface PongMessage extends BaseMessage {
  type: "pong";
  timestamp: number;
}

export interface NodeOnlineMessage extends BaseMessage {
  type: "node.online";
  providerId: string;
  providerName: string;
  services: { kind: string; capabilities: string[] }[];
}

export interface NodeLostMessage extends BaseMessage {
  type: "node.lost";
  providerId: string;
  providerName: string;
  services: { kind: string; capabilities: string[] }[];
}

export interface NodeUpdatedMessage extends BaseMessage {
  type: "node.updated";
  providerId: string;
  providerName: string;
  services: { kind: string; capabilities: string[] }[];
}

/**
 * Rechazo del Registry antes de completar el registro — ej. `hello` con un
 * `providerId` que ya tiene una conexión activa (DEC-0009). El provider debe
 * tratar esto igual que un cierre de conexión: no reintentar con el mismo
 * `providerId` sin resolver el conflicto primero.
 */
export interface RegistryErrorMessage extends BaseMessage {
  type: "error";
  data: {
    code: "NOT_IDENTIFIED" | "ALREADY_REGISTERED" | "INVALID_MANIFEST" | "INVALID_SIGNATURE" | "PARSE_ERROR" | "UNSUPPORTED_VERSION" | "UNAUTHORIZED";
    message: string;
  };
}

export type RegistryOutboundMessage =
  | WelcomeMessage
  | RegisteredMessage
  | PongMessage
  | NodeOnlineMessage
  | NodeLostMessage
  | RegistryErrorMessage
  | NodeUpdatedMessage;

export type RegistryInboundMessage =
  | HelloMessage
  | RegisterMessage
  | PingMessage;

export type FhsMessage = RegistryInboundMessage | RegistryOutboundMessage;

// ============================================================
// Chat protocol (Agent Server ↔ LLM Provider over FHS WebSocket)
// ============================================================

/**
 * Campos de autenticación del invocador (revisión 2026-07-10) — presentes en
 * `chat.request`, `tool.call` y `tool.list`. Sin ellos, cualquier peer de la
 * LAN podía consumir el cómputo de un provider. Opcionales por
 * compatibilidad; un provider puede exigirlos y responder `UNAUTHORIZED`.
 */
export interface CallerAuth {
  /** did:key del invocador (Navigator u otro agente). */
  callerId?: string;
  /** Ed25519 base64 sobre `invokeSignaturePayload(callerId, missionId, timestamp)`. */
  signature?: string;
}

export interface ChatRequestMessage extends BaseMessage, CallerAuth {
  type: "chat.request";
  missionId: string;
  request: GenerateRequest;
}

/**
 * Cancelación best-effort (revisión 2026-07-10): quien originó un
 * `chat.request` avisa que dejó de esperar (timeout, failover, usuario que
 * cerró) para que el nodo no siga quemando CPU — el recurso más escaso en
 * hardware comunitario. El provider debe abortar si puede y responder
 * `chat.error` con código `CANCELLED`; ignorarlo no rompe el protocolo.
 */
export interface ChatCancelMessage extends BaseMessage {
  type: "chat.cancel";
  missionId: string;
}

export interface ChatDeltaMessage extends BaseMessage {
  type: "chat.delta";
  missionId: string;
  delta: string;
}

export interface ChatCompletedMessage extends BaseMessage {
  type: "chat.completed";
  missionId: string;
  response: GenerateResponse;
}

export interface ChatErrorMessage extends BaseMessage {
  type: "chat.error";
  missionId: string;
  code: string;
  message: string;
}

/**
 * Ack del mosquito/dispatcher del nodo: confirma que encoló la petición y
 * va a procesarla, antes de empezar el trabajo real (SPEC-SATRATING-0001).
 * Obligatorio para todo chat.request/tool.call que el nodo acepte; si lo
 * rechaza de inmediato, va directo a chat.error/tool.error sin este ack.
 * Compatible hacia atrás: un nodo que no lo envía sigue funcionando igual,
 * solo sin latencia de despacho en las métricas del Registry.
 */
export interface DispatchAckMessage extends BaseMessage {
  type: "dispatch.ack";
  missionId: string;
  queuedAt: number;
}

export type LlmProviderInboundMessage = ChatRequestMessage | ChatCancelMessage;

export type LlmProviderOutboundMessage =
  | ChatDeltaMessage
  | ChatCompletedMessage
  | ChatErrorMessage
  | DispatchAckMessage;

export type LlmProviderMessage =
  | LlmProviderInboundMessage
  | LlmProviderOutboundMessage;

// ============================================================
// Tool call protocol (Agent Server ↔ MCP/Tool Provider over FHS WebSocket)
// ============================================================

export interface ToolCallRequestMessage extends BaseMessage, CallerAuth {
  type: "tool.call";
  missionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** Cancelación best-effort de un `tool.call` — misma semántica que `chat.cancel`. */
export interface ToolCancelMessage extends BaseMessage {
  type: "tool.cancel";
  missionId: string;
}

export interface ToolCallResultMessage extends BaseMessage {
  type: "tool.result";
  missionId: string;
  toolName: string;
  /**
   * `{ type: "artifact" }` (DEC-0046) — un provider puede devolver un
   * resultado binario grande subiéndolo él mismo a IPFS y regresando un
   * `ArtifactRef` en vez de un payload inline, misma forma simétrica con la
   * que puede recibir un adjunto.
   */
  content: Array<{ type: "text"; text: string } | { type: "artifact"; artifact: ArtifactRef }>;
}

export interface ToolCallErrorMessage extends BaseMessage {
  type: "tool.error";
  missionId: string;
  toolName: string;
  code: string;
  message: string;
}

export interface ToolListRequestMessage extends BaseMessage, CallerAuth {
  type: "tool.list";
  missionId: string;
}

export interface ToolListResponseMessage extends BaseMessage {
  type: "tool.list.response";
  missionId: string;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: ToolParameterSchema;
  }>;
}

export type ToolProviderInboundMessage =
  | ToolCallRequestMessage
  | ToolListRequestMessage
  | ToolCancelMessage;

export type ToolProviderOutboundMessage =
  | ToolCallResultMessage
  | ToolCallErrorMessage
  | ToolListResponseMessage
  | DispatchAckMessage;

export type ToolProviderMessage =
  | ToolProviderInboundMessage
  | ToolProviderOutboundMessage;
