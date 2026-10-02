import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { FhsProto } from "@rafex/galaxia-fhs-protocol";
import * as Cmd from "@rafex/galaxia-fhs-protocol/commands";
import { CALC_COMMAND } from "./command.js";
import { CAPABILITY, TOOL } from "./engine.js";

const idl = (path: string): string => readFileSync(new URL(`../../../../../galaxIA/idl/${path}`, import.meta.url), "utf8");
const fixtures = JSON.parse(idl("fixtures/command-descriptors.json")) as {
  valid: { fingerprints: Record<string, string> }[];
};
const registry = Cmd.parseRegistry(idl("command-capabilities.json"));

describe("comando /calc declarado por el nodo móvil", () => {
  it("cumple el registro cerrado y los límites del estándar", () => {
    expect(() => Cmd.validateDescriptors([CALC_COMMAND], [CAPABILITY], registry)).not.toThrow();
    expect(registry.entries[CAPABILITY].tools).toContain(TOOL);
  });

  it("tiene la misma huella de contrato que Rust (fixture compartido)", () => {
    expect(Cmd.fingerprint(CALC_COMMAND)).toBe(fixtures.valid[0].fingerprints.calc);
  });

  it("el Navigator parsea con él igual que con el fixture", () => {
    const parsed = Cmd.parseArgs(CALC_COMMAND, " (12+8)*3^2/4 ");
    expect(parsed).toEqual([{ name: "expression", value: { type: "string", value: "(12+8)*3^2/4" } }]);
    expect(() => Cmd.parseArgs(CALC_COMMAND, " 2+a")).toThrow(Cmd.ParseError);
    expect(Cmd.usage(CALC_COMMAND)).toBe("/calc <expression...>");
  });

  it("los códigos de error del motor son los del registro", () => {
    for (const code of ["MATH_DIVISION_BY_ZERO", "MATH_NOT_FINITE", "MATH_SYNTAX", "MATH_TIMEOUT", "MATH_LIMIT"]) {
      expect(Cmd.errorText(registry, CAPABILITY, code), code).toBeDefined();
    }
  });

  it("el anuncio lleva el comando y una versión que lo soporta", () => {
    const beacon = create(FhsProto.BeaconSchema, { fhsVersion: "0.2", commands: [CALC_COMMAND] });
    expect(beacon.commands).toHaveLength(1);
    expect(beacon.commands[0].name).toBe("calc");
  });
});
