//! Comandos de chat autodescubiertos (SPEC-CMD-0001, DEC-0100).
//!
//! Un nodo declara en `Beacon.commands` los comandos que ofrece. Este módulo
//! valida esos descriptores (límites, canonicalidad, saneamiento), calcula la
//! huella del contrato, parsea líneas `/nombre args` con la gramática normativa,
//! valida el resultado del nodo y construye la tabla de comandos vigentes a
//! partir de los anuncios admitidos. Todo es determinista y sin red.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use prost::Message;
use serde::Deserialize;
use unicode_general_category::{get_general_category, GeneralCategory};

use crate::authorization::{framed, value_digest, DigestError, DOMAIN_COMMAND_ARGS};
use crate::p2p::peer_cache::PeerEntry;
use crate::protocol::fhs::{
    dynamic_value::Kind, CommandArgType, CommandDescriptor, CommandSummary, DynamicObject,
    DynamicValue,
};

pub const DOMAIN_CONTRACT: &str = "fhs/cmd/contract";
pub const DOMAIN_REGISTRY: &str = "fhs/cmd/registry";
/// Primera versión del protocolo cuyo Beacon puede llevar `commands`.
pub const MIN_COMMANDS_VERSION: (u32, u32) = (0, 2);

pub const MAX_COMMANDS: usize = 8;
pub const MAX_ARGS: usize = 4;
pub const MAX_COMMANDS_BYTES: usize = 4096;
pub const MAX_LINE_CHARS: usize = 2048;
pub const MAX_SUMMARY_CHARS: usize = 120;
pub const MAX_DESCRIPTION_CHARS: usize = 80;
pub const MAX_ALLOWED_CHARS: usize = 128;
pub const MAX_STRING_LENGTH: i32 = 1024;
pub const MAX_NESTING: i32 = 64;
pub const MAX_ENUM_VALUES: usize = 16;
pub const MAX_ENUM_VALUE_CHARS: usize = 64;
pub const MAX_RESULT_CHARS: i32 = 64;
/// Tope fijo de un token INTEGER, NUMBER o BOOLEAN.
pub const MAX_SCALAR_CHARS: usize = 32;
pub const RESERVED_NAMES: [&str; 3] = ["ayuda", "help", "comandos"];

/// El registro embebido es el del estándar (`galaxIA/idl/command-capabilities.json`).
pub const BUILTIN_REGISTRY: &str = include_str!("../proto/command-capabilities.json");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptorError(pub String);

impl std::fmt::Display for DescriptorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DescriptorError {}

fn err<T>(message: impl Into<String>) -> Result<T, DescriptorError> {
    Err(DescriptorError(message.into()))
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Saneamiento ──────────────────────────────────────────────────────────────

/// "Imprimible": letras, marcas, números, puntuación, símbolos y U+0020.
pub fn is_printable(c: char) -> bool {
    use GeneralCategory::*;
    c == ' '
        || matches!(
            get_general_category(c),
            UppercaseLetter
                | LowercaseLetter
                | TitlecaseLetter
                | ModifierLetter
                | OtherLetter
                | NonspacingMark
                | SpacingMark
                | EnclosingMark
                | DecimalNumber
                | LetterNumber
                | OtherNumber
                | ConnectorPunctuation
                | DashPunctuation
                | OpenPunctuation
                | ClosePunctuation
                | InitialPunctuation
                | FinalPunctuation
                | OtherPunctuation
                | MathSymbol
                | CurrencySymbol
                | ModifierSymbol
                | OtherSymbol
        )
}

pub fn is_plain_text(text: &str, max_chars: usize) -> bool {
    text.chars().count() <= max_chars && text.chars().all(is_printable)
}

fn is_ident(text: &str, max: usize, extra: char) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && text.chars().count() <= max
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == extra)
}

pub fn is_command_name(name: &str) -> bool {
    is_ident(name, 24, '-')
}

fn is_arg_name(name: &str) -> bool {
    is_ident(name, 24, '_')
}

fn is_tool_name(name: &str) -> bool {
    is_ident(name, 32, '_')
}

// ── Registro cerrado ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Open,
    Trusted,
}

