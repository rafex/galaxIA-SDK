/**
 * Comandos de chat autodescubiertos (SPEC-CMD-0001, DEC-0100).
 *
 * Replica a `rust/fhs/src/commands.rs`: validación de descriptores, huella del
 * contrato, gramática de entrada y validación del resultado. Apto para el
 * navegador. Ambos se prueban con `galaxIA/idl/fixtures/command-descriptors.json`.
 */
import { clone, toBinary } from "@bufbuild/protobuf";
import { framed, toHex } from "./authorization.js";
import {
  CommandArgType,
  CommandDescriptorSchema,
  type CommandArg,
  type CommandDescriptor,
  type DynamicValue,
} from "./generated/fhs-protocol_pb.js";

export const DOMAIN_CONTRACT = "fhs/cmd/contract";
export const DOMAIN_REGISTRY = "fhs/cmd/registry";
export const MIN_COMMANDS_VERSION: readonly [number, number] = [0, 2];

export const MAX_COMMANDS = 8;
export const MAX_ARGS = 4;
export const MAX_COMMANDS_BYTES = 4096;
export const MAX_LINE_CHARS = 2048;
export const MAX_SUMMARY_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 80;
export const MAX_ALLOWED_CHARS = 128;
export const MAX_STRING_LENGTH = 1024;
export const MAX_NESTING = 64;
export const MAX_ENUM_VALUES = 16;
export const MAX_ENUM_VALUE_CHARS = 64;
export const MAX_RESULT_CHARS = 64;
export const MAX_SCALAR_CHARS = 32;
export const RESERVED_NAMES: readonly string[] = ["ayuda", "help", "comandos"];

const encoder = new TextEncoder();
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]*$/u;

const codePoints = (text: string): string[] => [...text];

/** "Imprimible": letras, marcas, números, puntuación, símbolos y U+0020. */
export function isPlainText(text: string, maxChars: number): boolean {
  return codePoints(text).length <= maxChars && PRINTABLE.test(text);
}

function isIdent(text: string, max: number, extra: string): boolean {
  return new RegExp(`^[a-z][a-z0-9${extra}]*$`).test(text) && codePoints(text).length <= max;
}

export const isCommandName = (name: string): boolean => isIdent(name, 24, "-");
const isArgName = (name: string): boolean => isIdent(name, 24, "_");

const bytesLess = (a: string, b: string): boolean => {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
  return x.length < y.length;
};

// ── Registro cerrado ─────────────────────────────────────────────────────────

export interface RegistryEntry {
  tools: string[];
  admission: "open" | "trusted";
  errorCodes: Record<string, string>;
}

export interface Registry {
  version: number;
  entries: Record<string, RegistryEntry>;
  /** `SHA-256("fhs/cmd/registry" ‖ 0x00 ‖ "1" ‖ 0x00 ‖ bytes exactos)` en hex. */
  digest: string;
}

export class DescriptorError extends Error {}

const fail = (message: string): never => {
  throw new DescriptorError(message);
};

