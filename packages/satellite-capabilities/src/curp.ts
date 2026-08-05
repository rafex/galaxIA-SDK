/**
 * CURP local: construcción candidata y validación estructural.
 *
 * El Instructivo Normativo (DOF 18-10-2021) define las 18 posiciones, pero
 * remite el catálogo y las reglas de casos especiales a un documento externo
 * y no sustituye la asignación contra la base oficial. Por eso este módulo no
 * afirma que una clave calculada quede registrada o sea única en RENAPO.
 *
 * Los datos permanecen en memoria del dispositivo. La página que consume
 * este módulo ejecuta el equivalente WASM en un Web Worker.
 */

import { resolveEntidadFederativaCode, stripDiacritics } from "./curp-catalog.js";

export interface CurpInput {
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno?: string;
  fechaNacimiento: { year: number; month: number; day: number };
  sexo: "H" | "M";
  entidadFederativa: string;
  /** Posición 17 asignada por RENAPO. Si se omite se usa el primer valor del siglo. */
  diferenciador?: string;
}

export interface CurpResult {
  /** CURP candidata de 18 caracteres. */
  curp: string;
  /** Primeras 17 posiciones, antes del dígito verificador. */
  curp17: string;
  warnings: string[];
}

export interface CurpValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  curp: string;
}

const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const NAME_CONNECTORS = new Set(["DE", "DEL", "LA", "LAS", "LOS", "Y", "MC", "VAN", "VON"]);
const INCONVENIENT_WORDS = new Set([
  "BACA", "BAKA", "BUEI", "BUEY", "CACA", "CACO", "CAGA", "CAGO", "CAKA", "CAKO",
  "COGE", "COGI", "COJA", "COJE", "COJI", "COJO", "COLA", "CULO", "FALO", "FETO",
  "GETA", "GUEI", "GUEY", "JETA", "JOTO", "KACA", "KACO", "KAGA", "KAGO", "KAKA",
  "KAKO", "KOGE", "KOGI", "KOJA", "KOJE", "KOJI", "KOJO", "KOLA", "KULO", "LILO",
  "LOCA", "LOCO", "LOKA", "LOKO", "MAME", "MAMO", "MEAR", "MEAS", "MEON", "MIAR",
  "MION", "MOCO", "MOKO", "MULA", "MULO", "NACA", "NACO", "PEDA", "PEDO", "PENE",
  "PIPI", "PITO", "POPO", "PUTA", "PUTO", "QULO", "RATA", "ROBA", "ROBE", "ROBO",
  "RUIN", "SENO", "TETA", "VACA", "VAGA", "VAGO", "VAKA", "VUEI", "VUEY", "WUEI", "WUEY",
]);

/** Tabla pública de interoperabilidad: 0-9, A-N, & (Ñ), O-Z. */
const CHECKSUM_ALPHABET = "0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ";

function normalizeNamePart(value: string): string {
  const withoutEnye = value.trim().toUpperCase().replace(/Ñ/g, "X");
  return stripDiacritics(withoutEnye).replace(/[^A-Z ]/g, "");
}

function significantWord(normalized: string): string {
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.find((word) => !NAME_CONNECTORS.has(word)) ?? words[0] ?? "";
}

function firstInternalVowel(word: string): string {
  for (let i = 1; i < word.length; i++) if (VOWELS.has(word[i])) return word[i];
  return "X";
}