#[derive(Debug, Clone)]
pub struct RegistryEntry {
    pub tools: Vec<String>,
    pub admission: Admission,
    pub error_codes: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRegistry {
    registry_version: u32,
    entries: BTreeMap<String, RawEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEntry {
    tools: Vec<String>,
    admission: String,
    error_codes: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct Registry {
    pub version: u32,
    pub entries: BTreeMap<String, RegistryEntry>,
    /// `SHA-256("fhs/cmd/registry" ‖ 0x00 ‖ "1" ‖ 0x00 ‖ bytes exactos)`, en hex.
    pub digest: String,
}

fn is_capability_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|p| {
            let mut chars = p.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

impl Registry {
    /// Valida el archivo contra el esquema del estándar; si no cumple, error.
    pub fn parse(bytes: &[u8]) -> Result<Registry, DescriptorError> {
        let raw: RawRegistry = serde_json::from_slice(bytes)
            .map_err(|e| DescriptorError(format!("registro de comandos inválido: {e}")))?;
        if raw.registry_version != 1 {
            return err(format!(
                "registry_version {} no soportada",
                raw.registry_version
            ));
        }
        if raw.entries.is_empty() {
            return err("el registro de comandos no tiene entradas");
        }
        let mut entries = BTreeMap::new();
        for (capability, entry) in raw.entries {
            if !is_capability_id(&capability) {
                return err(format!("capacidad inválida en el registro: {capability}"));
            }
            if entry.tools.is_empty() || entry.tools.len() > 8 {
                return err(format!("{capability}: tools debe tener de 1 a 8 elementos"));
            }
            let unique: HashSet<&String> = entry.tools.iter().collect();
            if unique.len() != entry.tools.len() || !entry.tools.iter().all(|t| is_tool_name(t)) {
                return err(format!("{capability}: tools inválidas o repetidas"));
            }
            let admission = match entry.admission.as_str() {
                "open" => Admission::Open,
                "trusted" => Admission::Trusted,
                other => return err(format!("{capability}: admission desconocida: {other}")),
            };
            if entry.error_codes.len() > 16 {
                return err(format!("{capability}: más de 16 códigos de error"));
            }
            for (code, text) in &entry.error_codes {
                let valid_code = {
                    let mut chars = code.chars();
                    matches!(chars.next(), Some(c) if c.is_ascii_uppercase())
                        && code.chars().count() <= 32
                        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                };
                if !valid_code || text.is_empty() || !is_plain_text(text, 120) {
                    return err(format!("{capability}: código de error inválido: {code}"));
                }
            }
            entries.insert(
                capability,
                RegistryEntry {
                    tools: entry.tools,
                    admission,
                    error_codes: entry.error_codes,
                },
            );
        }
        Ok(Registry {
            version: raw.registry_version,
            entries,
            digest: to_hex(&framed(DOMAIN_REGISTRY, bytes)),
        })
    }

    pub fn builtin() -> Registry {
        Registry::parse(BUILTIN_REGISTRY.as_bytes()).expect("registro embebido válido")
    }

    /// Texto propio del Navigator para un error del nodo. Solo coincide con un
    /// código exacto del registro; cualquier otra cosa es `None`.
    pub fn error_text(&self, capability: &str, error: &str) -> Option<&str> {
        self.entries
            .get(capability)?
            .error_codes
            .get(error)
            .map(String::as_str)
    }
}

// ── Validación de descriptores ───────────────────────────────────────────────

fn canonical_chars(chars: &str) -> bool {
    let points: Vec<char> = chars.chars().collect();
    points.len() <= MAX_ALLOWED_CHARS
        && points.windows(2).all(|w| w[0] < w[1])
        && points.iter().all(|c| is_printable(*c))
}

fn validate_arg(
    command: &str,
    arg: &crate::protocol::fhs::CommandArg,
    last: bool,
) -> Result<(), DescriptorError> {
    let at = |msg: &str| DescriptorError(format!("/{command} {}: {msg}", arg.name));
    if !is_arg_name(&arg.name) {
        return Err(at("nombre de argumento inválido"));
    }
    if !is_plain_text(&arg.description, MAX_DESCRIPTION_CHARS) {
        return Err(at("descripción inválida"));
    }
    let kind = CommandArgType::try_from(arg.r#type).unwrap_or(CommandArgType::Unspecified);
    let scalar = matches!(
        kind,
        CommandArgType::Integer | CommandArgType::Number | CommandArgType::Boolean
    );
    match kind {
        CommandArgType::String => {
            if !(1..=MAX_STRING_LENGTH).contains(&arg.max_length) {
                return Err(at("max_length fuera de 1..=1024"));
            }
            if !canonical_chars(&arg.allowed_chars) {
                return Err(at("allowed_chars no canónico"));
            }
            if !(0..=MAX_NESTING).contains(&arg.max_nesting) {
                return Err(at("max_nesting fuera de 0..=64"));
            }
            if !arg.enum_values.is_empty() {
                return Err(at("enum_values no aplica a STRING"));
            }
            if arg.rest && !last {
                return Err(at("solo el último argumento puede ser rest"));
            }
        }
        CommandArgType::Enum => {
            let values = &arg.enum_values;
            if values.is_empty() || values.len() > MAX_ENUM_VALUES {
                return Err(at("enum_values debe tener de 1 a 16 valores"));
            }
            let ordered = values.windows(2).all(|w| w[0].as_bytes() < w[1].as_bytes());
            let valid = values.iter().all(|v| {
                let n = v.chars().count();
                (1..=MAX_ENUM_VALUE_CHARS).contains(&n)
                    && v.chars().all(|c| is_printable(c) && c != ' ')
            });
            if !ordered || !valid {
                return Err(at("enum_values no canónico"));
            }
            if arg.max_length != 0
                || !arg.allowed_chars.is_empty()
                || arg.max_nesting != 0
                || arg.rest
            {
                return Err(at("campos de STRING no aplican a ENUM"));
            }
        }
        _ if scalar => {
            if arg.max_length != 0
                || !arg.allowed_chars.is_empty()
                || arg.max_nesting != 0
                || arg.rest
                || !arg.enum_values.is_empty()
            {
                return Err(at("el tipo escalar no admite límites ni rest"));
            }
        }
        _ => return Err(at("tipo de argumento no especificado")),
    }
    Ok(())
}

fn validate_descriptor(
    descriptor: &CommandDescriptor,
    beacon_capabilities: &[String],
    registry: &Registry,
) -> Result<(), DescriptorError> {
    let name = &descriptor.name;
    if !is_command_name(name) || RESERVED_NAMES.contains(&name.as_str()) {
        return err(format!("nombre de comando inválido o reservado: {name:?}"));
    }
    let Some(entry) = registry.entries.get(&descriptor.capability_id) else {
        return err(format!(
            "/{name}: la capacidad {} no está en el registro de comandos",
            descriptor.capability_id
        ));
    };
    if !beacon_capabilities.contains(&descriptor.capability_id) {
        return err(format!(
            "/{name}: la capacidad {} no está anunciada en el Beacon",
            descriptor.capability_id
        ));
    }
    if !entry.tools.contains(&descriptor.tool_name) {
        return err(format!(
            "/{name}: la herramienta {} no está permitida para {}",
            descriptor.tool_name, descriptor.capability_id
        ));
    }
    if !is_plain_text(&descriptor.summary, MAX_SUMMARY_CHARS) {
        return err(format!("/{name}: summary inválido"));
    }
    if descriptor.args.len() > MAX_ARGS {
        return err(format!("/{name}: más de {MAX_ARGS} argumentos"));
    }
    let mut names = HashSet::new();
    let mut seen_optional = false;
    for (index, arg) in descriptor.args.iter().enumerate() {
        if !names.insert(arg.name.as_str()) {
            return err(format!("/{name}: argumento repetido: {}", arg.name));
        }
        validate_arg(name, arg, index + 1 == descriptor.args.len())?;
        if arg.required && seen_optional {
            return err(format!(
                "/{name}: un argumento obligatorio no puede seguir a uno opcional"
            ));
        }
        seen_optional |= !arg.required;
    }
    let Some(result) = &descriptor.result else {
        return err(format!("/{name}: falta result"));
    };
    let kind = CommandArgType::try_from(result.r#type).unwrap_or(CommandArgType::Unspecified);
    if !matches!(
        kind,
        CommandArgType::Number | CommandArgType::Integer | CommandArgType::Boolean
    ) || !(1..=MAX_RESULT_CHARS).contains(&result.max_chars)
    {
        return err(format!("/{name}: result inválido"));
    }
    Ok(())
}

/// Valida todos los descriptores de un Beacon. Un incumplimiento invalida el
/// anuncio de comandos completo del nodo.
pub fn validate_descriptors(
    commands: &[CommandDescriptor],
    beacon_capabilities: &[String],
    registry: &Registry,
) -> Result<(), DescriptorError> {
    if commands.len() > MAX_COMMANDS {
        return err(format!("más de {MAX_COMMANDS} comandos"));
    }
    let encoded: usize = commands
        .iter()
        .map(|c| {
            let len = c.encoded_len();
            1 + prost::encoding::encoded_len_varint(len as u64) + len
        })
        .sum();
    if encoded > MAX_COMMANDS_BYTES {
        return err(format!(
            "commands ocupa {encoded} bytes (máximo {MAX_COMMANDS_BYTES})"
        ));
    }
    if !commands
        .windows(2)
        .all(|w| w[0].name.as_bytes() < w[1].name.as_bytes())
    {
        return err("los comandos deben estar ordenados por nombre y ser únicos");
    }
    for descriptor in commands {
        validate_descriptor(descriptor, beacon_capabilities, registry)?;
    }
    Ok(())
}

/// Huella del contrato ejecutable: sin `summary` ni `description`.
pub fn fingerprint(descriptor: &CommandDescriptor) -> String {
    let mut contract = descriptor.clone();
    contract.summary.clear();
    for arg in &mut contract.args {
        arg.description.clear();
    }
    to_hex(&framed(DOMAIN_CONTRACT, &contract.encode_to_vec()))
}

// ── Gramática de entrada ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ArgValue {
    String(String),
    Integer(i64),
    /// Texto decimal canónico (`-0` ya normalizado a `0`).
    Number(String),
    Boolean(bool),
    Enum(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    LineTooLong,
    Missing(String),
    Extra,
    TooLong { arg: String, max: i32 },
    BadChar { arg: String, ch: char },
    TooDeep { arg: String, max: i32 },
    BadInteger(String),
    BadNumber(String),
    BadBoolean(String),
    BadEnum { arg: String, values: Vec<String> },
}

impl ParseError {
    /// Texto para la persona (el uso lo agrega quien llama).
    pub fn message(&self) -> String {
        match self {
            ParseError::LineTooLong => {
                format!("La línea supera {MAX_LINE_CHARS} caracteres")
            }
            ParseError::Missing(arg) => format!("Falta el argumento «{arg}»"),
            ParseError::Extra => "Sobran argumentos".to_string(),
            ParseError::TooLong { arg, max } => {
                format!("«{arg}» supera {max} caracteres")
            }
            ParseError::BadChar { arg, ch } => {
                format!("Carácter no permitido en «{arg}»: {ch:?}")
            }
            ParseError::TooDeep { arg, max } => {
                format!("«{arg}» tiene demasiados paréntesis anidados (máximo {max})")
            }
            ParseError::BadInteger(arg) => format!("«{arg}» debe ser un entero"),
            ParseError::BadNumber(arg) => format!("«{arg}» debe ser un número decimal"),
            ParseError::BadBoolean(arg) => format!("«{arg}» debe ser true o false"),
            ParseError::BadEnum { arg, values } => {
                format!("«{arg}» debe ser uno de: {}", values.join(", "))
            }
        }
    }
}

/// Cómo se interpreta una línea del usuario.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineKind<'a> {
    /// No empieza con `/`: texto normal.
    Plain,
    /// `//texto`: se envía como el literal `/texto` al Star elegido.
    Escaped(&'a str),
    /// `/nombre resto`.
    Command { name: String, rest: &'a str },
}

pub fn classify_line(line: &str) -> LineKind<'_> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("//") {
        let _ = rest;
        return LineKind::Escaped(&line[1..]);
    }
    let Some(body) = line.strip_prefix('/') else {
        return LineKind::Plain;
    };
    let end = body.find([' ', '\t']).unwrap_or(body.len());
    LineKind::Command {
        name: body[..end].to_ascii_lowercase(),
        rest: &body[end..],
    }
}

fn is_blank(c: char) -> bool {
    c == ' ' || c == '\t'
}

fn parse_integer(arg: &str, token: &str) -> Result<ArgValue, ParseError> {
    let digits = token.strip_prefix('-').unwrap_or(token);
    let canonical = !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'));
    if !canonical || token.chars().count() > MAX_SCALAR_CHARS {
        return Err(ParseError::BadInteger(arg.into()));
    }
    token
        .parse::<i64>()
        .map(ArgValue::Integer)
        .map_err(|_| ParseError::BadInteger(arg.into()))
}

fn parse_number(arg: &str, token: &str) -> Result<ArgValue, ParseError> {
    let bad = || ParseError::BadNumber(arg.into());
    if token.chars().count() > MAX_SCALAR_CHARS {
        return Err(bad());
    }
    let unsigned = token.strip_prefix('-').unwrap_or(token);
    let (int, frac) = match unsigned.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (unsigned, None),
    };
    let int_ok = !int.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && (int == "0" || !int.starts_with('0'));
    let frac_ok = frac.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()));
    if !int_ok || !frac_ok {
        return Err(bad());
    }
    Ok(ArgValue::Number(canonical_number(token)))
}

/// `-0` (y `-0.0…`) se normaliza a `0`.
pub fn canonical_number(text: &str) -> String {
    match text.strip_prefix('-') {
        Some(rest) if rest.chars().all(|c| c == '0' || c == '.') => rest.to_string(),
        _ => text.to_string(),
    }
}

fn parse_value(
    arg: &crate::protocol::fhs::CommandArg,
    token: &str,
) -> Result<ArgValue, ParseError> {
    let name = arg.name.clone();
    match CommandArgType::try_from(arg.r#type).unwrap_or(CommandArgType::Unspecified) {
        CommandArgType::String => {
            if token.chars().count() > arg.max_length as usize {
                return Err(ParseError::TooLong {
                    arg: name,
                    max: arg.max_length,
                });
            }
            if !arg.allowed_chars.is_empty() {
                if let Some(ch) = token.chars().find(|c| !arg.allowed_chars.contains(*c)) {
                    return Err(ParseError::BadChar { arg: name, ch });
                }
            }
            if arg.max_nesting > 0 {
                let (mut depth, mut max) = (0i32, 0i32);
                for c in token.chars() {
                    match c {
                        '(' => {
                            depth += 1;
                            max = max.max(depth);
                        }
                        ')' => depth = (depth - 1).max(0),
                        _ => {}
                    }
                }
                if max > arg.max_nesting {
                    return Err(ParseError::TooDeep {
                        arg: name,
                        max: arg.max_nesting,
                    });
                }
            }
            Ok(ArgValue::String(token.to_string()))
        }
        CommandArgType::Integer => parse_integer(&name, token),
        CommandArgType::Number => parse_number(&name, token),
        CommandArgType::Boolean => match token {
            "true" => Ok(ArgValue::Boolean(true)),
            "false" => Ok(ArgValue::Boolean(false)),
            _ => Err(ParseError::BadBoolean(name)),
        },
        CommandArgType::Enum => {
            if arg.enum_values.iter().any(|v| v == token) {
                Ok(ArgValue::Enum(token.to_string()))
            } else {
                Err(ParseError::BadEnum {
                    arg: name,
                    values: arg.enum_values.clone(),
                })
            }
        }
        CommandArgType::Unspecified => Err(ParseError::Missing(name)),
    }
}

/// Parsea y valida `rest` (lo que sigue a `/nombre`) con el descriptor.
pub fn parse_args(
    descriptor: &CommandDescriptor,
    rest: &str,
) -> Result<Vec<(String, ArgValue)>, ParseError> {
    if rest.chars().count() > MAX_LINE_CHARS {
        return Err(ParseError::LineTooLong);
    }
    let mut out = Vec::new();
    let mut cursor = rest.trim_start_matches(is_blank);
    for arg in &descriptor.args {
        if cursor.is_empty() {
            if arg.required {
                return Err(ParseError::Missing(arg.name.clone()));
            }
            break;
        }
        let token = if arg.rest {
            let all = cursor.trim_end_matches(is_blank);
            cursor = "";
            all
        } else {
            let end = cursor.find(is_blank).unwrap_or(cursor.len());
            let token = &cursor[..end];
            cursor = cursor[end..].trim_start_matches(is_blank);
            token
        };
        out.push((arg.name.clone(), parse_value(arg, token)?));
    }
    if !cursor.is_empty() {
        return Err(ParseError::Extra);
    }
    Ok(out)
}

/// `/calc <expression>` (`[x]` si es opcional, `<x...>` si toma el resto).
pub fn usage(descriptor: &CommandDescriptor) -> String {
    let mut text = format!("/{}", descriptor.name);
    for arg in &descriptor.args {
        let dots = if arg.rest { "..." } else { "" };
        if arg.required {
            text.push_str(&format!(" <{}{dots}>", arg.name));
        } else {
            text.push_str(&format!(" [{}{dots}]", arg.name));
        }
    }
    text
}

/// Argumentos tipados como `DynamicValue` objeto (lo que lleva el `ToolCall`).
pub fn args_value(args: &[(String, ArgValue)]) -> DynamicValue {
    let fields = args
        .iter()
        .map(|(name, value)| {
            let kind = match value {
                ArgValue::String(s) | ArgValue::Enum(s) => Kind::StringValue(s.clone()),
                ArgValue::Integer(i) => Kind::IntegerValue(*i),
                ArgValue::Number(text) => Kind::NumberValue(text.parse::<f64>().unwrap_or(0.0)),
                ArgValue::Boolean(b) => Kind::BooleanValue(*b),
            };
            (name.clone(), DynamicValue { kind: Some(kind) })
        })
        .collect();
    DynamicValue {
        kind: Some(Kind::ObjectValue(DynamicObject { fields })),
    }
}

/// Digest `command_args`: cv1 de `{ "args": <objeto>, "tool": <texto> }`.
pub fn command_args_digest(tool: &str, args: &DynamicValue) -> Result<[u8; 32], DigestError> {
    let mut fields = std::collections::HashMap::new();
    fields.insert("args".to_string(), args.clone());
    fields.insert(
        "tool".to_string(),
        DynamicValue {
            kind: Some(Kind::StringValue(tool.to_string())),
        },
    );
    value_digest(
        DOMAIN_COMMAND_ARGS,
        &DynamicValue {
            kind: Some(Kind::ObjectValue(DynamicObject { fields })),
        },
    )
}

// ── Resultado ────────────────────────────────────────────────────────────────

/// Valida el resultado del nodo contra `CommandResult` y devuelve el texto
/// canónico a mostrar. El nodo no puede aportar otra cosa que ese valor.
pub fn validate_result(
    descriptor: &CommandDescriptor,
    value: &DynamicValue,
) -> Result<String, String> {
    let Some(Kind::ObjectValue(object)) = &value.kind else {
        return Err("el nodo no devolvió un objeto".into());
    };
    if object.fields.len() != 1 {
        return Err("el resultado del nodo trae campos de más o de menos".into());
    }
    let Some(DynamicValue {
        kind: Some(Kind::StringValue(text)),
    }) = object.fields.get("result")
    else {
        return Err("el nodo no devolvió {result} como texto".into());
    };
    let spec = descriptor
        .result
        .as_ref()
        .ok_or("el comando no declara result")?;
    if text.chars().count() > spec.max_chars as usize {
        return Err("el resultado del nodo es demasiado largo".into());
    }
    match CommandArgType::try_from(spec.r#type).unwrap_or(CommandArgType::Unspecified) {
        CommandArgType::Integer => match parse_integer("result", text) {
            Ok(ArgValue::Integer(i)) => Ok(i.to_string()),
            _ => Err("el resultado del nodo no es un entero válido".into()),
        },
        CommandArgType::Number => match parse_number("result", text) {
            Ok(ArgValue::Number(canonical)) => Ok(canonical),
            _ => Err("el resultado del nodo no es un número válido".into()),
        },
        CommandArgType::Boolean => match text.as_str() {
            "true" | "false" => Ok(text.clone()),
            _ => Err("el resultado del nodo no es un booleano válido".into()),
        },
        _ => Err("tipo de resultado no soportado".into()),
    }
}

// ── Tabla de comandos ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum OpenNodes {
    /// Sin variable: no hay comandos abiertos.
    #[default]
    None,
    All,
    List(HashSet<String>),
}

#[derive(Debug, Clone, Default)]
pub struct Policy {
    /// `FHS_COMMAND_NODES` (capacidades `open`).
    pub open: OpenNodes,
    /// `FHS_TRUSTED_NODES` (capacidades `trusted`).
    pub trusted: HashSet<String>,
}

impl Policy {
    pub fn admits(&self, admission: Admission, did: &str) -> bool {
        match admission {
            Admission::Open => match &self.open {
                OpenNodes::None => false,
                OpenNodes::All => true,
                OpenNodes::List(list) => list.contains(did),
            },
            Admission::Trusted => self.trusted.contains(did),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActiveCommand {
    /// Descriptor del nodo admitido con el DID menor entre los de la huella.
    pub descriptor: CommandDescriptor,
    pub fingerprint: String,
    /// DIDs admitidos que ofrecen exactamente este contrato (ordenados).
    pub nodes: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum Entry {
    Active(ActiveCommand),
    Conflict { nodes: usize },
}

#[derive(Debug, Clone)]
pub enum Resolution<'a> {
    Active(&'a ActiveCommand),
    Conflict(usize),
    Unknown,
}

#[derive(Debug, Clone, Default)]
pub struct CommandTable {
    entries: BTreeMap<String, Entry>,
    /// Anuncios con comandos descartados y el motivo (para la bitácora).
    pub rejected: Vec<(String, String)>,
}

fn version_at_least(version: &str, min: (u32, u32)) -> bool {
    let mut parts = version.split('.');
    let major = parts.next().and_then(|p| p.parse::<u32>().ok());
    let minor = parts.next().and_then(|p| p.parse::<u32>().ok());
    matches!((major, minor), (Some(a), Some(b)) if (a, b) >= min)
}

impl CommandTable {
    /// Construye la tabla con los anuncios vivos. `now_ms` descarta los que
    /// vencieron según su propio `timestamp + ttl` (sin la gracia de la caché).
    pub fn from_peers(
        registry: &Registry,
        policy: &Policy,
        peers: &[PeerEntry],
        now_ms: i64,
    ) -> CommandTable {
        let mut groups: BTreeMap<String, BTreeMap<String, Vec<(String, CommandDescriptor)>>> =
            BTreeMap::new();
        let mut rejected = Vec::new();
        for peer in peers {
            if peer.beacon.commands.is_empty() || peer.advert_expires_ms <= now_ms {
                continue;
            }
            if !version_at_least(&peer.beacon.fhs_version, MIN_COMMANDS_VERSION) {
                rejected.push((peer.did.clone(), "fhs_version menor a 0.2".to_string()));
                continue;
            }
            let capabilities: Vec<String> = peer
                .beacon
                .capabilities
                .iter()
                .map(|c| c.id.clone())
                .collect();
            if let Err(error) = validate_descriptors(&peer.beacon.commands, &capabilities, registry)
            {
                rejected.push((peer.did.clone(), error.0));
                continue;
            }
            for descriptor in &peer.beacon.commands {
                let admission = registry.entries[&descriptor.capability_id].admission;
                if !policy.admits(admission, &peer.did) {
                    continue;
                }
                groups
                    .entry(descriptor.name.clone())
                    .or_default()
                    .entry(fingerprint(descriptor))
                    .or_default()
                    .push((peer.did.clone(), descriptor.clone()));
            }
        }
        let mut entries = BTreeMap::new();
        for (name, by_fingerprint) in groups {
            if by_fingerprint.len() > 1 {
                let nodes = by_fingerprint.values().map(Vec::len).sum();
                entries.insert(name, Entry::Conflict { nodes });
                continue;
            }
            let (fingerprint, mut offers) = by_fingerprint.into_iter().next().expect("grupo");
            offers.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            let descriptor = offers[0].1.clone();
            let nodes: BTreeSet<String> = offers.into_iter().map(|(did, _)| did).collect();
            entries.insert(
                name,
                Entry::Active(ActiveCommand {
                    descriptor,
                    fingerprint,
                    nodes: nodes.into_iter().collect(),
                }),
            );
        }
        CommandTable { entries, rejected }
    }

    pub fn resolve(&self, name: &str) -> Resolution<'_> {
        match self.entries.get(name) {
            Some(Entry::Active(command)) => Resolution::Active(command),
            Some(Entry::Conflict { nodes }) => Resolution::Conflict(*nodes),
            None => Resolution::Unknown,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Resumen para `commands.available` y `/ayuda` (orden por nombre).
    pub fn summaries(&self) -> Vec<CommandSummary> {
        self.entries
            .iter()
            .map(|(name, entry)| match entry {
                Entry::Active(command) => CommandSummary {
                    name: name.clone(),
                    usage: usage(&command.descriptor),
                    summary: command.descriptor.summary.clone(),
                    nodes_count: command.nodes.len() as i32,
                    conflict: false,
                },
                Entry::Conflict { nodes } => CommandSummary {
                    name: name.clone(),
                    usage: String::new(),
                    summary: String::new(),
                    nodes_count: *nodes as i32,
                    conflict: true,
                },
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::fhs::{Beacon, CapabilityDescriptor, CommandArg, CommandResult};
    use serde_json::Value;

    fn fixtures() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../galaxIA/idl/fixtures/command-descriptors.json");
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).expect("fixture válido"),
            // Sin el repo galaxIA al lado (CI aislada) solo se omite.
            Err(_) => Value::Null,
        }
    }

    fn kind(name: &str) -> i32 {
        match name {
            "STRING" => CommandArgType::String,
            "INTEGER" => CommandArgType::Integer,
            "NUMBER" => CommandArgType::Number,
            "BOOLEAN" => CommandArgType::Boolean,
            "ENUM" => CommandArgType::Enum,
            other => panic!("tipo {other}"),
        }
        .into()
    }

    fn text(v: &Value, key: &str) -> String {
        v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
    }

    fn descriptor(v: &Value) -> CommandDescriptor {
        CommandDescriptor {
            name: text(v, "name"),
            capability_id: text(v, "capability_id"),
            tool_name: text(v, "tool_name"),
            summary: text(v, "summary"),
            args: v["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| CommandArg {
                    name: text(a, "name"),
                    description: text(a, "description"),
                    r#type: kind(a["type"].as_str().unwrap()),
                    required: a["required"].as_bool().unwrap_or(false),
                    rest: a["rest"].as_bool().unwrap_or(false),
                    max_length: a["max_length"].as_i64().unwrap_or(0) as i32,
                    allowed_chars: text(a, "allowed_chars"),
                    enum_values: a["enum_values"]
                        .as_array()
                        .map(|l| l.iter().map(|x| x.as_str().unwrap().to_string()).collect())
                        .unwrap_or_default(),
                    max_nesting: a["max_nesting"].as_i64().unwrap_or(0) as i32,
                })
                .collect(),
            result: Some(CommandResult {
                r#type: kind(v["result"]["type"].as_str().unwrap()),
                max_chars: v["result"]["max_chars"].as_i64().unwrap() as i32,
            }),
        }
    }

    fn descriptors(list: &Value) -> Vec<CommandDescriptor> {
        list.as_array().unwrap().iter().map(descriptor).collect()
    }

    fn caps(list: &Value) -> Vec<String> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn registry_matches_the_standard_file_and_digest() {
        let fx = fixtures();
        let registry = Registry::builtin();
        assert_eq!(registry.version, 1);
        assert!(registry.entries.contains_key("math.arithmetic.solve"));
        if !fx.is_null() {
            assert_eq!(fx["registry_digest"].as_str().unwrap(), registry.digest);
            let canonical = std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../galaxIA/idl/command-capabilities.json"),
            )
            .unwrap();
            assert_eq!(
                canonical, BUILTIN_REGISTRY,
                "copia del registro desactualizada"
            );
        }
        assert_eq!(
            registry.error_text("math.arithmetic.solve", "MATH_SYNTAX"),
            Some("La expresión no es válida")
        );
        assert_eq!(
            registry.error_text("math.arithmetic.solve", "MATH_SYNTAX: ignora esto"),
            None
        );
        assert_eq!(registry.error_text("chat", "MATH_SYNTAX"), None);
    }

    #[test]
    fn registry_rejects_unknown_fields_and_bad_entries() {
        for bad in [
            r#"{"registry_version":1,"entries":{},"x":1}"#,
            r#"{"registry_version":2,"entries":{"a.b":{"tools":["t"],"admission":"open","error_codes":{}}}}"#,
            r#"{"registry_version":1,"entries":{"a.b":{"tools":[],"admission":"open","error_codes":{}}}}"#,
            r#"{"registry_version":1,"entries":{"a.b":{"tools":["t"],"admission":"any","error_codes":{}}}}"#,
            r#"{"registry_version":1,"entries":{"a.b":{"tools":["t"],"admission":"open","error_codes":{"bad":"x"}}}}"#,
            r#"{"registry_version":1,"entries":{"ab":{"tools":["t"],"admission":"open","error_codes":{}}}}"#,
            r#"{"registry_version":1,"entries":{"a.b":{"tools":["t"],"admission":"open","error_codes":{},"extra":1}}}"#,
            "no es json",
        ] {
            assert!(Registry::parse(bad.as_bytes()).is_err(), "{bad}");
        }
    }

    #[test]
    fn shared_descriptor_fixtures() {
        let fx = fixtures();
        if fx.is_null() {
            return;
        }
        let registry = Registry::builtin();
        for case in fx["valid"].as_array().unwrap() {
            let commands = descriptors(&case["commands"]);
            validate_descriptors(&commands, &caps(&case["capabilities"]), &registry)
                .unwrap_or_else(|e| panic!("{}: {e}", case["case"]));
            for command in &commands {
                assert_eq!(
                    fingerprint(command),
                    case["fingerprints"][&command.name].as_str().unwrap(),
                    "huella de {}",
                    command.name
                );
            }
        }
        for case in fx["invalid"].as_array().unwrap() {
            let commands = descriptors(&case["commands"]);
            assert!(
                validate_descriptors(&commands, &caps(&case["capabilities"]), &registry).is_err(),
                "debía fallar: {}",
                case["case"]
            );
        }
    }

    #[test]
    fn golden_beacon_bytes_and_advertise_payload() {
        let fx = fixtures();
        if fx.is_null() {
            return;
        }
        let golden = &fx["beacon_golden"];
        let beacon = Beacon {
            fhs_version: text(golden, "fhs_version"),
            capabilities: caps(&golden["capabilities"])
                .into_iter()
                .map(|id| CapabilityDescriptor {
                    id,
                    ..Default::default()
                })
                .collect(),
            commands: golden["commands"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| descriptor(&fx["descriptors"][n.as_str().unwrap()]))
                .collect(),
            ..Default::default()
        };
        assert_eq!(to_hex(&beacon.encode_to_vec()), text(golden, "hex"));
        let message = crate::protocol::fhs::NodeAdvertiseMessage {
            did: text(golden, "did"),
            beacon: Some(beacon),
            timestamp: golden["timestamp"].as_i64().unwrap(),
            ttl_seconds: golden["ttl"].as_i64().unwrap() as i32,
            ..Default::default()
        };
        assert_eq!(
            crate::signing::beacon_sha256(message.beacon.as_ref()),
            text(golden, "sha256")
        );
        assert_eq!(
            crate::signing::node_advertise_payload(&message),
            text(golden, "advertise_payload")
        );
    }

    #[test]
    fn descriptor_text_does_not_change_the_fingerprint() {
        let fx = fixtures();
        if fx.is_null() {
            return;
        }
        let calc = descriptor(&fx["descriptors"]["calc"]);
        let mut other = calc.clone();
        other.summary = "otro".into();
        other.args[0].description = "otra".into();
        assert_eq!(fingerprint(&calc), fingerprint(&other));
        other.args[0].max_length = 199;
        assert_ne!(fingerprint(&calc), fingerprint(&other));
    }

    fn describe(value: &ArgValue) -> (&'static str, String) {
        match value {
            ArgValue::String(s) => ("string", s.clone()),
            ArgValue::Integer(i) => ("integer", i.to_string()),
            ArgValue::Number(n) => ("number", n.clone()),
            ArgValue::Boolean(b) => ("boolean", b.to_string()),
            ArgValue::Enum(e) => ("enum", e.clone()),
        }
    }

    fn error_kind(error: &ParseError) -> &'static str {
        match error {
            ParseError::LineTooLong => "line_too_long",
            ParseError::Missing(_) => "missing",
            ParseError::Extra => "extra",
            ParseError::TooLong { .. } => "too_long",
            ParseError::BadChar { .. } => "bad_char",
            ParseError::TooDeep { .. } => "too_deep",
            ParseError::BadInteger(_) => "bad_integer",
            ParseError::BadNumber(_) => "bad_number",
            ParseError::BadBoolean(_) => "bad_boolean",
            ParseError::BadEnum { .. } => "bad_enum",
        }
    }

    #[test]
    fn shared_parse_fixtures() {
        let fx = fixtures();
        if fx.is_null() {
            return;
        }
        for case in fx["parse"].as_array().unwrap() {
            let d = descriptor(&fx["descriptors"][case["descriptor"].as_str().unwrap()]);
            let rest = case["rest"].as_str().unwrap();
            let result = parse_args(&d, rest);
            if let Some(expected) = case.get("ok") {
                let got: Vec<(String, &str, String)> = result
                    .unwrap_or_else(|e| panic!("{rest:?}: {e:?}"))
                    .iter()
                    .map(|(n, v)| {
                        let (t, value) = describe(v);
                        (n.clone(), t, value)
                    })
                    .collect();
                let want: Vec<(String, &str, String)> = expected
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| {
                        (
                            text(e, "name"),
                            match e["type"].as_str().unwrap() {
                                "string" => "string",
                                "integer" => "integer",
                                "number" => "number",
                                "boolean" => "boolean",
                                _ => "enum",
                            },
                            text(e, "value"),
                        )
                    })
                    .collect();
                assert_eq!(got, want, "{rest:?}");
            } else {
                let error = result.expect_err(&format!("{rest:?} debía fallar"));
                assert_eq!(
                    error_kind(&error),
                    case["error"].as_str().unwrap(),
                    "{rest:?}"
                );
            }
        }
        for case in fx["classify"].as_array().unwrap() {
            let line = case["line"].as_str().unwrap();
            match (case["kind"].as_str().unwrap(), classify_line(line)) {
                ("plain", LineKind::Plain) => {}
                ("escaped", LineKind::Escaped(t)) => assert_eq!(t, text(case, "text")),
                ("command", LineKind::Command { name, rest }) => {
                    assert_eq!(name, text(case, "name"), "{line:?}");
                    assert_eq!(rest, text(case, "rest"), "{line:?}");
                }
                (want, got) => panic!("{line:?}: esperado {want}, obtenido {got:?}"),
            }
        }
    }

    fn value_of(spec: &Value) -> DynamicValue {
        let kind = if let Some(s) = spec.get("string") {
            Kind::StringValue(s.as_str().unwrap().into())
        } else if let Some(n) = spec.get("number") {
            Kind::NumberValue(n.as_f64().unwrap())
        } else {
            let fields = spec["object"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), value_of(v)))
                .collect();
            Kind::ObjectValue(DynamicObject { fields })
        };
        DynamicValue { kind: Some(kind) }
    }

