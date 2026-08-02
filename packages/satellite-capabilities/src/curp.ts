/**
 * Cómputo de CURP — capacidad `identity.curp.compute` pensada para un
 * Ephemeral Satellite (nodo WASM en navegador, ver spec-native/DECISIONS.md).
 *
 * Implementa las **17 primeras posiciones** según el Instructivo Normativo
 * para la Asignación de la Clave Única de Registro de Población (DOF,
 * publicado 18-06-2018, modificado 18-10-2021) — caso de personas
 * mexicanas por nacimiento, verificadas exactas contra el ejemplo
 * resuelto del propio documento (prueba dorada en los tests).
 *
 * IMPORTANTE — esto CALCULA lo que las primeras 17 posiciones de la CURP
 * de una persona deberían ser aplicando el algoritmo público, exactamente
 * como cualquier calculadora de CURP ya disponible en línea. NO consulta
 * ni sustituye al registro oficial de RENAPO — no verifica que la CURP
 * calculada esté realmente asignada, activa, o coincida con la que RENAPO
 * tiene en su base de datos (BDNCURP). Mismo principio que
 * `identity.curp.syntax.validate` vs `.verify` del análisis original de
 * esta sesión: nunca se presenta como una garantía más fuerte de lo que es.
 *
 * **La posición 18 (dígito verificador) NO se calcula** — el Instructivo
 * confirma que existe un algoritmo de la Secretaría de Gobernación para
 * calcularlo, pero no lo publica (remite a "Reglas para la ejecución de
 * los procedimientos...", no compartido). Se probaron varias variantes
 * del algoritmo público ampliamente reimplementado en herramientas
 * independientes (mismo patrón que el dígito verificador del RFC) y
 * ninguna reprodujo el "9" del ejemplo resuelto del propio documento —
 * con un solo vector de prueba no es reconstruible con confianza. Se deja
 * como "?" explícito en vez de arriesgar un dígito incorrecto que
 * parezca válido (ver `warnings` en el resultado).
 *
 * El catálogo de entidades federativas (posiciones 12-13) también es de
 * conocimiento público estándar, no viene en este PDF — ver curp-catalog.ts.
 */

import { resolveEntidadFederativaCode, stripDiacritics } from "./curp-catalog.js";

export interface CurpInput {
  nombre: string;
  apellidoPaterno: string;
  /** Si se omite, se usa "X" en las posiciones 3 y 15 — mismo convenio público usado cuando no hay apellido materno. */
  apellidoMaterno?: string;
  /** Fecha de nacimiento. */
  fechaNacimiento: { year: number; month: number; day: number };
  sexo: "H" | "M";
  /** Nombre completo o código de 2 letras — ver curp-catalog.ts. */
  entidadFederativa: string;
}

export interface CurpResult {
  /** Las 17 primeras posiciones (verificadas exactas contra el ejemplo del Instructivo) + "?" en la posición 18. */
  curp: string;
  /** Las 17 primeras posiciones, sin el dígito verificador. */
  curp17: string;
  warnings: string[];
}

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

// Prefijos/conjunciones que el algoritmo público (no en el PDF del
// Instructivo) excluye al determinar la "letra inicial" de un apellido
// compuesto, ej. "DE LA CRUZ" → se usa "CRUZ", no "DE".
const NAME_CONNECTORS = new Set(["DE", "DEL", "LA", "LAS", "LOS", "Y", "MC", "VAN", "VON"]);

// Lista pública conocida de combinaciones a evitar en las posiciones 1-4
// (no viene en el Instructivo) — si las primeras 4 posiciones formarían
// una de estas palabras, la posición 2 se sustituye por "X". Lista no
// exhaustiva/no oficial, tomada de herramientas públicas de referencia.
const INCONVENIENT_WORDS = new Set([
  "BUEI", "BUEY", "CACA", "CACO", "CAGA", "CAGO", "CAKA", "CAKO",
  "COGE", "COJA", "COJE", "COJI", "COJO", "CULO", "FETO", "GUEY",
  "JOTO", "KACA", "KACO", "KAGA", "KAGO", "KOGE", "KOGI", "KOJO",
  "KAKA", "KAKO", "LILO", "LOCA", "LOCO", "LOKA", "LOKO", "MAME",
  "MAMO", "MEAR", "MEAS", "MEON", "MION", "MOCO", "MOKO", "MULA",
  "MULO", "NACA", "NACO", "PEDA", "PEDO", "PENE", "PIPI", "PITO",
  "POPO", "PUTA", "PUTO", "QULO", "RATA", "ROBA", "ROBE", "ROBO",
  "RUIN", "SENO", "TETA", "VACA", "VAGA", "VAGO", "VAKA", "VUEI",
  "VUEY", "WUEI", "WUEY",
]);


