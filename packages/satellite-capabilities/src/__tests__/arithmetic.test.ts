import { describe, it, expect } from "vitest";
import { solveExpression } from "../arithmetic.js";

describe("solveExpression", () => {
  it("suma y resta simples", () => {
    expect(solveExpression("2+2")).toBe(4);
    expect(solveExpression("10-3")).toBe(7);
  });

  it("respeta precedencia de operadores", () => {
    expect(solveExpression("2+2*3")).toBe(8);
    expect(solveExpression("(2+2)*3")).toBe(12);
  });

  it("maneja paréntesis anidados", () => {
    expect(solveExpression("((1+2)*(3+4))")).toBe(21);
  });

  it("maneja decimales", () => {
    expect(solveExpression("1.5+2.5")).toBe(4);
  });

  it("maneja menos unario", () => {
    expect(solveExpression("-5+10")).toBe(5);
    expect(solveExpression("3*-2")).toBe(-6);
    expect(solveExpression("-(2+3)")).toBe(-5);
  });

  it("maneja potencias, asociativas a la derecha", () => {
    expect(solveExpression("2^3")).toBe(8);
    expect(solveExpression("2^3^2")).toBe(512); // 2^(3^2) = 2^9
  });

  it("el ejemplo del documento original: (12 + 8) * 3", () => {
    expect(solveExpression("(12 + 8) * 3")).toBe(60);
  });

  it("lanza error claro en división por cero", () => {
    expect(() => solveExpression("5/0")).toThrow("División por cero");
  });

  it("lanza error claro en sintaxis inválida", () => {
    expect(() => solveExpression("2++")).toThrow();
    expect(() => solveExpression("(2+3")).toThrow();
    expect(() => solveExpression("")).toThrow("Expresión vacía");
  });

  it("nunca usa eval/Function — rechaza caracteres no aritméticos", () => {
    expect(() => solveExpression("alert(1)")).toThrow();
    expect(() => solveExpression("2; alert(1)")).toThrow();
  });
});
