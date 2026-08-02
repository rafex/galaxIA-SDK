/**
 * Protocolo FHS v0.1 — Constantes compartidas.
 */

export const FHS_VERSION = "0.1";

/**
 * Unidad canónica de todo `timestamp` del protocolo: **milisegundos** desde
 * epoch Unix (lo que devuelve `Date.now()`). Antes de fijarlo aquí, la doc
 * mostraba segundos en `hello` y milisegundos en `dispatch.ack.queuedAt`, y
 * el Atlas validaba en segundos mientras todos los providers reales enviaban
 * ms — ningún provider podía registrarse (hallazgo de la revisión del
 * protocolo, 2026-07-10). Milisegundos gana porque es lo que ya enviaba todo
 * el ecosistema.
 */
export const TIMESTAMP_UNIT = "milliseconds" as const;

/** Ventana anti-replay: edad máxima aceptada de un mensaje firmado (ms). */
export const MAX_REPLAY_AGE_MS = 30_000;

/** Desfase de reloj tolerado hacia el futuro entre nodos (ms). */
export const MAX_CLOCK_SKEW_MS = 5_000;

/** Duración del lease de registro en segundos. */
export const DEFAULT_LEASE_SECONDS = 30;

/** Intervalo de heartbeat en segundos. */
export const HEARTBEAT_INTERVAL_SECONDS = 10;

/** Tiempo máximo sin renovación antes de marcar un nodo como 'lost'. */
export const LEASE_EXPIRE_SECONDS = DEFAULT_LEASE_SECONDS;

/** Tiempo máximo sin renovación antes de eliminar un nodo del registro. */
export const NODE_PURGE_SECONDS = 120;

/**
 * Códigos de error estandarizados (DEC-0013, `docs/protocolo-provider.md`).
 * Cualquier provider debe usar estos en `chat.error`/`tool.error` en vez de
 * inventar los suyos, para que quien consuma FHS pueda decidir (reintentar,
 * buscar otro nodo, informar al usuario) leyendo solo el código. No es un
 * tipo cerrado a nivel de protocolo (DEC-0026: el protocolo no mandata
 * implementación) — un provider en otro lenguaje puede emitir un código
 * distinto si no aplica ninguno de estos, pero debe preferir esta lista.
 */
export const FHS_ERROR_CODES = {
  NOT_IDENTIFIED: "NOT_IDENTIFIED",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  INVALID_MANIFEST: "INVALID_MANIFEST",
  ALREADY_REGISTERED: "ALREADY_REGISTERED",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
  /** El invocador no probó su identidad o está vetado (revisión 2026-07-10). */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** El `fhsVersion` anunciado en `hello` no es compatible con este Registry. */
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  /** La petición fue cancelada por quien la originó (`chat.cancel`/`tool.cancel`). */
  CANCELLED: "CANCELLED",
  /**
   * Backpressure (DEC-0072): el nodo está a su capacidad declarada
   * (`availability.maxConcurrentRequests`) y rechaza la petición de
   * inmediato, sin `dispatch.ack`. Quien invoca debe tratarlo como señal de
   * failover (probar otro nodo), no como fallo del nodo — en hardware
   * comunitario, rechazar rápido es más sano que encolar sin límite.
   */
  OVERLOADED: "OVERLOADED",
} as const;

export type FhsErrorCode = (typeof FHS_ERROR_CODES)[keyof typeof FHS_ERROR_CODES];
