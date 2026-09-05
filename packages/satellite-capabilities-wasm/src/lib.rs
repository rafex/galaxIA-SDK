use wasm_bindgen::prelude::*;

const VOWELS: &[char] = &['A', 'E', 'I', 'O', 'U'];
const CONNECTORS: &[&str] = &["DE", "DEL", "LA", "LAS", "LOS", "Y", "MC", "VAN", "VON"];
const INCONVENIENT: &[&str] = &[
    "BACA", "BAKA", "BUEI", "BUEY", "CACA", "CACO", "CAGA", "CAGO", "CAKA", "CAKO", "COGE", "COGI",
    "COJA", "COJE", "COJI", "COJO", "COLA", "CULO", "FALO", "FETO", "GETA", "GUEI", "GUEY", "JETA",
    "JOTO", "KACA", "KACO", "KAGA", "KAGO", "KAKA", "KAKO", "KOGE", "KOGI", "KOJA", "KOJE", "KOJI",
    "KOJO", "KOLA", "KULO", "LILO", "LOCA", "LOCO", "LOKA", "LOKO", "MAME", "MAMO", "MEAR", "MEAS",
    "MEON", "MIAR", "MION", "MOCO", "MOKO", "MULA", "MULO", "NACA", "NACO", "PEDA", "PEDO", "PENE",
    "PIPI", "PITO", "POPO", "PUTA", "PUTO", "QULO", "RATA", "ROBA", "ROBE", "ROBO", "RUIN", "SENO",
    "TETA", "VACA", "VAGA", "VAGO", "VAKA", "VUEI", "VUEY", "WUEI", "WUEY",
];

fn strip_diacritics(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            'Á' | 'á' => 'A',
            'É' | 'é' => 'E',
            'Í' | 'í' => 'I',
            'Ó' | 'ó' => 'O',
            'Ú' | 'ú' => 'U',
            'Ü' | 'ü' => 'U',
            other => other.to_ascii_uppercase(),
        })
        .collect()
}

fn normalize_name_part(value: &str) -> String {
    strip_diacritics(value.trim())
        .chars()
        .map(|ch| if ch == 'Ñ' { 'X' } else { ch })
        .filter(|ch| ch.is_ascii_uppercase() || *ch == ' ')
        .collect()
}

fn significant_word(value: &str) -> String {
    let words: Vec<&str> = value.split_whitespace().collect();
    words
        .iter()
        .find(|word| !CONNECTORS.contains(word))
        .copied()
        .or_else(|| words.first().copied())
        .unwrap_or("")
        .to_string()
}

fn first_internal_vowel(word: &str) -> char {
    word.chars()
        .skip(1)
        .find(|ch| VOWELS.contains(ch))
        .unwrap_or('X')
}

fn first_internal_consonant(word: &str) -> char {
    word.chars()
        .skip(1)
        .find(|ch| !VOWELS.contains(ch))
        .unwrap_or('X')
}

fn entidad_code(value: &str) -> Option<&'static str> {
    let normalized = strip_diacritics(value.trim());
    const ENTRIES: &[(&str, &str)] = &[
        ("AGUASCALIENTES", "AS"),
        ("BAJA CALIFORNIA", "BC"),
        ("BAJA CALIFORNIA SUR", "BS"),
        ("CAMPECHE", "CC"),
        ("COAHUILA", "CL"),
        ("COLIMA", "CM"),
        ("CHIAPAS", "CS"),
        ("CHIHUAHUA", "CH"),
        ("CIUDAD DE MEXICO", "DF"),
        ("DISTRITO FEDERAL", "DF"),
        ("DURANGO", "DG"),
        ("GUANAJUATO", "GT"),
        ("GUERRERO", "GR"),
        ("HIDALGO", "HG"),
        ("JALISCO", "JC"),
        ("MEXICO", "MC"),
        ("ESTADO DE MEXICO", "MC"),
        ("MICHOACAN", "MN"),
        ("MORELOS", "MS"),
        ("NAYARIT", "NT"),
        ("NUEVO LEON", "NL"),
        ("OAXACA", "OC"),
        ("PUEBLA", "PL"),
        ("QUERETARO", "QT"),
        ("QUINTANA ROO", "QR"),
        ("SAN LUIS POTOSI", "SP"),
        ("SINALOA", "SL"),
        ("SONORA", "SR"),
        ("TABASCO", "TC"),
        ("TAMAULIPAS", "TS"),
        ("TLAXCALA", "TL"),
        ("VERACRUZ", "VZ"),
        ("YUCATAN", "YN"),
        ("ZACATECAS", "ZS"),
        ("NACIDO EN EL EXTRANJERO", "NE"),
    ];
    if normalized.len() == 2 {
        if let Some((_, code)) = ENTRIES
            .iter()
            .find(|(_, code)| *code == normalized.as_str())
        {
            return Some(*code);
        }
    }
    ENTRIES
        .iter()
        .find(|(name, _)| *name == normalized)
        .map(|(_, code)| *code)
}

