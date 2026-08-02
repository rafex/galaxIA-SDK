/**
 * Tipos para interacción con proveedores LLM.
 */

export interface ToolParameterSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: ToolParameterSchema;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface GenerateRequest {
  model?: string;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /**
   * Sugerencia de cuántas rondas de razonamiento usar (DEC-0055) — solo
   * aplica a un Nova (`NodeType: "agent"`); un Star (`"llm"`) la ignora, no
   * tiene loop. Es un techo sugerido, no una orden: el Nova puede resolver
   * en menos pasos si ya tiene suficiente para responder.
   */
  maxReasoningSteps?: number;
}

export interface GenerateResponse {
  message: LlmMessage;
  toolCalls: ToolCall[];
  model: string;
  provider: string;
  /** Cuántas rondas usó realmente un Nova (DEC-0055) — traceability/Flight Log, ausente si respondió un Star. */
  reasoningSteps?: number;
}

export type StreamHandler = (delta: string) => void;
