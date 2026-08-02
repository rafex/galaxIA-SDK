/**
 * Puerto AssemblyScript de ../../satellite-capabilities/src/arithmetic.ts.
 * Mismo evaluador recursive-descent; la única diferencia estructural es que
 * se usa un estado de error de módulo en vez de excepciones JS, porque el
 * manejo de excepciones dentro de WASM requiere la propuesta `exceptionHandling`
 * que no siempre está disponible en el entorno host.
 */

enum TokenKind {
  Num,
  Plus,
  Minus,
  Star,
  Slash,
  Caret,
  LParen,
  RParen,
}

class Token {
  kind: TokenKind;
  value: f64;
  constructor(kind: TokenKind, value: f64 = 0.0) {
    this.kind = kind;
    this.value = value;
  }
}

let _arithError: string = "";

function clearArithError(): void {
  _arithError = "";
}

function hasArithError(): boolean {
  return _arithError.length > 0;
}

function setArithError(msg: string): void {
  _arithError = msg;
}

export function getArithError(): string {
  return _arithError;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i: i32 = 0;
  while (i < expr.length) {
    const ch = expr.charAt(i);
    if (ch == " " || ch == "\t" || ch == "\n") {
      i++;
      continue;
    }
    const code = expr.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      let j = i;
      let sawDot = false;
      while (j < expr.length) {
        const c2 = expr.charCodeAt(j);
        if (c2 >= 48 && c2 <= 57) {
          j++;
        } else if (c2 == 46 && !sawDot) {
          sawDot = true;
          j++;
        } else {
          break;
        }
      }
      const raw = expr.slice(i, j);
      const value = F64.parseFloat(raw);
      if (!isFinite(value)) {
        setArithError('Número inválido: "' + raw + '"');
        return tokens;
      }
      tokens.push(new Token(TokenKind.Num, value));
      i = j;
      continue;
    }
    if (ch == "+") { tokens.push(new Token(TokenKind.Plus)); i++; continue; }
    if (ch == "-") { tokens.push(new Token(TokenKind.Minus)); i++; continue; }
    if (ch == "*") { tokens.push(new Token(TokenKind.Star)); i++; continue; }
    if (ch == "/") { tokens.push(new Token(TokenKind.Slash)); i++; continue; }
    if (ch == "^") { tokens.push(new Token(TokenKind.Caret)); i++; continue; }
    if (ch == "(") { tokens.push(new Token(TokenKind.LParen)); i++; continue; }
    if (ch == ")") { tokens.push(new Token(TokenKind.RParen)); i++; continue; }
    setArithError('Carácter inesperado: "' + ch + '" en posición ' + i.toString());
    return tokens;
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos: i32;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  private hasToken(): boolean {
    return this.pos < this.tokens.length;
  }

  private peekKind(): TokenKind {
    if (this.pos < this.tokens.length) return this.tokens[this.pos].kind;
    return -1 as TokenKind;
  }

  private consume(kind: TokenKind): Token {
    if (!this.hasToken() || this.tokens[this.pos].kind != kind) {
      const found = this.hasToken() ? this.tokens[this.pos].kind.toString() : "fin de expresión";
      setArithError("Token inesperado: esperado " + kind.toString() + " encontrado " + found);
      return new Token(kind);
    }
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  parse(): f64 {
    if (this.tokens.length == 0) {
      setArithError("Expresión vacía");
      return 0.0;
    }
    const value = this.parseExpression();
    if (!hasArithError() && this.pos < this.tokens.length) {
      setArithError("Token inesperado al final de la expresión");
    }
    return value;
  }

  private parseExpression(): f64 {
    let value = this.parseTerm();
    while (!hasArithError() && this.hasToken() && (this.peekKind() == TokenKind.Plus || this.peekKind() == TokenKind.Minus)) {
      const isPlus = this.peekKind() == TokenKind.Plus;
      this.pos++;
      const rhs = this.parseTerm();
      value = isPlus ? value + rhs : value - rhs;
    }
    return value;
  }

  private parseTerm(): f64 {
    let value = this.parseUnary();
    while (!hasArithError() && this.hasToken() && (this.peekKind() == TokenKind.Star || this.peekKind() == TokenKind.Slash)) {
      const isDiv = this.peekKind() == TokenKind.Slash;
      this.pos++;
      const rhs = this.parseUnary();
      if (hasArithError()) return value;
      if (isDiv) {
        if (rhs == 0.0) { setArithError("División por cero"); return 0.0; }
        value = value / rhs;
      } else {
        value = value * rhs;
      }
    }
    return value;
  }

  private parseUnary(): f64 {
    if (!hasArithError() && this.hasToken() && this.peekKind() == TokenKind.Minus) {
      this.pos++;
      return -this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): f64 {
    const base = this.parseAtom();
    if (!hasArithError() && this.hasToken() && this.peekKind() == TokenKind.Caret) {
      this.pos++;
      const exponent = this.parseUnary();
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parseAtom(): f64 {
    if (!this.hasToken()) {
      setArithError("Se esperaba un número o '(' pero la expresión terminó");
      return 0.0;
    }
    const kind = this.peekKind();
    if (kind == TokenKind.Num) {
      const t = this.tokens[this.pos];
      this.pos++;
      return t.value;
    }
    if (kind == TokenKind.LParen) {
      this.pos++;
      const value = this.parseExpression();
      if (!hasArithError()) this.consume(TokenKind.RParen);
      return value;
    }
    setArithError("Se esperaba un número o '(' pero se encontró otro token");
    return 0.0;
  }
}

/**
 * Evalúa una expresión aritmética. Devuelve NaN si hay un error.
 * El mensaje de error está en `getArithError()`.
 */
export function evalExpression(expr: string): f64 {
  clearArithError();
  const tokens = tokenize(expr);
  if (hasArithError()) return NaN;
  const parser = new Parser(tokens);
  const result = parser.parse();
  if (hasArithError()) return NaN;
  if (!isFinite(result)) {
    setArithError("El resultado no es un número finito (overflow o operación inválida)");
    return NaN;
  }
  return result;
}
