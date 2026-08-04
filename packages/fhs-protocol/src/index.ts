/** Exportaciones públicas del wire protocol FHS generado desde el IDL canónico. */

export * from "./constants.js";
// Tipos locales de aplicación: no son wire protocol y se migrarán por separado.
export * from "./types.js";
export * from "./manifest.js";
export * from "./llm.js";
export * from "./identity.js";
export * from "./wire.js";
// Contratos generados: acceso explícito para impedir colisiones con modelos locales.
export * as FhsProto from "./generated/fhs-protocol_pb.js";
