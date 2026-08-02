/**
 * Evaluador de expresiones aritméticas — capacidad `math.arithmetic.solve`
 * pensada para un Ephemeral Satellite (nodo WASM en navegador, ver
 * spec-native/DECISIONS.md). Deliberadamente NO usa `eval`/`Function()`:
 * la entrada eventualmente vendrá de una Mission de un invocador no
 * confiable, así que se parsea con un tokenizer + recursive-descent
 * parser propio.
 *
 * Gramática soportada: + - * / ^ ( ), decimales, menos unario.
 * Precedencia: ^ (asociativo a la derecha) > unario - > * / > + -.
 */

type TokenType = "number" | "plus" | "minus" | "star" | "slash" | "caret" | "lparen" | "rparen";

interface Token {
  type: TokenType;
  value?: number;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      let j = i;
      let sawDot = false;
      while (j < expr.length && ((expr[j] >= "0" && expr[j] <= "9") || (expr[j] === "." && !sawDot))) {
        if (expr[j] === ".") sawDot = true;
        j++;
      }
      const raw = expr.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`Número inválido: "${raw}"`);
      }
      tokens.push({ type: "number", value });
      i = j;
      continue;
    }

    const single: Partial<Record<string, TokenType>> = {
      "+": "plus",
      "-": "minus",
      "*": "star",
      "/": "slash",
      "^": "caret",
      "(": "lparen",
      ")": "rparen",
    };
    const type = single[ch];
    if (!type) {
      throw new Error(`Carácter inesperado: "${ch}" en posición ${i}`);
    }
    tokens.push({ type });
    i++;
  }

  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(type: TokenType): Token {
    const token = this.tokens[this.pos];
    if (!token || token.type !== type) {
      throw new Error(`Se esperaba "${type}" pero se encontró ${token ? `"${token.type}"` : "el final de la expresión"}`);
    }
    this.pos++;
    return token;
  }

  parse(): number {
    if (this.tokens.length === 0) {
      throw new Error("Expresión vacía");
    }
    const value = this.parseExpression();
    if (this.pos < this.tokens.length) {
      throw new Error(`Token inesperado al final: "${this.tokens[this.pos].type}"`);
    }
    return value;
  }

  // expression := term (('+' | '-') term)*
  private parseExpression(): number {
    let value = this.parseTerm();
    while (this.peek()?.type === "plus" || this.peek()?.type === "minus") {
      const op = this.consume(this.peek()!.type);
      const rhs = this.parseTerm();
      value = op.type === "plus" ? value + rhs : value - rhs;
    }
    return value;
  }

  // term := unary (('*' | '/') unary)*
  private parseTerm(): number {
    let value = this.parseUnary();
    while (this.peek()?.type === "star" || this.peek()?.type === "slash") {
      const op = this.consume(this.peek()!.type);
      const rhs = this.parseUnary();
      if (op.type === "slash") {
        if (rhs === 0) throw new Error("División por cero");
        value = value / rhs;
      } else {
        value = value * rhs;
      }
    }
    return value;
  }

  // unary := '-' unary | power
  private parseUnary(): number {
    if (this.peek()?.type === "minus") {
      this.consume("minus");
      return -this.parseUnary();
    }
    return this.parsePower();
  }

  // power := atom ('^' unary)?  — asociativo a la derecha
  private parsePower(): number {
    const base = this.parseAtom();
    if (this.peek()?.type === "caret") {
      this.consume("caret");
      const exponent = this.parseUnary();
      return Math.pow(base, exponent);
    }
    return base;
  }

  // atom := number | '(' expression ')'
  private parseAtom(): number {
    const token = this.peek();
    if (!token) {
      throw new Error("Se esperaba un número o '(' pero la expresión terminó");
    }
    if (token.type === "number") {
      this.consume("number");
      return token.value!;
    }
    if (token.type === "lparen") {
      this.consume("lparen");
      const value = this.parseExpression();
      this.consume("rparen");
      return value;
    }
    throw new Error(`Se esperaba un número o '(' pero se encontró "${token.type}"`);
  }
}

/**
 * Evalúa una expresión aritmética con + - * / ^ y paréntesis.
 * @throws Error con mensaje claro en sintaxis inválida o división por cero.
 */
export function solveExpression(expr: string): number {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  const result = parser.parse();
  if (!Number.isFinite(result)) {
    throw new Error("El resultado no es un número finito (overflow o operación inválida)");
  }
  return result;
}
