import { describe, it, expect } from "vitest";
import { computeCurp } from "../curp.js";
import { resolveEntidadFederativaCode } from "../curp-catalog.js";

describe("computeCurp", () => {
  it("prueba dorada: ejemplo resuelto del Instructivo (DOF 18-06-2018, mod. 18-10-2021)", () => {
    // Concepción Salgado Briseño, nacida el 26 de junio de 1956, en el
    // Distrito Federal (ahora Ciudad de México) → SABC560626MDFLRN09
    const result = computeCurp({
      nombre: "Concepción",
      apellidoPaterno: "Salgado",
      apellidoMaterno: "Briseño",
      fechaNacimiento: { year: 1956, month: 6, day: 26 },
      sexo: "M",
      entidadFederativa: "Distrito Federal",
    });

    // Las 17 primeras posiciones coinciden exactas con el documento — la
    // posición 18 (dígito verificador) queda explícitamente sin calcular
    // (ver comentario en curp.ts), representada como "?".
    expect(result.curp17).toBe("SABC560626MDFLRN0");
    expect(result.curp).toBe("SABC560626MDFLRN0?");
    expect(result.warnings.some((w) => w.includes("dígito verificador"))).toBe(true);
  });

  it("acepta el código de entidad de 2 letras directamente", () => {
    const result = computeCurp({
      nombre: "Concepción",
      apellidoPaterno: "Salgado",
      apellidoMaterno: "Briseño",
      fechaNacimiento: { year: 1956, month: 6, day: 26 },
      sexo: "M",
      entidadFederativa: "DF",
    });
    expect(result.curp17).toBe("SABC560626MDFLRN0");
  });

  it("usa X para apellido materno ausente, con warning", () => {
    const result = computeCurp({
      nombre: "Juan",
      apellidoPaterno: "Perez",
      fechaNacimiento: { year: 1990, month: 1, day: 15 },
      sexo: "H",
      entidadFederativa: "Jalisco",
    });
    // P(1, de Perez) + primera vocal interna de PEREZ=E(2) + X(3, sin materno) + J(4, de Juan)
    expect(result.curp17.slice(0, 4)).toBe("PEXJ");
    expect(result.warnings.some((w) => w.includes("apellidoMaterno ausente"))).toBe(true);
  });

  it("diferenciador de siglo: 0 para <2000, A para >=2000", () => {
    const pre2000 = computeCurp({
      nombre: "Ana",
      apellidoPaterno: "Ruiz",
      apellidoMaterno: "Lopez",
      fechaNacimiento: { year: 1999, month: 12, day: 31 },
      sexo: "M",
      entidadFederativa: "Jalisco",
    });
    expect(pre2000.curp17[16]).toBe("0");

    const post2000 = computeCurp({
      nombre: "Ana",
      apellidoPaterno: "Ruiz",
      apellidoMaterno: "Lopez",
      fechaNacimiento: { year: 2001, month: 1, day: 1 },
      sexo: "M",
      entidadFederativa: "Jalisco",
    });
    expect(post2000.curp17[16]).toBe("A");
  });

  it("quita acentos y normaliza mayúsculas", () => {
    const result = computeCurp({
      nombre: "josé",
      apellidoPaterno: "gonzález",
      apellidoMaterno: "núñez",
      fechaNacimiento: { year: 1985, month: 3, day: 3 },
      sexo: "H",
      entidadFederativa: "Veracruz",
    });
    // G(1) + primera vocal interna de GONZALEZ = O(2) + N(3, de Nuñez→NUXEZ) + J(4, de Jose)
    expect(result.curp17.slice(0, 4)).toBe("GONJ");
  });

  it("rechaza mes/día fuera de rango", () => {
    expect(() =>
      computeCurp({
        nombre: "Ana",
        apellidoPaterno: "Ruiz",
        fechaNacimiento: { year: 1990, month: 13, day: 1 },
        sexo: "M",
        entidadFederativa: "Jalisco",
      })
    ).toThrow("Mes de nacimiento inválido");
  });

  it("rechaza entidad federativa no reconocida", () => {
    expect(() => resolveEntidadFederativaCode("Narnia")).toThrow("Entidad federativa no reconocida");
  });
});
