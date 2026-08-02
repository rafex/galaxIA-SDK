/**
 * Verifica que el módulo WASM compilado produce exactamente los mismos
 * resultados que el paquete TS @rafex/galaxia-satellite-capabilities
 * para el caso dorado del Instructivo Normativo de la CURP y un conjunto
 * de expresiones aritméticas.
 *
 * El loader de @assemblyscript/loader aporta __newString/__getString para
 * el marshalling de strings JS↔WASM sin tener que hacerlo a mano.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { type ASUtil, instantiate, type ResultObject } from "@assemblyscript/loader";
import { describe, it, expect, beforeAll } from "vitest";
import { solveExpression, computeCurp } from "@rafex/galaxia-satellite-capabilities";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "../../build/satellite-capabilities.wasm");

interface SatelliteExports extends Record<string, unknown> {
  solveExpression(ptr: number): number;
  computeCurpEncoded(ptr: number): number;
}

type WasmInstance = ResultObject & { exports: ASUtil & SatelliteExports };

let wasm: WasmInstance;

beforeAll(async () => {
  const bytes = readFileSync(WASM_PATH);
  wasm = await instantiate<SatelliteExports>(bytes, {
    env: {
      abort(msgPtr: number, filePtr: number, line: number, col: number): void {
        console.error(`WASM abort at ${filePtr}:${line}:${col} msg=${msgPtr}`);
      },
    },
  });
});

function wasmSolve(expr: string): string {
  const inPtr = wasm.exports.__newString(expr);
  const outPtr = wasm.exports.solveExpression(inPtr);
  return wasm.exports.__getString(outPtr);
}

function wasmCurpEncoded(fields: {
  nombre: string;
  apPat: string;
  apMat: string;
  year: number;
  month: number;
  day: number;
  sexo: string;
  entidad: string;
}): string {
  const encoded = [
    fields.nombre,
    fields.apPat,
    fields.apMat,
    fields.year.toString(),
    fields.month.toString(),
    fields.day.toString(),
    fields.sexo,
    fields.entidad,
  ].join("|");
  const inPtr = wasm.exports.__newString(encoded);
  const outPtr = wasm.exports.computeCurpEncoded(inPtr);
  return wasm.exports.__getString(outPtr);
}

describe("arithmetic — igualdad WASM vs TS", () => {
  const cases: [string][] = [
    ["2 + 3"],
    ["10 / 4"],
    ["2 ^ 10"],
    ["-3 * -4"],
    ["(1 + 2) * (3 + 4)"],
    ["100 / 5 - 3 * 2"],
  ];

  for (const [expr] of cases) {
    it(`solveExpression("${expr}")`, () => {
      const tsResult = solveExpression(expr);
      const wasmRaw = wasmSolve(expr);
      expect(wasmRaw).toMatch(/^OK:/);
      const wasmNum = parseFloat(wasmRaw.slice(3));
      expect(wasmNum).toBeCloseTo(tsResult, 8);
    });
  }

  it("división por cero devuelve ERR", () => {
    expect(wasmSolve("1 / 0")).toMatch(/^ERR:/);
  });

  it("expresión vacía devuelve ERR", () => {
    expect(wasmSolve("")).toMatch(/^ERR:/);
  });
});

describe("CURP — caso dorado Instructivo (Concepción Salgado Briseño, 26/06/1956, DF)", () => {
  const goldenInput = {
    nombre: "Concepción",
    apPat: "Salgado",
    apMat: "Briseño",
    year: 1956,
    month: 6,
    day: 26,
    sexo: "M",
    entidad: "Distrito Federal",
  };

  it("curp17 TS = SABC560626MDFLRN0", () => {
    const ts = computeCurp({
      nombre: goldenInput.nombre,
      apellidoPaterno: goldenInput.apPat,
      apellidoMaterno: goldenInput.apMat,
      fechaNacimiento: { year: goldenInput.year, month: goldenInput.month, day: goldenInput.day },
      sexo: "M",
      entidadFederativa: goldenInput.entidad,
    });
    expect(ts.curp17).toBe("SABC560626MDFLRN0");
  });

  it("curp17 WASM = SABC560626MDFLRN0", () => {
    const raw = wasmCurpEncoded(goldenInput);
    expect(raw).toMatch(/^OK:/);
    const curp17 = raw.slice(3).split("|")[0];
    expect(curp17).toBe("SABC560626MDFLRN0");
  });

  it("curp17 WASM coincide exactamente con curp17 TS", () => {
    const ts = computeCurp({
      nombre: goldenInput.nombre,
      apellidoPaterno: goldenInput.apPat,
      apellidoMaterno: goldenInput.apMat,
      fechaNacimiento: { year: goldenInput.year, month: goldenInput.month, day: goldenInput.day },
      sexo: "M",
      entidadFederativa: goldenInput.entidad,
    });
    const raw = wasmCurpEncoded(goldenInput);
    const curp17 = raw.slice(3).split("|")[0];
    expect(curp17).toBe(ts.curp17);
  });
});

describe("CURP — casos borde", () => {
  it("apellido materno ausente usa X en posición 3 y 15", () => {
    const raw = wasmCurpEncoded({
      nombre: "Juan",
      apPat: "Perez",
      apMat: "",
      year: 1990,
      month: 1,
      day: 1,
      sexo: "H",
      entidad: "Jalisco",
    });
    expect(raw).toMatch(/^OK:/);
    const curp17 = raw.slice(3).split("|")[0];
    expect(curp17.charAt(2)).toBe("X");
    expect(curp17.charAt(14)).toBe("X");
  });

  it("formato inválido (menos de 8 campos) devuelve ERR", () => {
    const inPtr = wasm.exports.__newString("solo-un-campo");
    const outPtr = wasm.exports.computeCurpEncoded(inPtr);
    const result = wasm.exports.__getString(outPtr);
    expect(result).toMatch(/^ERR:/);
  });
});