function onlyKeys(value: object, keys: string[], where: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where}: campo desconocido ${key}`);
}

export function parseRegistry(json: string): Registry {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fail("registro de comandos inválido: no es JSON");
  }
  const top = raw as { registry_version?: unknown; entries?: Record<string, Record<string, unknown>> };
  if (typeof top !== "object" || top === null) return fail("registro inválido");
  onlyKeys(top, ["registry_version", "entries"], "registro");
  if (top.registry_version !== 1) fail("registry_version no soportada");
  if (!top.entries || Object.keys(top.entries).length === 0) fail("el registro no tiene entradas");
  const entries: Record<string, RegistryEntry> = {};
  for (const [capability, entry] of Object.entries(top.entries ?? {})) {
    if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(capability)) fail(`capacidad inválida: ${capability}`);
    onlyKeys(entry, ["tools", "admission", "error_codes"], capability);
    const tools = entry.tools as string[];
    if (!Array.isArray(tools) || tools.length < 1 || tools.length > 8 || new Set(tools).size !== tools.length) {
      fail(`${capability}: tools inválidas`);
    }
    if (!tools.every((t) => /^[a-z][a-z0-9_]{0,31}$/.test(t))) fail(`${capability}: tool inválida`);
    if (entry.admission !== "open" && entry.admission !== "trusted") fail(`${capability}: admission inválida`);
    const codes = entry.error_codes as Record<string, string>;
    if (typeof codes !== "object" || codes === null || Object.keys(codes).length > 16) fail(`${capability}: error_codes inválido`);
    for (const [code, text] of Object.entries(codes)) {
      if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(code) || typeof text !== "string" || text.length === 0 || !isPlainText(text, 120)) {
        fail(`${capability}: código de error inválido ${code}`);
      }
    }
    entries[capability] = { tools, admission: entry.admission as "open" | "trusted", errorCodes: codes };
  }
  return { version: 1, entries, digest: toHex(framed(DOMAIN_REGISTRY, encoder.encode(json))) };
}

/** Texto propio del Navigator para un error: solo coincide con un código exacto. */
export function errorText(registry: Registry, capability: string, error: string): string | undefined {
  const codes = registry.entries[capability]?.errorCodes;
  return codes && Object.prototype.hasOwnProperty.call(codes, error) ? codes[error] : undefined;
}

// ── Validación de descriptores ───────────────────────────────────────────────

function canonicalChars(chars: string): boolean {
  const points = codePoints(chars);
  if (points.length > MAX_ALLOWED_CHARS) return false;
  for (let i = 1; i < points.length; i += 1) if (points[i - 1].codePointAt(0)! >= points[i].codePointAt(0)!) return false;
  return PRINTABLE.test(chars);
}

function validateArg(command: string, arg: CommandArg, last: boolean): void {
  const at = (msg: string): never => fail(`/${command} ${arg.name}: ${msg}`);
  if (!isArgName(arg.name)) at("nombre de argumento inválido");
  if (!isPlainText(arg.description, MAX_DESCRIPTION_CHARS)) at("descripción inválida");
  const scalar = [CommandArgType.INTEGER, CommandArgType.NUMBER, CommandArgType.BOOLEAN].includes(arg.type);
  if (arg.type === CommandArgType.STRING) {
    if (arg.maxLength < 1 || arg.maxLength > MAX_STRING_LENGTH) at("max_length fuera de 1..=1024");
    if (!canonicalChars(arg.allowedChars)) at("allowed_chars no canónico");
    if (arg.maxNesting < 0 || arg.maxNesting > MAX_NESTING) at("max_nesting fuera de 0..=64");
    if (arg.enumValues.length > 0) at("enum_values no aplica a STRING");
    if (arg.rest && !last) at("solo el último argumento puede ser rest");
  } else if (arg.type === CommandArgType.ENUM) {
    const values = arg.enumValues;
    if (values.length < 1 || values.length > MAX_ENUM_VALUES) at("enum_values debe tener de 1 a 16 valores");
    const ordered = values.every((v, i) => i === 0 || bytesLess(values[i - 1], v));
    const valid = values.every((v) => {
      const n = codePoints(v).length;
      return n >= 1 && n <= MAX_ENUM_VALUE_CHARS && PRINTABLE.test(v) && !v.includes(" ");
    });
    if (!ordered || !valid) at("enum_values no canónico");
    if (arg.maxLength !== 0 || arg.allowedChars !== "" || arg.maxNesting !== 0 || arg.rest) at("campos de STRING no aplican a ENUM");
  } else if (scalar) {
    if (arg.maxLength !== 0 || arg.allowedChars !== "" || arg.maxNesting !== 0 || arg.rest || arg.enumValues.length > 0) {
      at("el tipo escalar no admite límites ni rest");
    }
  } else {
    at("tipo de argumento no especificado");
  }
}

function validateDescriptor(d: CommandDescriptor, beaconCapabilities: readonly string[], registry: Registry): void {
  const name = d.name;
  if (!isCommandName(name) || RESERVED_NAMES.includes(name)) fail(`nombre de comando inválido o reservado: ${name}`);
  const entry = registry.entries[d.capabilityId];
  if (!entry) fail(`/${name}: la capacidad ${d.capabilityId} no está en el registro de comandos`);
  if (!beaconCapabilities.includes(d.capabilityId)) fail(`/${name}: la capacidad ${d.capabilityId} no está anunciada en el Beacon`);
  if (!entry.tools.includes(d.toolName)) fail(`/${name}: herramienta no permitida: ${d.toolName}`);
  if (!isPlainText(d.summary, MAX_SUMMARY_CHARS)) fail(`/${name}: summary inválido`);
  if (d.args.length > MAX_ARGS) fail(`/${name}: más de ${MAX_ARGS} argumentos`);
  const names = new Set<string>();
  let seenOptional = false;
  d.args.forEach((arg, index) => {
    if (names.has(arg.name)) fail(`/${name}: argumento repetido ${arg.name}`);
    names.add(arg.name);
    validateArg(name, arg, index + 1 === d.args.length);
    if (arg.required && seenOptional) fail(`/${name}: un obligatorio no puede seguir a un opcional`);
    seenOptional ||= !arg.required;
  });
  const result = d.result;
  const kinds = [CommandArgType.NUMBER, CommandArgType.INTEGER, CommandArgType.BOOLEAN];
  if (!result || !kinds.includes(result.type) || result.maxChars < 1 || result.maxChars > MAX_RESULT_CHARS) {
    fail(`/${name}: result inválido`);
  }
}

/** Valida todos los descriptores de un Beacon; un incumplimiento invalida el anuncio de comandos. */
export function validateDescriptors(
  commands: readonly CommandDescriptor[],
  beaconCapabilities: readonly string[],
  registry: Registry,
): void {
  if (commands.length > MAX_COMMANDS) fail(`más de ${MAX_COMMANDS} comandos`);
  const encoded = commands.reduce((sum, c) => {
    const len = toBinary(CommandDescriptorSchema, c).length;
    return sum + 1 + varintLength(len) + len;
  }, 0);
  if (encoded > MAX_COMMANDS_BYTES) fail(`commands ocupa ${encoded} bytes`);
  for (let i = 1; i < commands.length; i += 1) {
    if (!bytesLess(commands[i - 1].name, commands[i].name)) fail("los comandos deben estar ordenados por nombre y ser únicos");
  }
  for (const command of commands) validateDescriptor(command, beaconCapabilities, registry);
}

function varintLength(value: number): number {
  let n = 1;
  let v = value;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    n += 1;
  }
  return n;
}

/** Huella del contrato ejecutable: sin `summary` ni `description`. */
export function fingerprint(descriptor: CommandDescriptor): string {
  const contract = clone(CommandDescriptorSchema, descriptor);
  contract.summary = "";
  for (const arg of contract.args) arg.description = "";
  return toHex(framed(DOMAIN_CONTRACT, toBinary(CommandDescriptorSchema, contract)));
}

// ── Gramática de entrada ─────────────────────────────────────────────────────

export type ArgValue =
  | { type: "string"; value: string }
  | { type: "integer"; value: string }
  | { type: "number"; value: string }
  | { type: "boolean"; value: string }
  | { type: "enum"; value: string };

export type ParseErrorKind =
  | "line_too_long"
  | "missing"
  | "extra"
  | "too_long"
  | "bad_char"
  | "too_deep"
  | "bad_integer"
  | "bad_number"
  | "bad_boolean"
  | "bad_enum";

export class ParseError extends Error {
  constructor(
    readonly kind: ParseErrorKind,
    readonly arg = "",
  ) {
    super(`${kind}${arg ? `: ${arg}` : ""}`);
  }
}

export type LineKind =
  | { kind: "plain" }
  | { kind: "escaped"; text: string }
  | { kind: "command"; name: string; rest: string };

const BLANK = /[ \t]/;
const trimBlankStart = (s: string): string => s.replace(/^[ \t]+/, "");
const trimBlankEnd = (s: string): string => s.replace(/[ \t]+$/, "");

export function classifyLine(input: string): LineKind {
  const line = input.trim();
  if (line.startsWith("//")) return { kind: "escaped", text: line.slice(1) };
  if (!line.startsWith("/")) return { kind: "plain" };
  const body = line.slice(1);
  const end = body.search(BLANK);
  const cut = end === -1 ? body.length : end;
  return { kind: "command", name: body.slice(0, cut).replace(/[A-Z]/g, (c) => c.toLowerCase()), rest: body.slice(cut) };
}

const INT = /^-?(0|[1-9][0-9]*)$/;
const NUM = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** `-0` (y `-0.0…`) se normaliza a `0`. */
export function canonicalNumber(text: string): string {
  return text.startsWith("-") && /^[0.]*$/.test(text.slice(1)) ? text.slice(1) : text;
}

function parseInteger(arg: string, token: string): ArgValue {
  if (!INT.test(token) || codePoints(token).length > MAX_SCALAR_CHARS) throw new ParseError("bad_integer", arg);
  const big = BigInt(token);
  if (big > 9223372036854775807n || big < -9223372036854775808n) throw new ParseError("bad_integer", arg);
  return { type: "integer", value: big.toString() };
}

function parseNumber(arg: string, token: string): ArgValue {
  if (!NUM.test(token) || codePoints(token).length > MAX_SCALAR_CHARS) throw new ParseError("bad_number", arg);
  return { type: "number", value: canonicalNumber(token) };
}

function parseValue(arg: CommandArg, token: string): ArgValue {
  switch (arg.type) {
    case CommandArgType.STRING: {
      const chars = codePoints(token);
      if (chars.length > arg.maxLength) throw new ParseError("too_long", arg.name);
      if (arg.allowedChars !== "") {
        const allowed = new Set(codePoints(arg.allowedChars));
        if (chars.some((c) => !allowed.has(c))) throw new ParseError("bad_char", arg.name);
      }
      if (arg.maxNesting > 0) {
        let depth = 0;
        let max = 0;
        for (const c of chars) {
          if (c === "(") {
            depth += 1;
            max = Math.max(max, depth);
          } else if (c === ")") depth = Math.max(0, depth - 1);
        }
        if (max > arg.maxNesting) throw new ParseError("too_deep", arg.name);
      }
      return { type: "string", value: token };
    }
    case CommandArgType.INTEGER:
      return parseInteger(arg.name, token);
    case CommandArgType.NUMBER:
      return parseNumber(arg.name, token);
    case CommandArgType.BOOLEAN:
      if (token === "true" || token === "false") return { type: "boolean", value: token };
      throw new ParseError("bad_boolean", arg.name);
    case CommandArgType.ENUM:
      if (arg.enumValues.includes(token)) return { type: "enum", value: token };
      throw new ParseError("bad_enum", arg.name);
    default:
      throw new ParseError("missing", arg.name);
  }
}

/** Parsea y valida lo que sigue a `/nombre` con el descriptor. */
export function parseArgs(descriptor: CommandDescriptor, rest: string): { name: string; value: ArgValue }[] {
  if (codePoints(rest).length > MAX_LINE_CHARS) throw new ParseError("line_too_long");
  const out: { name: string; value: ArgValue }[] = [];
  let cursor = trimBlankStart(rest);
  for (const arg of descriptor.args) {
    if (cursor === "") {
      if (arg.required) throw new ParseError("missing", arg.name);
      break;
    }
    let token: string;
    if (arg.rest) {
      token = trimBlankEnd(cursor);
      cursor = "";
    } else {
      const end = cursor.search(BLANK);
      const cut = end === -1 ? cursor.length : end;
      token = cursor.slice(0, cut);
      cursor = trimBlankStart(cursor.slice(cut));
    }
    out.push({ name: arg.name, value: parseValue(arg, token) });
  }
  if (cursor !== "") throw new ParseError("extra");
  return out;
}

/** `/calc <expression...>` (`[x]` si es opcional). */
export function usage(descriptor: CommandDescriptor): string {
  let text = `/${descriptor.name}`;
  for (const arg of descriptor.args) {
    const dots = arg.rest ? "..." : "";
    text += arg.required ? ` <${arg.name}${dots}>` : ` [${arg.name}${dots}]`;
  }
  return text;
}

// ── Resultado ────────────────────────────────────────────────────────────────

/** Valida el resultado del nodo y devuelve el texto canónico a mostrar. */
export function validateResult(descriptor: CommandDescriptor, value: DynamicValue): string {
  const kind = value.kind;
  if (kind.case !== "objectValue") return fail("el nodo no devolvió un objeto");
  const fields = kind.value.fields;
  if (Object.keys(fields).length !== 1) return fail("el resultado trae campos de más o de menos");
  const field = fields["result"];
  if (!field || field.kind.case !== "stringValue") return fail("el nodo no devolvió {result} como texto");
  const text = field.kind.value;
  const spec = descriptor.result;
  if (!spec) return fail("el comando no declara result");
  if (codePoints(text).length > spec.maxChars) return fail("el resultado del nodo es demasiado largo");
  try {
    switch (spec.type) {
      case CommandArgType.INTEGER:
        return parseInteger("result", text).value;
      case CommandArgType.NUMBER:
        return parseNumber("result", text).value;
      case CommandArgType.BOOLEAN:
        if (text === "true" || text === "false") return text;
        break;
      default:
        break;
    }
  } catch {
    // cae al error común
  }
  return fail("el resultado del nodo no es válido");
}
