/** Puerto AssemblyScript de la construcción/validación local de CURP. */

import { resolveEntidadFederativaCode, stripDiacritics } from "./curp-catalog";

const VOWELS: string[] = ["A", "E", "I", "O", "U"];
const NAME_CONNECTORS: string[] = ["DE", "DEL", "LA", "LAS", "LOS", "Y", "MC", "VAN", "VON"];
const INCONVENIENT: string[] = [
  "BACA", "BAKA", "BUEI", "BUEY", "CACA", "CACO", "CAGA", "CAGO", "CAKA", "CAKO",
  "COGE", "COGI", "COJA", "COJE", "COJI", "COJO", "COLA", "CULO", "FALO", "FETO",
  "GETA", "GUEI", "GUEY", "JETA", "JOTO", "KACA", "KACO", "KAGA", "KAGO", "KAKA",
  "KAKO", "KOGE", "KOGI", "KOJA", "KOJE", "KOJI", "KOJO", "KOLA", "KULO", "LILO",
  "LOCA", "LOCO", "LOKA", "LOKO", "MAME", "MAMO", "MEAR", "MEAS", "MEON", "MIAR",
  "MION", "MOCO", "MOKO", "MULA", "MULO", "NACA", "NACO", "PEDA", "PEDO", "PENE",
  "PIPI", "PITO", "POPO", "PUTA", "PUTO", "QULO", "RATA", "ROBA", "ROBE", "ROBO",
  "RUIN", "SENO", "TETA", "VACA", "VAGA", "VAGO", "VAKA", "VUEI", "VUEY", "WUEI", "WUEY",
];

function isVowel(ch: string): bool {
  for (let i = 0; i < VOWELS.length; i++) if (VOWELS[i] == ch) return true;
  return false;
}

function isConnector(word: string): bool {
  for (let i = 0; i < NAME_CONNECTORS.length; i++) if (NAME_CONNECTORS[i] == word) return true;
  return false;
}

function isInconvenient(value: string): bool {
  for (let i = 0; i < INCONVENIENT.length; i++) if (INCONVENIENT[i] == value) return true;
  return false;
}

function normalizeNamePart(value: string): string {
  let upper = value.trim().toUpperCase();
  let enye = "";
  for (let i = 0; i < upper.length; i++) enye += upper.charAt(i) == "Ñ" ? "X" : upper.charAt(i);
  const stripped = stripDiacritics(enye);
  let result = "";
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped.charAt(i);
    const code = ch.charCodeAt(0);
    if ((code >= 65 && code <= 90) || ch == " ") result += ch;
  }
  return result;
}

function splitWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  for (let i = 0; i <= value.length; i++) {
    const ch = i < value.length ? value.charAt(i) : " ";
    if (ch == " ") {
      if (current.length > 0) { words.push(current); current = ""; }
    } else current += ch;
  }
  return words;
}

function significantWord(value: string): string {
  const words = splitWords(value);
  for (let i = 0; i < words.length; i++) if (!isConnector(words[i])) return words[i];
  return words.length > 0 ? words[0] : "";
}

function firstInternalVowel(word: string): string {
  for (let i = 1; i < word.length; i++) if (isVowel(word.charAt(i))) return word.charAt(i);
  return "X";
}

function firstInternalConsonant(word: string): string {
  for (let i = 1; i < word.length; i++) if (!isVowel(word.charAt(i))) return word.charAt(i);
  return "X";
}

function pad2(value: i32): string { return value < 10 ? "0" + value.toString() : value.toString(); }

function isLeapYear(year: i32): bool { return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0); }

function isRealDate(year: i32, month: i32, day: i32): bool {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days: i32[] = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function checksumValue(ch: string): i32 {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code < 65 || code > 90) return -1;
  const alphaIndex = code - 65;
  return 10 + alphaIndex + (alphaIndex >= 14 ? 1 : 0); // & ocupa el hueco de Ñ
}

export function computeCheckDigit(curp17: string): string {
  if (curp17.length != 17) return "";
  let sum: i32 = 0;
  for (let i = 0; i < 17; i++) {
    const value = checksumValue(curp17.charAt(i));
    if (value < 0) return "";
    sum += value * (18 - i);
  }
  return ((10 - (sum % 10)) % 10).toString();
}

function validDifferentiator(value: string, year: i32): bool {
  if (value.length != 1) return false;
  const code = value.charCodeAt(0);
  return year < 2000 ? code >= 48 && code <= 57 : code >= 65 && code <= 74;
}

