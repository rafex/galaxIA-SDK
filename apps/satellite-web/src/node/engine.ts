/**
 * Motor de aritmética con los límites del contrato (SPEC DEC-0097): entrada
 * acotada y mapeo a códigos `MATH_*`. El cálculo real lo hace el WASM en un
 * Web Worker que se termina si tarda más de `TIMEOUT_MS`.
 */

export const CAPABILITY = "math.arithmetic.solve";
export const TOOL = "arithmetic_solve";
export const MAX_EXPRESSION_CHARS = 200;
export const MAX_DEPTH = 32;
export const MAX_RESULT_CHARS = 64;
export const TIMEOUT_MS = 2_000;

export type MathCode =
  | "MATH_DIVISION_BY_ZERO"
  | "MATH_NOT_FINITE"
  | "MATH_SYNTAX"
  | "MATH_TIMEOUT"
  | "MATH_LIMIT";

export type EngineOutcome = { ok: true; result: string } | { ok: false; code: MathCode };

export type SolveFn = (expression: string) => Promise<string>;

/** Valida la entrada antes de tocar el motor. */
export function checkInput(expression: string): MathCode | undefined {
  if (expression.length === 0) return "MATH_SYNTAX";
  if (expression.length > MAX_EXPRESSION_CHARS) return "MATH_LIMIT";
  if (!/^[0-9+\-*/^().\s]+$/.test(expression)) return "MATH_SYNTAX";
  let depth = 0;
  let max = 0;
  for (const ch of expression) {
    if (ch === "(") max = Math.max(max, ++depth);
    else if (ch === ")") depth = Math.max(0, depth - 1);
  }
  return max > MAX_DEPTH ? "MATH_LIMIT" : undefined;
}

/** Traduce la respuesta cruda del WASM (`OK:<n>` | `ERR:<mensaje>`). */
export function mapRaw(raw: string): EngineOutcome {
  if (raw.startsWith("OK:")) {
    const result = raw.slice(3);
    if (result.length > MAX_RESULT_CHARS) return { ok: false, code: "MATH_LIMIT" };
    if (!/^-?[0-9]+(\.[0-9]+)?$/.test(result)) return { ok: false, code: "MATH_NOT_FINITE" };
    return { ok: true, result };
  }
  const message = raw.startsWith("ERR:") ? raw.slice(4) : raw;
  if (/divisi[oó]n por cero/i.test(message)) return { ok: false, code: "MATH_DIVISION_BY_ZERO" };
  if (/no es un n[uú]mero finito/i.test(message)) return { ok: false, code: "MATH_NOT_FINITE" };
  return { ok: false, code: "MATH_SYNTAX" };
}

export async function solve(
  expression: string,
  run: SolveFn,
  timeoutMs = TIMEOUT_MS,
): Promise<EngineOutcome> {
  const rejected = checkInput(expression);
  if (rejected) return { ok: false, code: rejected };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      run(expression),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (raw === "timeout") return { ok: false, code: "MATH_TIMEOUT" };
    return mapRaw(raw);
  } catch {
    return { ok: false, code: "MATH_SYNTAX" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `SolveFn` sobre un Web Worker: si se agota el tiempo, `terminateOnTimeout`
 * lo termina y se recrea en la siguiente llamada.
 */
export function workerSolver(createWorker: () => Worker): { run: SolveFn; reset: () => void } {
  let worker: Worker | undefined;
  let nextId = 0;
  const reset = () => {
    worker?.terminate();
    worker = undefined;
  };
  const run: SolveFn = (expression) =>
    new Promise((resolve, reject) => {
      worker ??= createWorker();
      const current = worker;
      const id = nextId++;
      const onMessage = (event: MessageEvent<{ id: number; result: string }>) => {
        if (event.data.id !== id) return;
        current.removeEventListener("message", onMessage);
        resolve(event.data.result);
      };
      current.addEventListener("message", onMessage);
      current.addEventListener("error", () => reject(new Error("worker")), { once: true });
      current.postMessage({ type: "solve", expr: expression, id });
    });
  return { run, reset };
}