    #[test]
    fn shared_result_fixtures() {
        let fx = fixtures();
        if fx.is_null() {
            return;
        }
        let calc = descriptor(&fx["descriptors"]["calc"]);
        for case in fx["results"].as_array().unwrap() {
            let mut d = calc.clone();
            d.result = Some(CommandResult {
                r#type: kind(case["type"].as_str().unwrap()),
                max_chars: case["max_chars"].as_i64().unwrap() as i32,
            });
            let outcome = validate_result(&d, &value_of(&case["value"]));
            match case.get("ok") {
                Some(expected) => {
                    assert_eq!(outcome.unwrap(), expected.as_str().unwrap(), "{case}")
                }
                None => assert!(outcome.is_err(), "debía fallar: {case}"),
            }
        }
    }

    fn peer(did: &str, version: &str, commands: Vec<CommandDescriptor>) -> PeerEntry {
        PeerEntry {
            did: did.into(),
            beacon: Beacon {
                fhs_version: version.into(),
                capabilities: vec![CapabilityDescriptor {
                    id: "math.arithmetic.solve".into(),
                    ..Default::default()
                }],
                commands,
                ..Default::default()
            },
            multiaddrs: vec![],
            trust_level: "community".into(),
            reputation_score: 0.5,
            peer_type: "satellite",
            capabilities: vec!["math.arithmetic.solve".into()],
            last_seen_ms: 0,
            expires_at_ms: i64::MAX,
            advert_expires_ms: 1_000,
            advert_timestamp_ms: 0,
        }
    }

