/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
/* Los fixtures compartidos son JSON sin tipar; se contrastan campo a campo. */
import { readFileSync } from "node:fs";
import { create, toBinary } from "@bufbuild/protobuf";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import * as Auth from "../authorization.js";
import * as Cmd from "../commands.js";
import * as Fhs from "../generated/fhs-protocol_pb.js";

const read = (path: string): string => readFileSync(new URL(`../../../../../galaxIA/idl/${path}`, import.meta.url), "utf8");
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixtures = JSON.parse(read("fixtures/command-descriptors.json")) as J;
const registryJson = read("command-capabilities.json");
const registry = Cmd.parseRegistry(registryJson);

const TYPES: Record<string, Fhs.CommandArgType> = {
  STRING: Fhs.CommandArgType.STRING,
  INTEGER: Fhs.CommandArgType.INTEGER,
  NUMBER: Fhs.CommandArgType.NUMBER,
  BOOLEAN: Fhs.CommandArgType.BOOLEAN,
  ENUM: Fhs.CommandArgType.ENUM,
};

function descriptor(j: J): Fhs.CommandDescriptor {
  return create(Fhs.CommandDescriptorSchema, {
    name: j.name,
    capabilityId: j.capability_id,
    toolName: j.tool_name,
    summary: j.summary ?? "",
    args: (j.args as J[]).map((a) =>
      create(Fhs.CommandArgSchema, {
        name: a.name,
        description: a.description ?? "",
        type: TYPES[a.type],
        required: a.required ?? false,
        rest: a.rest ?? false,
        maxLength: a.max_length ?? 0,
        allowedChars: a.allowed_chars ?? "",
        enumValues: a.enum_values ?? [],
        maxNesting: a.max_nesting ?? 0,
      }),
    ),
    result: create(Fhs.CommandResultSchema, { type: TYPES[j.result.type], maxChars: j.result.max_chars }),
  });
}

const str = (value: string): Fhs.DynamicValue => create(Fhs.DynamicValueSchema, { kind: { case: "stringValue", value } });
function dynamic(spec: J): Fhs.DynamicValue {
  if ("string" in spec) return str(spec.string);
  if ("number" in spec) return create(Fhs.DynamicValueSchema, { kind: { case: "numberValue", value: spec.number } });
  const fields: Record<string, Fhs.DynamicValue> = {};
  for (const [k, v] of Object.entries(spec.object as J)) fields[k] = dynamic(v);
  return create(Fhs.DynamicValueSchema, {
    kind: { case: "objectValue", value: create(Fhs.DynamicObjectSchema, { fields }) },
  });
}