fn is_real_date(year: i32, month: i32, day: i32) -> bool {
    if year < 1 || !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    day <= days[(month - 1) as usize]
}

fn checksum_value(ch: char) -> Option<i32> {
    match ch {
        '0'..='9' => Some(ch as i32 - '0' as i32),
        'A'..='N' => Some(10 + ch as i32 - 'A' as i32),
        '&' => Some(24),
        'O'..='Z' => Some(25 + ch as i32 - 'O' as i32),
        _ => None,
    }
}

fn check_digit(curp17: &str) -> Option<char> {
    if curp17.chars().count() != 17 {
        return None;
    }
    let mut sum = 0;
    for (index, ch) in curp17.chars().enumerate() {
        sum += checksum_value(ch)? * (18 - index as i32);
    }
    char::from_digit(((10 - sum % 10) % 10) as u32, 10)
}

fn valid_differentiator(value: &str, year: i32) -> bool {
    let mut chars = value.chars();
    let Some(ch) = chars.next() else {
        return false;
    };
    chars.next().is_none()
        && if year < 2000 {
            ch.is_ascii_digit()
        } else {
            ('A'..='J').contains(&ch)
        }
}

fn compute_curp(fields: &[&str]) -> String {
    if fields.len() < 8 {
        return "ERR:Formato inválido — se esperaban 8 campos separados por |".into();
    }
    let nombre = significant_word(&normalize_name_part(fields[0]));
    let paterno = significant_word(&normalize_name_part(fields[1]));
    let materno = if fields[2].trim().is_empty() {
        String::new()
    } else {
        significant_word(&normalize_name_part(fields[2]))
    };
    let Ok(year) = fields[3].parse::<i32>() else {
        return "ERR:year/month/day deben ser enteros".into();
    };
    let Ok(month) = fields[4].parse::<i32>() else {
        return "ERR:year/month/day deben ser enteros".into();
    };
    let Ok(day) = fields[5].parse::<i32>() else {
        return "ERR:year/month/day deben ser enteros".into();
    };
    let sexo = fields[6].trim();
    if paterno.is_empty() {
        return "ERR:apellidoPaterno es requerido".into();
    }
    if nombre.is_empty() {
        return "ERR:nombre es requerido".into();
    }
    if !is_real_date(year, month, day) {
        return "ERR:fechaNacimiento no es una fecha válida".into();
    }
    if sexo != "H" && sexo != "M" {
        return "ERR:sexo debe ser \"H\" o \"M\"".into();
    }
    let Some(entity) = entidad_code(fields[7]) else {
        return format!("ERR:Entidad federativa no reconocida: {}", fields[7]);
    };
    let differentiator = if fields.get(8).unwrap_or(&"").trim().is_empty() {
        if year < 2000 {
            "0"
        } else {
            "A"
        }
    } else {
        fields[8].trim()
    };
    if !valid_differentiator(differentiator, year) {
        return "ERR:diferenciador inválido para el siglo de nacimiento".into();
    }

    let materno_initial = materno.chars().next().unwrap_or('X');
    let mut first_four = format!(
        "{}{}{}{}",
        paterno.chars().next().unwrap(),
        first_internal_vowel(&paterno),
        materno_initial,
        nombre.chars().next().unwrap()
    );
    let mut warnings: Vec<String> = Vec::new();
    if INCONVENIENT.contains(&first_four.as_str()) {
        let chars: Vec<char> = first_four.chars().collect();
        first_four = format!("{}X{}{}", chars[0], chars[2], chars[3]);
        warnings.push("La combinación inicial es una palabra inconveniente; la posición 2 se sustituyó por X.".into());
    }
    if materno.is_empty() {
        warnings.push("apellidoMaterno ausente: se usó \"X\" en las posiciones 3 y 15.".into());
    }
    if fields.get(8).unwrap_or(&"").trim().is_empty() {
        warnings.push(format!("La posición 17 se asumió como \"{}\"; la asignación de homonimia corresponde a RENAPO.", differentiator));
    }
    let curp17 = format!(
        "{}{:02}{:02}{:02}{}{}{}{}{}{}",
        first_four,
        year % 100,
        month,
        day,
        sexo,
        entity,
        first_internal_consonant(&paterno),
        if materno.is_empty() {
            'X'
        } else {
            first_internal_consonant(&materno)
        },
        first_internal_consonant(&nombre),
        differentiator
    );
    let Some(digit) = check_digit(&curp17) else {
        return "ERR:no se pudo calcular el dígito verificador".into();
    };
    format!("OK:{}{}|{}", curp17, digit, warnings.join("|"))
}

