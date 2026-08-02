/**
 * Puerto AssemblyScript de ../../satellite-capabilities/src/curp-catalog.ts.
 * AssemblyScript no soporta `String.prototype.normalize()` ni regex con
 * propiedades Unicode (`\p{Mn}`) — stripDiacritics se reimplementa aquí con
 * un mapa de caracteres explícito, cubriendo solo los acentos que puede
 * producir el alfabeto español (á é í ó ú ü + mayúsculas).
 */

class EntidadEntry {
  name: string;
  code: string;
  constructor(name: string, code: string) {
    this.name = name;
    this.code = code;
  }
}

const ENTIDADES: EntidadEntry[] = [
  new EntidadEntry("AGUASCALIENTES", "AS"),
  new EntidadEntry("BAJA CALIFORNIA", "BC"),
  new EntidadEntry("BAJA CALIFORNIA SUR", "BS"),
  new EntidadEntry("CAMPECHE", "CC"),
  new EntidadEntry("COAHUILA", "CL"),
  new EntidadEntry("COLIMA", "CM"),
  new EntidadEntry("CHIAPAS", "CS"),
  new EntidadEntry("CHIHUAHUA", "CH"),
  new EntidadEntry("CIUDAD DE MEXICO", "DF"),
  new EntidadEntry("DISTRITO FEDERAL", "DF"),
  new EntidadEntry("DURANGO", "DG"),
  new EntidadEntry("GUANAJUATO", "GT"),
  new EntidadEntry("GUERRERO", "GR"),
  new EntidadEntry("HIDALGO", "HG"),
  new EntidadEntry("JALISCO", "JC"),
  new EntidadEntry("MEXICO", "MC"),
  new EntidadEntry("ESTADO DE MEXICO", "MC"),
  new EntidadEntry("MICHOACAN", "MN"),
  new EntidadEntry("MORELOS", "MS"),
  new EntidadEntry("NAYARIT", "NT"),
  new EntidadEntry("NUEVO LEON", "NL"),
  new EntidadEntry("OAXACA", "OC"),
  new EntidadEntry("PUEBLA", "PL"),
  new EntidadEntry("QUERETARO", "QT"),
  new EntidadEntry("QUINTANA ROO", "QR"),
  new EntidadEntry("SAN LUIS POTOSI", "SP"),
  new EntidadEntry("SINALOA", "SL"),
  new EntidadEntry("SONORA", "SR"),
  new EntidadEntry("TABASCO", "TC"),
  new EntidadEntry("TAMAULIPAS", "TS"),
  new EntidadEntry("TLAXCALA", "TL"),
  new EntidadEntry("VERACRUZ", "VZ"),
  new EntidadEntry("YUCATAN", "YN"),
  new EntidadEntry("ZACATECAS", "ZS"),
  new EntidadEntry("NACIDO EN EL EXTRANJERO", "NE"),
];

const VALID_CODES: string[] = [
  "AS", "BC", "BS", "CC", "CL", "CM", "CS", "CH", "DF", "DG", "GT", "GR",
  "HG", "JC", "MC", "MN", "MS", "NT", "NL", "OC", "PL", "QT", "QR", "SP",
  "SL", "SR", "TC", "TS", "TL", "VZ", "YN", "ZS", "NE",
];

function isValidCode(code: string): boolean {
  for (let i = 0; i < VALID_CODES.length; i++) {
    if (VALID_CODES[i] == code) return true;
  }
  return false;
}

function stripDiacriticChar(ch: string): string {
  if (ch == "Á") return "A";
  if (ch == "É") return "E";
  if (ch == "Í") return "I";
  if (ch == "Ó") return "O";
  if (ch == "Ú") return "U";
  if (ch == "Ü") return "U";
  if (ch == "á") return "a";
  if (ch == "é") return "e";
  if (ch == "í") return "i";
  if (ch == "ó") return "o";
  if (ch == "ú") return "u";
  if (ch == "ü") return "u";
  return ch;
}

/** Quita acentos (á→a, é→e, ...) vía mapa explícito — sin normalize()/regex Unicode. */
export function stripDiacritics(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    out += stripDiacriticChar(value.charAt(i));
  }
  return out;
}

/** Acepta el nombre completo de la entidad (sin acentos, cualquier case) o ya el código de 2 letras. Devuelve "" si no se reconoce. */
export function resolveEntidadFederativaCode(entidad: string): string {
  const normalized = stripDiacritics(entidad.trim().toUpperCase());

  if (normalized.length == 2 && isValidCode(normalized)) {
    return normalized;
  }

  for (let i = 0; i < ENTIDADES.length; i++) {
    if (ENTIDADES[i].name == normalized) return ENTIDADES[i].code;
  }
  return "";
}
