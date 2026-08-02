/**
 * Eventos SSE transmitidos desde el Agent Backend hacia el frontend.
 */

import type { KbCitation } from "./types.js";

export interface SessionEvent {
  type: "session";
  data: { conversationId: string };
}

export interface AgentStatusEvent {
  type: "agent.status";
  data: { conversationId: string; status: string; message: string };
}

export interface LlmSelectedEvent {
  type: "llm.selected";
  data: {
    conversationId: string;
    providerId: string;
    providerName: string;
    modelId: string;
    reason: string[];
  };
}

export interface LlmStreamingEvent {
  type: "llm.streaming";
  data: { conversationId: string; delta: string };
}

export interface ToolSelectedEvent {
  type: "tool.selected";
  data: {
    conversationId: string;
    capability: string;
    providerId: string;
    providerName: string;
  };
}

export interface ToolRunningEvent {
  type: "tool.running";
  data: { conversationId: string; name: string; providerId: string };
}

export interface ToolCompletedEvent {
  type: "tool.completed";
  data: { conversationId: string; name: string; duration: number; success: boolean };
}

export interface ToolErrorEvent {
  type: "tool.error";
  data: { conversationId: string; name: string; error: string };
}

export interface AssistantDeltaEvent {
  type: "assistant.delta";
  data: { conversationId: string; text: string };
}

export interface OcrExtractedEvent {
  type: "ocr.extracted";
  data: { conversationId: string; filename: string; text: string };
}

export interface ProvenanceInfo {
  llm: {
    providerId: string;
    providerName: string;
    model: string;
  };
  tools: Array<{
    capability: string;
    providerId: string;
    providerName: string;
    retention?: string;
    /** Citas de los fragmentos usados de esta tool, si las expone (DEC-0049). */
    citations?: KbCitation[];
  }>;
  dataExported: string;
  jurisdiction: string;
}

export interface AssistantCompletedEvent {
  type: "assistant.completed";
  data: { conversationId: string; provenance: ProvenanceInfo };
}

export interface NodeLostEvent {
  type: "node.lost";
  data: {
    providerId: string;
    providerName: string;
    services: { kind: string; capabilities: string[] }[];
  };
}

export interface NodeOnlineEvent {
  type: "node.online";
  data: {
    providerId: string;
    providerName: string;
    services: { kind: string; capabilities: string[] }[];
  };
}

/**
 * SPEC-KB-0002 (DEC-0054) — puede traer más de un candidato (fan-out
 * multi-KB, `kbMaxPerQuestion`) o exactamente uno resuelto por el LLM en el
 * caso límite (sin match determinístico confiable) — nunca oculto, siempre
 * mostrado al usuario antes de consultar (requisito no negociable del spec).
 */
export interface KbRecommendedEvent {
  type: "kb.recommended";
  data: {
    conversationId: string;
    candidates: Array<{ providerId: string; providerName: string; description: string }>;
    /** true si ningún candidato superó el umbral determinístico y el LLM eligió entre las KBs disponibles (paso 5, SPEC-KB-0002). */
    chosenByLlm?: boolean;
  };
}

export interface ErrorEvent {
  type: "error";
  // conversationId ausente = error de conexión antes de establecer una conversación
  // (ej. PARSE_ERROR); se difunde a ese socket únicamente, nunca a otros clientes.
  data: { conversationId?: string; code: string; message: string };
}

/** TASK-FHS-0010 — failover automático a la siguiente tool candidata tras un `tool.error`. */
export interface ProviderFailoverEvent {
  type: "provider.failover";
  data: {
    conversationId: string;
    capability: string;
    failedProviderId: string;
    failedProviderName: string;
    nextProviderId: string;
    nextProviderName: string;
  };
}

export type AgentSSEEvent =
  | SessionEvent
  | AgentStatusEvent
  | LlmSelectedEvent
  | LlmStreamingEvent
  | ToolSelectedEvent
  | ToolRunningEvent
  | ToolCompletedEvent
  | ToolErrorEvent
  | AssistantDeltaEvent
  | AssistantCompletedEvent
  | OcrExtractedEvent
  | NodeLostEvent
  | NodeOnlineEvent
  | KbRecommendedEvent
  | ProviderFailoverEvent
  | ErrorEvent;