export class CurpResult {
  curp: string;
  curp17: string;
  warnings: string;
  error: string;
  constructor(curp: string, curp17: string, warnings: string, error: string) {
    this.curp = curp;
    this.curp17 = curp17;
    this.warnings = warnings;
    this.error = error;
  }
}

export function computeCurp17(
  nombre: string, apPat: string, apMat: string, year: i32, month: i32, day: i32,
  sexo: string, entidad: string, diferenciador: string = "",
): CurpResult {
  const warnings: string[] = [];
  const paterno = significantWord(normalizeNamePart(apPat));
  const materno = apMat.length > 0 ? significantWord(normalizeNamePart(apMat)) : "";
  const firstName = significantWord(normalizeNamePart(nombre));
  if (paterno.length == 0) return new CurpResult("", "", "", "apellidoPaterno es requerido");
  if (firstName.length == 0) return new CurpResult("", "", "", "nombre es requerido");
  if (!isRealDate(year, month, day)) return new CurpResult("", "", "", "fechaNacimiento no es una fecha válida");
  if (sexo != "H" && sexo != "M") return new CurpResult("", "", "", 'sexo debe ser "H" o "M"');
  if (materno.length == 0) warnings.push('apellidoMaterno ausente: se usó "X" en las posiciones 3 y 15.');

  const entityCode = resolveEntidadFederativaCode(entidad);
  if (entityCode.length == 0) return new CurpResult("", "", "", "Entidad federativa no reconocida: " + entidad);
  const differentiatorValue = diferenciador.length > 0 ? diferenciador.toUpperCase() : (year < 2000 ? "0" : "A");
  if (!validDifferentiator(differentiatorValue, year)) return new CurpResult("", "", "", "diferenciador inválido para el siglo de nacimiento");
  if (diferenciador.length == 0) warnings.push("La posición 17 se asumió como " + differentiatorValue + "; la asignación de homonimia corresponde a RENAPO.");

  let firstFour = paterno.charAt(0) + firstInternalVowel(paterno) + (materno.length > 0 ? materno.charAt(0) : "X") + firstName.charAt(0);
  if (isInconvenient(firstFour)) {
    firstFour = firstFour.charAt(0) + "X" + firstFour.charAt(2) + firstFour.charAt(3);
    warnings.push("La combinación inicial es una palabra inconveniente; la posición 2 se sustituyó por X.");
  }
  const curp17 = firstFour + pad2(year % 100) + pad2(month) + pad2(day) + sexo + entityCode +
    firstInternalConsonant(paterno) + (materno.length > 0 ? firstInternalConsonant(materno) : "X") +
    firstInternalConsonant(firstName) + differentiatorValue;
  const checkDigit = computeCheckDigit(curp17);
  if (checkDigit.length == 0) return new CurpResult("", "", "", "no se pudo calcular el dígito verificador");
  return new CurpResult(curp17 + checkDigit, curp17, warnings.join("|"), "");
}

function validShape(curp: string): bool {
  if (curp.length != 18) return false;
  for (let i = 0; i < curp.length; i++) {
    const code = curp.charCodeAt(i);
    if (i >= 4 && i <= 9) { if (code < 48 || code > 57) return false; }
    else if (i == 10) { if (curp.charAt(i) != "H" && curp.charAt(i) != "M") return false; }
    else if (i == 16) { if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 74))) return false; }
    else if (i == 17) { if (code < 48 || code > 57) return false; }
    else if (code < 65 || code > 90) return false;
  }
  return true;
}

export function validateCurpEncoded(value: string): string {
  const curp = value.trim().toUpperCase();
  if (!validShape(curp)) return "ERR:La CURP debe tener 18 caracteres con formato válido";
  const yy = I32.parseInt(curp.substr(4, 2));
  const year = (curp.charCodeAt(16) >= 48 && curp.charCodeAt(16) <= 57) ? 1900 + yy : 2000 + yy;
  const month = I32.parseInt(curp.substr(6, 2));
  const day = I32.parseInt(curp.substr(8, 2));
  if (!isRealDate(year, month, day)) return "ERR:La fecha codificada no es válida";
  if (resolveEntidadFederativaCode(curp.substr(11, 2)).length == 0) return "ERR:La entidad federativa codificada no pertenece al catálogo";
  if (computeCheckDigit(curp.substr(0, 17)) != curp.charAt(17)) return "ERR:El dígito verificador no coincide";
  return "OK:" + curp + "|Validación estructural local correcta; no confirma existencia ni vigencia en RENAPO.";
}
