/**
 * Tipos base del protocolo FHS v0.1.
 */

/**
 * "agent" (Nova, DEC-0055) — nodo de razonamiento con loop propio (varias
 * rondas internas antes de responder), a diferencia de "llm" (Star), que es
 * una sola llamada de completions sin estado ni loop. El protocolo solo
 * declara que el tipo existe y transporta la sugerencia de cuántos pasos
 * usar (`GenerateRequest.maxReasoningSteps`) — cómo un Nova implementa su
 * loop internamente es responsabilidad exclusiva del provider (DEC-0026).
 */
export type NodeType = "llm" | "mcp" | "multi" | "agent";

export type NodeVisibility = "local" | "network" | "community" | "external";

export type ServiceStatus = "available" | "unavailable" | "degraded" | "unknown";

export type NodeStatus = "online" | "lost" | "offline";

export type PrivacyScope = "local" | "network" | "community" | "external";

export interface NodeProfile {
  /** Identificador verificable del proveedor. En v0.1 es did:key:<nombre-simple>. */
  id: string;
  /** Nombre legible para humanos. */
  name: string;
  /** Tipo de proveedor. */
  type: NodeType;
  /** Visibilidad/ámbito del proveedor. */
  visibility: NodeVisibility;
  /** Región opcional. */
  region?: string;
}

export interface EndpointInfo {
  /** Protocolo de transporte de la capa de aplicación. */
  protocol: "openai-compatible" | "mcp" | "custom" | "fhs";
  /** URL base del servicio. */
  url: string;
  /** Transporte MCP cuando aplica. */
  transport?: "streamable-http" | "stdio" | "sse";
}

export interface Signal {
  /** Identificador único de la capacidad, e.g. document.ocr. */
  id: string;
  /** Nombre legible. */
  name?: string;
  /** Tipos MIME de entrada soportados. */
  inputMediaTypes?: string[];
  /** Idiomas soportados. */
  languages?: string[];
  /** Descripción corta. */
  description?: string;
  /**
   * Tags autodeclarados por el operador (DEC-0028) — mismo nivel de
   * confianza que `description`, no verificados por el Registry/Atlas.
   * Señal adicional para el matching determinístico del modo "recomendado"
   * de kb-provider (SPEC-KB-0001). Los tags de comunidad (agregados por
   * Atlas a partir de feedback real de usuarios) quedan bloqueados hasta
   * que exista identidad de usuario (SPEC-AUTH-0001) — no se agregan aquí.
   */
  tags?: string[];
}

/**
 * Referencia declarativa (DEC-0050) a un perfil de parseo tolerante conocido
 * por la comunidad para un modelo — nunca la regla en sí, solo el
 * identificador y dónde vive el catálogo real. El catálogo (las reglas de
 * parseo, cómo se versionan, cómo se evalúan) es un recurso externo al
 * protocolo (ver `galaxia-parser-catalog`) — mismo principio que
 * DEC-0026/DEC-0037/DEC-0046 ya establecieron para KB/ArtifactRef: el
 * protocolo transporta la referencia, nunca el motor detrás de ella.
 */
export interface ModelParserProfile {
  /** Id del perfil en el catálogo, e.g. "jinja-plain-json-toolcall-fallback-v1". */
  profileId: string;
  /** Dónde vive el catálogo real (repo, paquete, URL) — informativo, no resuelto por el protocolo. */
  registryRef?: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Capacidades del modelo, e.g. chat, tool.calling. */
  capabilities: string[];
  contextWindow?: number;
  languages?: string[];
  toolCalling?: {
    supported: boolean;
    mode?: "native" | "prompt-template" | "unsupported";
    formats?: string[];
    parallelCalls?: boolean;
    maxToolsPerRequest?: number;
    /** Perfil de parseo tolerante declarado para este modelo (DEC-0050). */
    parserProfile?: ModelParserProfile;
  };
  privacy?: {
    retention?: string;
    trainingUse?: boolean;
  };
  availability?: {
    status?: ServiceStatus;
    /**
     * Capacidad declarada del nodo para este modelo (DEC-0072): cuántas
     * peticiones simultáneas acepta antes de rechazar con `OVERLOADED`.
     * El Agent Server la usa como filtro best-effort al resolver (evita
     * mandar la N+1 a un nodo que ya tiene N en vuelo desde este mismo
     * Agent Server); el provider es quien la hace cumplir de verdad.
     */
    maxConcurrentRequests?: number;
  };
}