fn valid_shape(curp: &str) -> bool {
    let chars: Vec<char> = curp.chars().collect();
    if chars.len() != 18 {
        return false;
    }
    chars.iter().enumerate().all(|(i, ch)| match i {
        4..=9 | 17 => ch.is_ascii_digit(),
        10 => *ch == 'H' || *ch == 'M',
        16 => ch.is_ascii_digit() || ('A'..='J').contains(ch),
        _ => ch.is_ascii_uppercase(),
    })
}

#[wasm_bindgen]
pub fn compute_curp_encoded(encoded: &str) -> String {
    compute_curp(&encoded.split('|').collect::<Vec<_>>())
}

#[wasm_bindgen]
pub fn validate_curp_encoded(value: &str) -> String {
    let curp = value.trim().to_ascii_uppercase();
    if !valid_shape(&curp) {
        return "ERR:La CURP debe tener 18 caracteres con formato válido".into();
    }
    let chars: Vec<char> = curp.chars().collect();
    let yy: i32 = curp[4..6].parse().unwrap_or(-1);
    let year = if chars[16].is_ascii_digit() {
        1900 + yy
    } else {
        2000 + yy
    };
    let month: i32 = curp[6..8].parse().unwrap_or(-1);
    let day: i32 = curp[8..10].parse().unwrap_or(-1);
    if !is_real_date(year, month, day) {
        return "ERR:La fecha codificada no es válida".into();
    }
    if entidad_code(&curp[11..13]).is_none() {
        return "ERR:La entidad federativa codificada no pertenece al catálogo".into();
    }
    if check_digit(&curp[..17]) != chars.get(17).copied() {
        return "ERR:El dígito verificador no coincide".into();
    }
    format!("OK:{}|Validación estructural local correcta; no confirma existencia ni vigencia en RENAPO.", curp)
}

#[derive(Clone, Copy, PartialEq)]
enum Token {
    Num(f64),
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    LParen,
    RParen,
}

