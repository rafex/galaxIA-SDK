import { describe, expect, it } from "vitest";
import { checkInput, mapRaw, solve } from "./engine.js";

describe("motor aritmético", () => {
  it("valida la entrada antes del motor", () => {
    expect(checkInput("(12+8)*3")).toBeUndefined();
    expect(checkInput("")).toBe("MATH_SYNTAX");
    expect(checkInput("2+a")).toBe("MATH_SYNTAX");
    expect(checkInput("1+".repeat(101))).toBe("MATH_LIMIT");
    expect(checkInput(`${"(".repeat(33)}1${")".repeat(33)}`)).toBe("MATH_LIMIT");
    expect(checkInput(`${"(".repeat(32)}1${")".repeat(32)}`)).toBeUndefined();
  });

  it("mapea la respuesta del WASM a códigos MATH_*", () => {
    expect(mapRaw("OK:45")).toEqual({ ok: true, result: "45" });
    expect(mapRaw("OK:-0.5")).toEqual({ ok: true, result: "-0.5" });
    expect(mapRaw("ERR:División por cero")).toEqual({ ok: false, code: "MATH_DIVISION_BY_ZERO" });
    expect(mapRaw("ERR:El resultado no es un número finito (overflow o operación inválida)")).toEqual({ ok: false, code: "MATH_NOT_FINITE" });
    expect(mapRaw("ERR:Token inesperado")).toEqual({ ok: false, code: "MATH_SYNTAX" });
    expect(mapRaw("OK:1e21").ok).toBe(false);
    expect(mapRaw(`OK:${"9".repeat(65)}`)).toEqual({ ok: false, code: "MATH_LIMIT" });
  });

  it("agota el tiempo del motor", async () => {
    const never = () => new Promise<string>(() => undefined);
    expect(await solve("1+1", never, 20)).toEqual({ ok: false, code: "MATH_TIMEOUT" });
    expect(await solve("1+1", () => Promise.resolve("OK:2"), 200)).toEqual({ ok: true, result: "2" });
  });
});