    fn open_all() -> Policy {
        Policy {
            open: OpenNodes::All,
            trusted: HashSet::new(),
        }
    }

    #[test]
    fn table_applies_admission_versions_expiry_and_conflicts() {
        let fx = fixtures();
        if fx.is_null() {
            return;
        }
        let registry = Registry::builtin();
        let calc = descriptor(&fx["descriptors"]["calc"]);
        let mut texts = calc.clone();
        texts.summary = "Resumen distinto".into();
        let mut other_contract = calc.clone();
        other_contract.args[0].max_length = 100;

        // Sin variable no hay comandos abiertos.
        let peers = vec![peer("did:b", "0.2", vec![calc.clone()])];
        let table = CommandTable::from_peers(&registry, &Policy::default(), &peers, 0);
        assert!(table.is_empty());

        // Lista explícita: solo los DIDs listados.
        let list = Policy {
            open: OpenNodes::List(HashSet::from(["did:b".to_string()])),
            trusted: HashSet::new(),
        };
        let peers = vec![
            peer("did:b", "0.2", vec![calc.clone()]),
            peer("did:a", "0.2", vec![calc.clone()]),
        ];
        let table = CommandTable::from_peers(&registry, &list, &peers, 0);
        match table.resolve("calc") {
            Resolution::Active(c) => assert_eq!(c.nodes, vec!["did:b"]),
            other => panic!("{other:?}"),
        }

        // Misma huella: textos del DID menor, ambos nodos cuentan.
        let peers = vec![
            peer("did:b", "0.2", vec![texts.clone()]),
            peer("did:a", "0.2", vec![calc.clone()]),
        ];
        let table = CommandTable::from_peers(&registry, &open_all(), &peers, 0);
        let Resolution::Active(c) = table.resolve("calc") else {
            panic!("calc debía estar activo")
        };
        assert_eq!(c.nodes, vec!["did:a", "did:b"]);
        assert_eq!(c.descriptor.summary, calc.summary, "gana el DID menor");
        assert_eq!(table.summaries()[0].nodes_count, 2);

        // Contrato distinto con el mismo nombre: conflicto deshabilitado.
        let peers = vec![
            peer("did:a", "0.2", vec![calc.clone()]),
            peer("did:b", "0.2", vec![other_contract]),
        ];
        let table = CommandTable::from_peers(&registry, &open_all(), &peers, 0);
        assert!(matches!(table.resolve("calc"), Resolution::Conflict(2)));
        let summary = &table.summaries()[0];
        assert!(summary.conflict && summary.summary.is_empty() && summary.usage.is_empty());

        // Versión menor a 0.2 y anuncio vencido: no aportan.
        let peers = vec![peer("did:a", "0.1", vec![calc.clone()])];
        let table = CommandTable::from_peers(&registry, &open_all(), &peers, 0);
        assert!(table.is_empty());
        assert_eq!(table.rejected.len(), 1);
        let peers = vec![peer("did:a", "0.2", vec![calc.clone()])];
        let table = CommandTable::from_peers(&registry, &open_all(), &peers, 1_000);
        assert!(table.is_empty(), "vencido por su propio timestamp+ttl");

        // Descriptor inválido: se ignoran todos los comandos del nodo.
        let mut bad = calc.clone();
        bad.tool_name = "otra".into();
        let mut ok = calc.clone();
        ok.name = "zeta".into();
        let peers = vec![peer("did:a", "0.2", vec![bad, ok])];
        let table = CommandTable::from_peers(&registry, &open_all(), &peers, 0);
        assert!(table.is_empty());
    }