describe("comandos autodescubiertos (fixtures compartidos con Rust)", () => {
  it("el registro coincide con el digest del estándar", () => {
    expect(registry.digest).toBe(fixtures.registry_digest);
    expect(Cmd.errorText(registry, "math.arithmetic.solve", "MATH_SYNTAX")).toBe("La expresión no es válida");
    expect(Cmd.errorText(registry, "math.arithmetic.solve", "MATH_SYNTAX: x")).toBeUndefined();
    expect(Cmd.errorText(registry, "chat", "MATH_SYNTAX")).toBeUndefined();
    expect(() => Cmd.parseRegistry('{"registry_version":1,"entries":{},"x":1}')).toThrow();
  });

  it("valida los descriptores válidos y calcula las mismas huellas", () => {
    for (const c of fixtures.valid as J[]) {
      const commands = (c.commands as J[]).map(descriptor);
      expect(() => Cmd.validateDescriptors(commands, c.capabilities, registry)).not.toThrow();
      for (const command of commands) expect(Cmd.fingerprint(command)).toBe(c.fingerprints[command.name]);
    }
  });

  it("rechaza los descriptores inválidos", () => {
    for (const c of fixtures.invalid as J[]) {
      const commands = (c.commands as J[]).map(descriptor);
      expect(() => Cmd.validateDescriptors(commands, c.capabilities, registry), c.case).toThrow(Cmd.DescriptorError);
    }
  });

  it("codifica el Beacon con comandos con los mismos bytes que Rust (firma del anuncio)", () => {
    const g = fixtures.beacon_golden as J;
    const beacon = create(Fhs.BeaconSchema, {
      fhsVersion: g.fhs_version,
      capabilities: (g.capabilities as string[]).map((id) => create(Fhs.CapabilityDescriptorSchema, { id })),
      commands: (g.commands as string[]).map((name) => descriptor(fixtures.descriptors[name])),
    });
    const bytes = toBinary(Fhs.BeaconSchema, beacon);
    expect(Auth.toHex(bytes)).toBe(g.hex);
    expect(Auth.toHex(sha256(bytes))).toBe(g.sha256);
    expect(`${g.did}:${Auth.toHex(sha256(bytes))}:${g.timestamp}:${g.ttl}`).toBe(g.advertise_payload);
  });

  it("el texto informativo no cambia la huella", () => {
    const calc = descriptor(fixtures.descriptors.calc);
    const other = descriptor({ ...fixtures.descriptors.calc, summary: "otro" });
    expect(Cmd.fingerprint(other)).toBe(Cmd.fingerprint(calc));
  });

  it("parsea la gramática igual que Rust", () => {
    for (const c of fixtures.parse as J[]) {
      const d = descriptor(fixtures.descriptors[c.descriptor]);
      if (c.ok) {
        const got = Cmd.parseArgs(d, c.rest).map((a) => ({ name: a.name, type: a.value.type, value: a.value.value }));
        expect(got, JSON.stringify(c.rest)).toEqual(c.ok);
      } else {
        try {
          Cmd.parseArgs(d, c.rest);
          throw new Error(`debía fallar: ${JSON.stringify(c.rest)}`);
        } catch (e) {
          expect(e).toBeInstanceOf(Cmd.ParseError);
          expect((e as Cmd.ParseError).kind, JSON.stringify(c.rest)).toBe(c.error);
        }
      }
    }
  });

  it("clasifica las líneas (comando, escape o texto)", () => {
    for (const c of fixtures.classify as J[]) {
      const got = Cmd.classifyLine(c.line);
      expect(got.kind, c.line).toBe(c.kind);
      if (got.kind === "command") expect({ name: got.name, rest: got.rest }).toEqual({ name: c.name, rest: c.rest });
      if (got.kind === "escaped") expect(got.text).toBe(c.text);
    }
  });

  it("valida el resultado del nodo", () => {
    for (const c of fixtures.results as J[]) {
      const d = descriptor({
        ...fixtures.descriptors.calc,
        result: { type: c.type, max_chars: c.max_chars },
      });
      if (c.ok !== undefined) expect(Cmd.validateResult(d, dynamic(c.value)), JSON.stringify(c)).toBe(c.ok);
      else expect(() => Cmd.validateResult(d, dynamic(c.value)), JSON.stringify(c)).toThrow();
    }
  });

  it("muestra el uso de cada comando", () => {
    expect(Cmd.usage(descriptor(fixtures.descriptors.calc))).toBe("/calc <expression...>");
    expect(Cmd.usage(descriptor(fixtures.descriptors.sumar))).toBe("/sumar <x> <y> [redondear] [modo]");
  });

  it("el digest command_args coincide con Rust y la herramienta entra al digest", () => {
    const authFixtures = JSON.parse(read("fixtures/authorization-digests.json")) as { cases: Record<string, string> };
    const args = create(Fhs.DynamicValueSchema, {
      kind: {
        case: "objectValue",
        value: create(Fhs.DynamicObjectSchema, { fields: { expression: str("(12+8)*3^2/4") } }),
      },
    });
    expect(Auth.toHex(Auth.commandArgsDigest("arithmetic_solve", args))).toBe(authFixtures.cases["command_args:calc"]);
    expect(Auth.toHex(Auth.commandArgsDigest("otra_tool", args))).not.toBe(authFixtures.cases["command_args:calc"]);
  });
});
