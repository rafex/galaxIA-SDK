import { describe, it, expect } from "vitest";
import type {
  ToolParameterSchema,
  ToolDefinition,
  ToolCall,
  LlmMessage,
  GenerateRequest,
  GenerateResponse,
} from "../llm.js";

describe("ToolParameterSchema", () => {
  it("accepta schema válido", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      properties: { name: "string", age: "number" },
      required: ["name"],
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("name");
  });

  it("permite properties vacío", () => {
    const schema: ToolParameterSchema = { type: "string" };
    expect(schema.properties).toBeUndefined();
  });
});

describe("ToolDefinition", () => {
  it("acepta definición de tool completa", () => {
    const tool: ToolDefinition = {
      type: "function",
      function: {
        name: "weather",
        description: "Obtiene el clima",
        parameters: { type: "object", properties: { city: "string" }, required: ["city"] },
      },
    };
    expect(tool.function.name).toBe("weather");
  });
});

describe("ToolCall", () => {
  it("acepta tool call con arguments JSON", () => {
    const call: ToolCall = {
      id: "call-1",
      type: "function",
      function: { name: "weather", arguments: '{"city":"NYC"}' },
    };
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "NYC" });
  });
});

describe("LlmMessage", () => {
  it("crea mensaje de usuario", () => {
    const msg: LlmMessage = { role: "user", content: "Hola" };
    expect(msg.role).toBe("user");
  });

  it("crea mensaje con tool_calls", () => {
    const msg: LlmMessage = {
      role: "assistant",
      content: "Voy a buscar el clima",
      tool_calls: [{ id: "t1", type: "function", function: { name: "w", arguments: "{}" } }],
    };
    expect(msg.tool_calls).toHaveLength(1);
  });

  it("crea mensaje de tool response", () => {
    const msg: LlmMessage = { role: "tool", content: "20°C", tool_call_id: "t1" };
    expect(msg.tool_call_id).toBe("t1");
  });
});

describe("GenerateRequest", () => {
  it("crea request mínimo", () => {
    const req: GenerateRequest = {
      messages: [{ role: "user", content: "Hola" }],
    };
    expect(req.messages).toHaveLength(1);
    expect(req.stream).toBeUndefined();
  });

  it("crea request con tools y opciones", () => {
    const req: GenerateRequest = {
      model: "llama3",
      messages: [{ role: "user", content: "¿Qué tiempo hace?" }],
      tools: [{
        type: "function",
        function: { name: "weather", parameters: { type: "object" } },
      }],
      temperature: 0.7,
      max_tokens: 100,
    };
    expect(req.model).toBe("llama3");
    expect(req.tools).toHaveLength(1);
    expect(req.temperature).toBe(0.7);
  });
});

describe("GenerateResponse", () => {
  it("crea respuesta de modelo", () => {
    const res: GenerateResponse = {
      message: { role: "assistant", content: "Hace sol" },
      toolCalls: [],
      model: "llama3",
      provider: "did:key:macmini",
    };
    expect(res.model).toBe("llama3");
    expect(res.provider).toBe("did:key:macmini");
    expect(res.toolCalls).toHaveLength(0);
  });
});