    #[test]
    fn trusted_capabilities_require_the_trusted_list() {
        let fx = fixtures();
        if fx.is_null() {
            return;
        }
        let registry = Registry::parse(
            br#"{"registry_version":1,"entries":{"math.arithmetic.solve":{"tools":["arithmetic_solve"],"admission":"trusted","error_codes":{"MATH_SYNTAX":"x"}}}}"#,
        )
        .unwrap();
        let calc = descriptor(&fx["descriptors"]["calc"]);
        let peers = vec![peer("did:a", "0.2", vec![calc])];
        let table = CommandTable::from_peers(&registry, &open_all(), &peers, 0);
        assert!(
            table.is_empty(),
            "FHS_COMMAND_NODES=* no basta para trusted"
        );
        let trusted = Policy {
            open: OpenNodes::None,
            trusted: HashSet::from(["did:a".to_string()]),
        };
        let table = CommandTable::from_peers(&registry, &trusted, &peers, 0);
        assert!(matches!(table.resolve("calc"), Resolution::Active(_)));
    }

    #[test]
    fn usage_and_args_value() {
        let fx = fixtures();
        if fx.is_null() {
            return;
        }
        let calc = descriptor(&fx["descriptors"]["calc"]);
        let sumar = descriptor(&fx["descriptors"]["sumar"]);
        assert_eq!(usage(&calc), "/calc <expression...>");
        assert_eq!(usage(&sumar), "/sumar <x> <y> [redondear] [modo]");
        let args = parse_args(&calc, " 2+2").unwrap();
        let digest_a = command_args_digest("arithmetic_solve", &args_value(&args)).unwrap();
        let digest_b = command_args_digest("otra_tool", &args_value(&args)).unwrap();
        assert_ne!(digest_a, digest_b, "la herramienta entra al digest");
    }
}