function firstInternalConsonant(word: string): string {
  for (let i = 1; i < word.length; i++) if (!VOWELS.has(word[i])) return word[i];
  return "X";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function checksumValue(character: string): number {
  const value = CHECKSUM_ALPHABET.indexOf(character);
  return value;
}

/** Calcula la posición 18 a partir de las primeras 17 posiciones. */
export function computeCurpCheckDigit(curp17: string): string {
  const normalized = curp17.trim().toUpperCase();
  if (normalized.length !== 17 || [...normalized].some((c) => checksumValue(c) < 0)) {
    throw new Error("curp17 debe contener exactamente 17 caracteres CURP");
  }
  const sum = [...normalized].reduce((total, character, index) => total + checksumValue(character) * (18 - index), 0);
  return String((10 - (sum % 10)) % 10);
}

function validateDifferentiator(differentiator: string, year: number): boolean {
  return year < 2000 ? /^[0-9]$/.test(differentiator) : /^[A-J]$/.test(differentiator);
}

function buildFirst17(input: CurpInput, warnings: string[]): string {
  const apellidoPaterno = significantWord(normalizeNamePart(input.apellidoPaterno));
  const apellidoMaterno = input.apellidoMaterno ? significantWord(normalizeNamePart(input.apellidoMaterno)) : "";
  const nombre = significantWord(normalizeNamePart(input.nombre));
  if (!apellidoPaterno) throw new Error("apellidoPaterno es requerido");
  if (!nombre) throw new Error("nombre es requerido");
  if (!apellidoMaterno) warnings.push('apellidoMaterno ausente: se usó "X" en las posiciones 3 y 15.');

  const { year, month, day } = input.fechaNacimiento;
  if (!isRealDate(year, month, day)) throw new Error("fechaNacimiento no es una fecha válida");
  if (input.sexo !== "H" && input.sexo !== "M") throw new Error('sexo debe ser "H" o "M"');
  const entidad = resolveEntidadFederativaCode(input.entidadFederativa);

  let firstFour = apellidoPaterno[0] + firstInternalVowel(apellidoPaterno) + (apellidoMaterno ? apellidoMaterno[0] : "X") + nombre[0];
  if (INCONVENIENT_WORDS.has(firstFour)) {
    firstFour = firstFour[0] + "X" + firstFour.slice(2);
    warnings.push("La combinación inicial es una palabra inconveniente; la posición 2 se sustituyó por X.");
  }

  const differentiator = (input.diferenciador ?? (year < 2000 ? "0" : "A")).toUpperCase();
  if (!validateDifferentiator(differentiator, year)) {
    throw new Error(`diferenciador inválido para el siglo de ${year}: "${differentiator}"`);
  }
  if (input.diferenciador === undefined) {
    warnings.push(`La posición 17 se asumió como "${differentiator}"; la asignación de homonimia corresponde a RENAPO.`);
  }

  return firstFour + pad2(year % 100) + pad2(month) + pad2(day) + input.sexo + entidad +
    firstInternalConsonant(apellidoPaterno) + (apellidoMaterno ? firstInternalConsonant(apellidoMaterno) : "X") +
    firstInternalConsonant(nombre) + differentiator;
}

export function computeCurp(input: CurpInput): CurpResult {
  const warnings: string[] = [];
  const curp17 = buildFirst17(input, warnings);
  return { curp17, curp: curp17 + computeCurpCheckDigit(curp17), warnings };
}

function dateFromCurp(curp: string): { year: number; month: number; day: number } | null {
  const yy = Number(curp.slice(4, 6));
  const year = /^[0-9]$/.test(curp[16]) ? 1900 + yy : 2000 + yy;
  const month = Number(curp.slice(6, 8));
  const day = Number(curp.slice(8, 10));
  return isRealDate(year, month, day) ? { year, month, day } : null;
}

/** Valida estructura, fecha, catálogo y dígito; no consulta el padrón oficial. */
export function validateCurp(curpValue: string, expected?: Omit<CurpInput, "diferenciador">): CurpValidationResult {
  const curp = curpValue.trim().toUpperCase();
  const errors: string[] = [];
  const warnings = ["Validación local: no confirma existencia, vigencia ni titularidad en RENAPO."];
  if (!/^[A-Z]{4}[0-9]{6}[HM][A-Z]{2}[A-Z]{3}[0-9A-J][0-9]$/.test(curp)) {
    return { valid: false, curp, errors: ["La CURP debe tener 18 caracteres con formato válido."], warnings };
  }
  const date = dateFromCurp(curp);
  if (!date) errors.push("La fecha codificada no es válida.");
  if (date && !validateDifferentiator(curp[16], date.year)) errors.push("La posición 17 no corresponde al siglo de nacimiento.");
  try { resolveEntidadFederativaCode(curp.slice(11, 13)); } catch { errors.push("La entidad federativa codificada no pertenece al catálogo."); }
  if (computeCurpCheckDigit(curp.slice(0, 17)) !== curp[17]) errors.push("El dígito verificador no coincide.");

  if (expected && errors.length === 0) {
    try {
      const candidate = computeCurp({ ...expected, diferenciador: curp[16] });
      if (candidate.curp.slice(0, 16) !== curp.slice(0, 16)) errors.push("Las primeras 16 posiciones no corresponden a los datos proporcionados.");
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  return { valid: errors.length === 0, curp, errors, warnings };
}
