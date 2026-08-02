/**
 * Entry point del módulo WASM satellite-capabilities.
 * Todas las funciones exportadas son string-in/string-out con prefijo OK/ERR.
 * El formato de CURP usa "|" como separador: "OK:curp17|warnings".
 */

import { evalExpression, getArithError } from "./arithmetic";
import { computeCurp17 } from "./curp";

/**
 * Evalúa una expresión aritmética.
 * Devuelve "OK:<número>" o "ERR:<mensaje>".
 */
export function solveExpression(expr: string): string {
  const result = evalExpression(expr);
  const err = getArithError();
  if (err.length > 0) return "ERR:" + err;
  return "OK:" + result.toString();
}

/**
 * Calcula las 17 primeras posiciones de la CURP.
 * Entrada: campos separados por "|": nombre|apPat|apMat|year|month|day|sexo|entidad
 *   - apMat puede ser "" (vacío) si no aplica.
 * Devuelve "OK:<curp17>|<warnings>" o "ERR:<mensaje>".
 */
export function computeCurpEncoded(encoded: string): string {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i <= encoded.length; i++) {
    if (i == encoded.length || encoded.charAt(i) == "|") {
      parts.push(cur);
      cur = "";
    } else {
      cur += encoded.charAt(i);
    }
  }

  if (parts.length < 8) {
    return "ERR:Formato inválido — se esperaban 8 campos separados por |";
  }

  const nombre = parts[0];
  const apPat = parts[1];
  const apMat = parts[2];
  const year = I32.parseInt(parts[3]);
  const month = I32.parseInt(parts[4]);
  const day = I32.parseInt(parts[5]);
  const sexo = parts[6];
  const entidad = parts[7];

  if (isNaN(year as f64) || isNaN(month as f64) || isNaN(day as f64)) {
    return "ERR:year/month/day deben ser enteros";
  }

  const r = computeCurp17(nombre, apPat, apMat, year, month, day, sexo, entidad);
  if (r.error.length > 0) return "ERR:" + r.error;
  return "OK:" + r.curp17 + "|" + r.warnings;
}
