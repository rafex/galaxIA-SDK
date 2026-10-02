/**
 * Comando de chat que este nodo declara en su Beacon (SPEC-CMD-0001): el
 * Navigator lo descubre del anuncio firmado, no lo conoce de antemano.
 *
 * Es el contrato de `math.arithmetic.solve` / `arithmetic_solve` (ver engine.ts);
 * debe coincidir con `galaxIA/idl/fixtures/command-descriptors.json` (la
 * prueba compara la huella con la del fixture compartido con Rust).
 */
import { create } from "@bufbuild/protobuf";
import { FhsProto } from "@rafex/galaxia-fhs-protocol";
import { CAPABILITY, MAX_DEPTH, MAX_EXPRESSION_CHARS, MAX_RESULT_CHARS, TOOL } from "./engine.js";

/** Puntos de código permitidos, ordenados y sin duplicados (forma canónica). */
const ALLOWED_CHARS = " ()*+-./0123456789^";

export const CALC_COMMAND = create(FhsProto.CommandDescriptorSchema, {
  name: "calc",
  capabilityId: CAPABILITY,
  toolName: TOOL,
  summary: "Calcula una expresión aritmética",
  args: [
    create(FhsProto.CommandArgSchema, {
      name: "expression",
      description: "Expresión con + - * / ^ y paréntesis",
      type: FhsProto.CommandArgType.STRING,
      required: true,
      rest: true,
      maxLength: MAX_EXPRESSION_CHARS,
      allowedChars: ALLOWED_CHARS,
      maxNesting: MAX_DEPTH,
    }),
  ],
  result: create(FhsProto.CommandResultSchema, {
    type: FhsProto.CommandArgType.NUMBER,
    maxChars: MAX_RESULT_CHARS,
  }),
});
