/**
 * Ephemeral Satellite — demo de navegador.
 * Las dos capacidades (aritmética y CURP) corren como WASM real
 * dentro de un Web Worker, sin servidor backend.
 */

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

let nextId = 0;
const pending = new Map<number, (result: string) => void>();

worker.addEventListener("message", (event: MessageEvent<{ id: number; result: string }>) => {
  const cb = pending.get(event.data.id);
  if (cb) { pending.delete(event.data.id); cb(event.data.result); }
});

function callWorker(msg: object): Promise<string> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ ...msg, id });
  });
}

function renderResult(el: HTMLElement, raw: string): void {
  if (raw.startsWith("OK:")) {
    el.className = "result ok";
    el.textContent = raw.slice(3);
  } else {
    el.className = "result err";
    el.textContent = raw.startsWith("ERR:") ? raw.slice(4) : raw;
  }
}

// ─── Aritmética ────────────────────────────────────────────────────────────

const mathForm = document.getElementById("math-form") as HTMLFormElement;
const mathInput = document.getElementById("math-expr") as HTMLInputElement;
const mathResult = document.getElementById("math-result") as HTMLElement;

mathForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const expr = mathInput.value.trim();
  if (!expr) return;
  mathResult.className = "result loading";
  mathResult.textContent = "calculando…";
  void callWorker({ type: "solve", expr }).then((raw) => renderResult(mathResult, raw));
});

// ─── CURP ──────────────────────────────────────────────────────────────────

const curpForm = document.getElementById("curp-form") as HTMLFormElement;
const curpResult = document.getElementById("curp-result") as HTMLElement;
const curpFull = document.getElementById("curp-full") as HTMLElement;
const validateForm = document.getElementById("curp-validate-form") as HTMLFormElement;
const validateResult = document.getElementById("curp-validate-result") as HTMLElement;

curpForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const nombre = (document.getElementById("nombre") as HTMLInputElement).value.trim();
  const apPat  = (document.getElementById("ap-pat") as HTMLInputElement).value.trim();
  const apMat  = (document.getElementById("ap-mat") as HTMLInputElement).value.trim();
  const year   = parseInt((document.getElementById("year") as HTMLInputElement).value, 10);
  const month  = parseInt((document.getElementById("month") as HTMLInputElement).value, 10);
  const day    = parseInt((document.getElementById("day") as HTMLInputElement).value, 10);
  const sexo   = (document.getElementById("sexo") as HTMLSelectElement).value;
  const entidad= (document.getElementById("entidad") as HTMLInputElement).value.trim();

  const diferenciador = (document.getElementById("diferenciador") as HTMLInputElement).value.trim().toUpperCase();
  const encoded = [nombre, apPat, apMat, year, month, day, sexo, entidad, diferenciador].join("|");
  curpFull.textContent = "";
  curpResult.className = "result loading";
  curpResult.textContent = "calculando localmente en WASM…";

  void callWorker({ type: "curp-create", encoded }).then((raw) => {
    if (raw.startsWith("OK:")) {
      const [curp, ...warnParts] = raw.slice(3).split("|");
      curpFull.textContent = curp;
      curpResult.className = "result ok";
      curpResult.textContent = warnParts.filter(Boolean).join(" • ") || "CURP candidata calculada localmente.";
    } else {
      curpResult.className = "result err";
      curpResult.textContent = raw.startsWith("ERR:") ? raw.slice(4) : raw;
    }
  });
});

validateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const curp = (document.getElementById("curp-value") as HTMLInputElement).value.trim();
  validateResult.className = "result loading";
  validateResult.textContent = "validando localmente en WASM…";
  void callWorker({ type: "curp-validate", curp }).then((raw) => {
    if (raw.startsWith("OK:")) {
      const [, ...warnings] = raw.slice(3).split("|");
      validateResult.className = "result ok";
      validateResult.textContent = warnings.filter(Boolean).join(" • ") || "CURP estructuralmente válida.";
    } else {
      validateResult.className = "result err";
      validateResult.textContent = raw.startsWith("ERR:") ? raw.slice(4) : raw;
    }
  });
});