fn tokenize(expr: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = expr.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        let token = match ch {
            '+' => Some(Token::Plus),
            '-' => Some(Token::Minus),
            '*' => Some(Token::Star),
            '/' => Some(Token::Slash),
            '^' => Some(Token::Caret),
            '(' => Some(Token::LParen),
            ')' => Some(Token::RParen),
            _ => None,
        };
        if let Some(token) = token {
            tokens.push(token);
            i += 1;
            continue;
        }
        if ch.is_ascii_digit() || ch == '.' {
            let start = i;
            let mut dots = 0;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                if chars[i] == '.' {
                    dots += 1;
                }
                i += 1;
            }
            if dots > 1 {
                return Err(format!(
                    "Número inválido: {}",
                    chars[start..i].iter().collect::<String>()
                ));
            }
            let raw: String = chars[start..i].iter().collect();
            let value = raw
                .parse::<f64>()
                .map_err(|_| format!("Número inválido: {}", raw))?;
            if !value.is_finite() {
                return Err(format!("Número inválido: {}", raw));
            }
            tokens.push(Token::Num(value));
            continue;
        }
        return Err(format!("Carácter inesperado: \"{}\" en posición {}", ch, i));
    }
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}
impl Parser {
    fn parse(&mut self) -> Result<f64, String> {
        if self.tokens.is_empty() {
            return Err("Expresión vacía".into());
        }
        let value = self.expression()?;
        if self.pos < self.tokens.len() {
            return Err("Token inesperado al final de la expresión".into());
        }
        Ok(value)
    }
    fn expression(&mut self) -> Result<f64, String> {
        let mut value = self.term()?;
        while self.pos < self.tokens.len() {
            let op = self.tokens[self.pos];
            if op != Token::Plus && op != Token::Minus {
                break;
            }
            self.pos += 1;
            let rhs = self.term()?;
            value = if op == Token::Plus {
                value + rhs
            } else {
                value - rhs
            };
        }
        Ok(value)
    }
    fn term(&mut self) -> Result<f64, String> {
        let mut value = self.unary()?;
        while self.pos < self.tokens.len() {
            let op = self.tokens[self.pos];
            if op != Token::Star && op != Token::Slash {
                break;
            }
            self.pos += 1;
            let rhs = self.unary()?;
            if op == Token::Slash && rhs == 0.0 {
                return Err("División por cero".into());
            }
            value = if op == Token::Star {
                value * rhs
            } else {
                value / rhs
            };
        }
        Ok(value)
    }
    fn unary(&mut self) -> Result<f64, String> {
        if self.pos < self.tokens.len() && self.tokens[self.pos] == Token::Minus {
            self.pos += 1;
            return Ok(-self.unary()?);
        }
        self.power()
    }
    fn power(&mut self) -> Result<f64, String> {
        let base = self.atom()?;
        if self.pos < self.tokens.len() && self.tokens[self.pos] == Token::Caret {
            self.pos += 1;
            return Ok(base.powf(self.unary()?));
        }
        Ok(base)
    }
    fn atom(&mut self) -> Result<f64, String> {
        let Some(token) = self.tokens.get(self.pos).copied() else {
            return Err("Se esperaba un número o '(' pero la expresión terminó".into());
        };
        match token {
            Token::Num(value) => {
                self.pos += 1;
                Ok(value)
            }
            Token::LParen => {
                self.pos += 1;
                let value = self.expression()?;
                if self.tokens.get(self.pos) != Some(&Token::RParen) {
                    return Err("Token inesperado: se esperaba ')'".into());
                }
                self.pos += 1;
                Ok(value)
            }
            _ => Err("Se esperaba un número o '(' pero se encontró otro token".into()),
        }
    }
}

#[wasm_bindgen]
pub fn solve_expression(expr: &str) -> String {
    match tokenize(expr).and_then(|tokens| {
        let mut parser = Parser { tokens, pos: 0 };
        parser.parse()
    }) {
        Ok(value) if value.is_finite() => format!("OK:{}", value),
        Ok(_) => "ERR:El resultado no es un número finito (overflow o operación inválida)".into(),
        Err(error) => format!("ERR:{}", error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn golden_curp() {
        assert!(
            compute_curp_encoded("Concepción|Salgado|Briseño|1956|6|26|M|Distrito Federal")
                .starts_with("OK:SABC560626MDFLRN01|")
        );
    }
    #[test]
    fn validates_curp() {
        assert!(validate_curp_encoded("BOXW310820HNERXN09").starts_with("OK:"));
    }
    #[test]
    fn arithmetic() {
        assert_eq!(solve_expression("(1 + 2) * 3"), "OK:9");
    }
}
