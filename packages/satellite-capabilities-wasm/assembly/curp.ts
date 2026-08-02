/**
 * Puerto AssemblyScript de ../../satellite-capabilities/src/curp.ts.
 * Misma lógica; diferencias por dialecto: sin Record<K,V> / Map literal,
 * sin optional properties (se usa string vacío como sentinel), string
 * concatenation en vez de template literals.
 */

import { resolveEntidadFederativaCode, stripDiacritics } from "./curp-catalog";

const VOWELS: string[] = ["A", "E", "I", "O", "U"];

function isVowel(ch: string): boolean {
  for (let i = 0; i < VOWELS.length; i++) {
    if (VOWELS[i] == ch) return true;
  }
  return false;
}

const NAME_CONNECTORS: string[] = ["DE", "DEL", "LA", "LAS", "LOS", "Y", "MC", "VAN", "VON"];

function isConnector(word: string): boolean {
  for (let i = 0; i < NAME_CONNECTORS.length; i++) {
    if (NAME_CONNECTORS[i] == word) return true;
  }
  return false;
}

const INCONVENIENT: string[] = [
  "BUEI", "BUEY", "CACA", "CACO", "CAGA", "CAGO", "CAKA", "CAKO",
  "COGE", "COJA", "COJE", "COJI", "COJO", "CULO", "FETO", "GUEY",
  "JOTO", "KACA", "KACO", "KAGA", "KAGO", "KOGE", "KOGI", "KOJO",
  "KAKA", "KAKO", "LILO", "LOCA", "LOCO", "LOKA", "LOKO", "MAME",
  "MAMO", "MEAR", "MEAS", "MEON", "MION", "MOCO", "MOKO", "MULA",
  "MULO", "NACA", "NACO", "PEDA", "PEDO", "PENE", "PIPI", "PITO",
  "POPO", "PUTA", "PUTO", "QULO", "RATA", "ROBA", "ROBE", "ROBO",
  "RUIN", "SENO", "TETA", "VACA", "VAGA", "VAGO", "VAKA", "VUEI",
  "VUEY", "WUEI", "WUEY",
];

function isInconvenient(s: string): boolean {
  for (let i = 0; i < INCONVENIENT.length; i++) {
    if (INCONVENIENT[i] == s) return true;
  }
  return false;
}

function normalizeNamePart(value: string): string {
  let out = "";
  const upper = value.trim().toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const ch = upper.charAt(i);
    out += (ch == "Ñ") ? "X" : ch;
  }
  const stripped = stripDiacritics(out);
  let result = "";
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped.charAt(i);
    const code = ch.charCodeAt(0);
    if ((code >= 65 && code <= 90) || ch == " ") result += ch;
  }
  return result;
}

function splitWords(s: string): string[] {
  const words: string[] = [];
  let cur = "";
  for (let i = 0; i <= s.length; i++) {
    const ch = i < s.length ? s.charAt(i) : " ";
    if (ch == " ") {
      if (cur.length > 0) { words.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  return words;
}

function significantWord(normalized: string): string {
  const words = splitWords(normalized);
  for (let i = 0; i < words.length; i++) {
    if (!isConnector(words[i])) return words[i];
  }
  return words.length > 0 ? words[0] : "";
}

function firstInternalVowel(word: string): string {
  for (let i = 1; i < word.length; i++) {
    if (isVowel(word.charAt(i))) return word.charAt(i);
  }
  return "X";
}

function firstInternalConsonant(word: string): string {
  for (let i = 1; i < word.length; i++) {
    const ch = word.charAt(i);
    if (!isVowel(ch) && ch != " ") return ch;
  }
  return "X";
}

function pad2(n: i32): string {
  if (n < 10) return "0" + n.toString();
  return n.toString();
}

export class CurpResult {
  curp17: string;
  warnings: string;
  error: string;
  constructor(curp17: string, warnings: string, error: string) {
    this.curp17 = curp17;
    this.warnings = warnings;
    this.error = error;
  }
}

/**
 * Computa las primeras 17 posiciones de la CURP.
 * La posición 18 (dígito verificador) no se calcula — ver curp.ts del paquete TS.
 *
 * @param nombre        Primer nombre
 * @param apPat         Apellido paterno
 * @param apMat         Apellido materno (pasar "" si no aplica)
 * @param year          Año de nacimiento (4 dígitos)
 * @param month         Mes de nacimiento (1-12)
 * @param day           Día de nacimiento (1-31)
 * @param sexo          "H" o "M"
 * @param entidad       Nombre completo o código de 2 letras de la entidad
 */
export function computeCurp17(
  nombre: string,
  apPat: string,
  apMat: string,
  year: i32,
  month: i32,
  day: i32,
  sexo: string,
  entidad: string,
): CurpResult {
  const warnings: string[] = [];

  const apellidoPaterno = significantWord(normalizeNamePart(apPat));
  const apellidoMaterno = apMat.length > 0 ? significantWord(normalizeNamePart(apMat)) : "";
  const primerNombre = significantWord(normalizeNamePart(nombre));

  if (apellidoPaterno.length == 0) {
    return new CurpResult("", "", "apellidoPaterno es requerido");
  }
  if (primerNombre.length == 0) {
    return new CurpResult("", "", "nombre es requerido");
  }
  if (apellidoMaterno.length == 0) {
    warnings.push('apellidoMaterno ausente — se usó "X" en las posiciones 3 y 15 (convenio público).');
  }

  if (month < 1 || month > 12) {
    return new CurpResult("", "", "Mes de nacimiento inválido: " + month.toString());
  }
  if (day < 1 || day > 31) {
    return new CurpResult("", "", "Día de nacimiento inválido: " + day.toString());
  }

  const entidadCode = resolveEntidadFederativaCode(entidad);
  if (entidadCode.length == 0) {
    return new CurpResult("", "", 'Entidad federativa no reconocida: "' + entidad + '"');
  }

  let pos1to4 =
    apellidoPaterno.charAt(0) +
    firstInternalVowel(apellidoPaterno) +
    (apellidoMaterno.length > 0 ? apellidoMaterno.charAt(0) : "X") +
    primerNombre.charAt(0);

  if (isInconvenient(pos1to4)) {
    pos1to4 = pos1to4.charAt(0) + "X" + pos1to4.charAt(2) + pos1to4.charAt(3);
    warnings.push('Las posiciones 1-4 coincidían con una palabra a evitar — se sustituyó la posición 2 por "X" (convenio público).');
  }

  const yy = pad2(year % 100);
  const mm = pad2(month);
  const dd = pad2(day);

  const pos14to16 =
    firstInternalConsonant(apellidoPaterno) +
    (apellidoMaterno.length > 0 ? firstInternalConsonant(apellidoMaterno) : "X") +
    firstInternalConsonant(primerNombre);

  const differentiator = year >= 2000 ? "A" : "0";
  warnings.push(
    'Posición 17 (diferenciador de homonimia) asumida en "' + differentiator + '" por no poder consultar la BDNCURP en vivo.'
  );
  warnings.push(
    'Posición 18 (dígito verificador) NO se calculó — algoritmo no publicado en el Instructivo.'
  );

  const curp17 = pos1to4 + yy + mm + dd + sexo + entidadCode + pos14to16 + differentiator;

  let warningsStr = "";
  for (let i = 0; i < warnings.length; i++) {
    if (i > 0) warningsStr += "|";
    warningsStr += warnings[i];
  }

  return new CurpResult(curp17, warningsStr, "");
}
