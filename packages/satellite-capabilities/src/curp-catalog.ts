/**
 * Catálogo de códigos de 2 letras por entidad federativa (posiciones 12-13
 * de la CURP). El instructivo oficial (DOF, publicado 18-06-2018,
 * modificado 18-10-2021) remite este catálogo a un documento separado
 * ("Reglas para la ejecución de los procedimientos para la conformación
 * de la CURP") que no forma parte del PDF con el que se construyó este
 * módulo — este es el catálogo estándar de conocimiento público, usado de
 * forma consistente por las calculadoras de CURP conocidas, no una fuente
 * oficial verbatim.
 */
export const ENTIDAD_FEDERATIVA_CODES: Readonly<Record<string, string>> = {
  AGUASCALIENTES: "AS",
  "BAJA CALIFORNIA": "BC",
  "BAJA CALIFORNIA SUR": "BS",
  CAMPECHE: "CC",
  COAHUILA: "CL",
  COLIMA: "CM",
  CHIAPAS: "CS",
  CHIHUAHUA: "CH",
  "CIUDAD DE MEXICO": "DF",
  "DISTRITO FEDERAL": "DF",
  DURANGO: "DG",
  GUANAJUATO: "GT",
  GUERRERO: "GR",
  HIDALGO: "HG",
  JALISCO: "JC",
  MEXICO: "MC",
  "ESTADO DE MEXICO": "MC",
  MICHOACAN: "MN",
  MORELOS: "MS",
  NAYARIT: "NT",
  "NUEVO LEON": "NL",
  OAXACA: "OC",
  PUEBLA: "PL",
  QUERETARO: "QT",
  "QUINTANA ROO": "QR",
  "SAN LUIS POTOSI": "SP",
  SINALOA: "SL",
  SONORA: "SR",
  TABASCO: "TC",
  TAMAULIPAS: "TS",
  TLAXCALA: "TL",
  VERACRUZ: "VZ",
  YUCATAN: "YN",
  ZACATECAS: "ZS",
  "NACIDO EN EL EXTRANJERO": "NE",
};

const VALID_CODES = new Set(Object.values(ENTIDAD_FEDERATIVA_CODES));

/** Quita diacríticos (á→a, é→e, etc.) vía descomposición Unicode NFD + filtro de marcas combinantes. */
export function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{Mn}/gu, "");
}

/** Acepta el nombre completo de la entidad (sin acentos, cualquier case) o ya el código de 2 letras. */
export function resolveEntidadFederativaCode(entidad: string): string {
  const normalized = stripDiacritics(entidad.trim().toUpperCase());

  if (normalized.length === 2 && VALID_CODES.has(normalized)) {
    return normalized;
  }

  const code = ENTIDAD_FEDERATIVA_CODES[normalized];
  if (!code) {
    throw new Error(`Entidad federativa no reconocida: "${entidad}"`);
  }
  return code;
}