function normalizeNamePart(value: string): string {
  // Ñ→X es un convenio distinto a los demás acentos (Á/É/Í/Ó/Ú→A/E/I/O/U):
  // debe aplicarse ANTES de stripDiacritics, porque la descomposición NFD
  // de "Ñ" produce "N" + tilde combinante — si stripDiacritics corriera
  // primero, la Ñ terminaría como "N" en vez de "X" sin que este reemplazo
  // nunca llegara a verla (bug real encontrado al verificar manualmente
  // contra el ejemplo del Instructivo antes de escribir los tests).
  const withoutEnye = value.trim().toUpperCase().replace(/Ñ/g, "X");
  return stripDiacritics(withoutEnye).replace(/[^A-Z ]/g, "");
}

/** Primera "palabra sustantiva" de un apellido/nombre compuesto, saltando conectores conocidos (DE, DEL, LA...). */
function significantWord(normalized: string): string {
  const words = normalized.split(/\s+/).filter(Boolean);
  const significant = words.find((w) => !NAME_CONNECTORS.has(w));
  return significant ?? words[0] ?? "";
}

function firstInternalVowel(word: string): string {
  for (let i = 1; i < word.length; i++) {
    if (VOWELS.has(word[i])) return word[i];
  }
  return "X";
}

function firstInternalConsonant(word: string): string {
  for (let i = 1; i < word.length; i++) {
    if (!VOWELS.has(word[i]) && word[i] !== " ") return word[i];
  }
  return "X";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function computeCurp(input: CurpInput): CurpResult {
  const warnings: string[] = [];

  const apellidoPaterno = significantWord(normalizeNamePart(input.apellidoPaterno));
  const apellidoMaterno = input.apellidoMaterno ? significantWord(normalizeNamePart(input.apellidoMaterno)) : "";
  const nombre = significantWord(normalizeNamePart(input.nombre));

  if (!apellidoPaterno) throw new Error("apellidoPaterno es requerido");
  if (!nombre) throw new Error("nombre es requerido");
  if (!apellidoMaterno) {
    warnings.push('apellidoMaterno ausente — se usó "X" en las posiciones 3 y 15 (convenio público).');
  }

  const { year, month, day } = input.fechaNacimiento;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("fechaNacimiento debe tener year/month/day enteros");
  }
  if (month < 1 || month > 12) throw new Error(`Mes de nacimiento inválido: ${month}`);
  if (day < 1 || day > 31) throw new Error(`Día de nacimiento inválido: ${day}`);

  const entidadCode = resolveEntidadFederativaCode(input.entidadFederativa);

  // Posiciones 1-4
  let pos1to4 =
    apellidoPaterno[0] +
    firstInternalVowel(apellidoPaterno) +
    (apellidoMaterno ? apellidoMaterno[0] : "X") +
    nombre[0];

  if (INCONVENIENT_WORDS.has(pos1to4)) {
    pos1to4 = pos1to4[0] + "X" + pos1to4[2] + pos1to4[3];
    warnings.push(`Las posiciones 1-4 coincidían con una palabra a evitar — se sustituyó la posición 2 por "X" (convenio público, no en el Instructivo).`);
  }

  // Posiciones 5-10: fecha de nacimiento AAMMDD
  const yy = pad2(year % 100);
  const mm = pad2(month);
  const dd = pad2(day);

  // Posición 11
  const sexo = input.sexo;

  // Posiciones 12-13
  const entidad = entidadCode;

  // Posiciones 14-16
  const pos14to16 =
    firstInternalConsonant(apellidoPaterno) +
    (apellidoMaterno ? firstInternalConsonant(apellidoMaterno) : "X") +
    firstInternalConsonant(nombre);

  // Posición 17: diferenciador de homonimia + siglo. No se puede
  // determinar sin consultar la BDNCURP (base en vivo de RENAPO) — se usa
  // el valor por defecto de "sin homónimos detectados" y se advierte.
  const differentiator = year >= 2000 ? "A" : "0";
  warnings.push(
    `Posición 17 (diferenciador de homonimia) asumida en "${differentiator}" por no poder consultar la BDNCURP en vivo — no está verificado que este valor sea el que RENAPO asignaría realmente si ya existiera un registro con las mismas primeras 16 posiciones.`
  );

  const first17 = pos1to4 + yy + mm + dd + sexo + entidad + pos14to16 + differentiator;

  // Posición 18 (dígito verificador): el Instructivo confirma que existe
  // un algoritmo de la Secretaría de Gobernación para calcularlo, pero no
  // lo publica. Se intentaron varias variantes del algoritmo público
  // ampliamente reimplementado en herramientas independientes (mismo
  // patrón que el dígito verificador del RFC) y ninguna reprodujo el "9"
  // del ejemplo resuelto del propio Instructivo — con un solo vector de
  // prueba no es posible reconstruir con confianza una fórmula de 17
  // pesos desconocidos por prueba y error. Se deja explícitamente sin
  // calcular en vez de arriesgar un dígito incorrecto que parezca válido.
  warnings.push(
    'Posición 18 (dígito verificador) NO se calculó — el algoritmo exacto no está publicado en el Instructivo y los intentos con la fórmula pública conocida no reprodujeron el ejemplo resuelto del propio documento. "curp" trae "?" en esa posición; "curp17" trae las 17 posiciones sin el dígito.'
  );

  return { curp: first17 + "?", curp17: first17, warnings };
}