/**
 * Referencia a un binario (DEC-0046) — modela solo el endpoint de
 * **lectura** (inline o gateway IPFS). El endpoint de escritura (con
 * credenciales) es responsabilidad local de quien sube (Navigator, DEC-0051)
 * y nunca forma parte del protocolo. Usado por `KbCitation.sourceArtifact` y
 * por `file` en `ToolCallRequestMessage.arguments` (reemplaza `file_base64`,
 * DEC-0047).
 */
export type ArtifactRef =
  | { transport: "inline"; base64: string; filename?: string }
  | {
      transport: "ipfs";
      cid: string;
      network: "public" | "private";
      gatewayUrl?: string;
      filename?: string;
      /**
       * DEC-0052 — "ephemeral" (default si se omite): quien recibió el
       * archivo debe borrarlo tras usarlo. "reuse": no debe borrarlo, el
       * borrado queda como responsabilidad del usuario. Ver SPEC-IPFS-0001.
       */
      retention?: "ephemeral" | "reuse";
    };

/**
 * Metadata de citación y fuente primaria de un resultado de `kb.query`
 * (SPEC-KB-0003, DEC-0049). Campos de primera clase aplican a cualquier KB
 * sin importar el dominio; `metadata` es un bag libre para lo específico de
 * cada dominio (jurisdicción, artículo, etc.) — el protocolo no impone
 * vocabulario de dominio.
 */
export interface KbCitation {
  documentTitle: string;
  sourceArtifact?: ArtifactRef;
  sourceUrl?: string;
  versionDate?: string;
  pageStart?: number;
  pageEnd?: number;
  tags?: string[];
  metadata?: Record<string, string>;
}

/** Un fragmento devuelto por `kb.query` — `citation` es opcional (DEC-0049). */
export interface KbQueryChunk {
  text: string;
  score: number;
  citation?: KbCitation;
}

/**
 * Formato generalizado de retención (DEC-0025): `"none"` (no se guarda
 * nada más allá de la petición en curso), `"session"` (vive mientras dure
 * la conversación, sin más precisión), un TTL explícito en duración ISO
 * 8601, o `"permanent-readonly"` (contenido curado por el operador, sin
 * expiración — usado por kb-provider, nunca por contenido de usuario).
 */
export type RetentionPolicy =
  | "none"
  | "session"
  | { ttl: string }
  | "permanent-readonly";

export interface PrivacyPolicy {
  retention?: RetentionPolicy;
  /**
   * Obligatorio quando `retention` no es `"none"` (DEC-0025) — texto que el
   * Portal debe mostrar al usuario antes de aceptar el primer adjunto,
   * explicando en lenguaje llano qué pasa con su contenido.
   */
  warning?: string;
  trainingUse?: boolean;
  jurisdiction?: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface AuthenticationInfo {
  methods: string[];
}

export interface SignatureInfo {
  algorithm: string;
  value: string;
}

/** Representación interna de un servicio publicado por un nodo. */
export interface PublishedService {
  id: string;
  nodeId: string;
  kind: NodeType;
  endpoint: EndpointInfo;
  capabilities: Signal[];
  status: ServiceStatus;
  models?: ModelInfo[];
  /**
   * Ámbito declarado por el nodo (`NodeProfile.visibility`), propagado al
   * servicio publicado para que el Agent Server pueda aplicar el scope de
   * privacidad del usuario (regla 6 del protocolo) sin volver a pedir el
   * manifiesto. Ausente en registros previos a la revisión 2026-07-10.
   */
  visibility?: NodeVisibility;
  privacy?: PrivacyPolicy;
  authentication?: AuthenticationInfo;
  updatedAt: number;
}

/** Representación interna de un nodo registrado. */
export interface RegisteredNode {
  providerId: string;
  name: string;
  status: NodeStatus;
  lastSeen: number;
  leaseExpires: number;
  registeredAt: number;
  services: PublishedService[];
}
