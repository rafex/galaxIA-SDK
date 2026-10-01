/** Panel "Unirme a la red": ciclo de vida del nodo móvil en la página. */
import { loadBootstrap } from "./config.js";
import { workerSolver } from "./engine.js";
import { loadOrCreateIdentity } from "./identity-store.js";
import { didFromRaw } from "./signing.js";
import { startSatelliteNode, type NodeState, type RunningNode } from "./satellite-node.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const toggle = $<HTMLButtonElement>("net-toggle");
const statusEl = $("net-status");
const didEl = $("net-did");
const copyBtn = $<HTMLButtonElement>("net-copy");
const summaryEl = $("net-summary");
const missionsBody = $<HTMLTableElement>("net-missions").tBodies[0];
const resourcesBody = $<HTMLTableElement>("net-resources").tBodies[0];
const logEl = $("net-log");

const solver = workerSolver(() => new Worker(new URL("../worker.ts", import.meta.url), { type: "module" }));

let running: RunningNode | undefined;
let joining = false;
let wakeLock: { release(): Promise<void> } | undefined;

const accepting = () => running !== undefined && document.visibilityState === "visible";

function log(line: string): void {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} · ${line}`;
  logEl.prepend(item);
  while (logEl.children.length > 8) logEl.lastElementChild?.remove();
}

function render(state: NodeState): void {
  didEl.textContent = state.did;
  const parts = [
    state.bootstrapConnected ? "✓ red" : "… conectando a la red",
    state.navigatorConnected ? "✓ Navigator" : "… buscando al Navigator",
  ];
  statusEl.textContent = document.visibilityState === "visible" ? parts.join(" · ") : "en segundo plano: sin anunciarse ni pujar";
  const sum = state.summary;
  summaryEl.textContent =
    `pujas ${sum.bids} · asignadas ${sum.assigned} · terminaron bien ${sum.ok} · con error ${sum.error} · rechazadas ${sum.rejected}` +
    (sum.avgMs !== undefined ? ` · respuesta media ${sum.avgMs} ms (mediana ${sum.p50Ms} · máx ${sum.maxMs})` : "");
  renderMissions(state);
  renderResources(state);
}

const PHASE_LABEL: Record<string, string> = {
  puja: "puja enviada",
  asignada: "asignada",
  ejecutando: "ejecutando…",
  ok: "terminó bien",
  error: "terminó con error",
  rechazada: "rechazada (sin asignación válida)",
};

function cell(text: string, cls?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function renderMissions(state: NodeState): void {
  missionsBody.replaceChildren(
    ...state.missions.map((m) => {
      const tr = document.createElement("tr");
      const stale = m.phase === "puja" && Date.now() - m.startedAt > 30_000;
      tr.append(
        cell(m.id),
        cell(stale ? "no asignada" : (PHASE_LABEL[m.phase] ?? m.phase), m.phase === "ok" ? "ok" : m.phase === "error" || m.phase === "rechazada" ? "err" : undefined),
        cell(m.totalMs !== undefined ? `${m.totalMs} ms` : "—"),
        cell(m.computeMs !== undefined ? `${m.computeMs} ms` : "—"),
      );
      return tr;
    }),
  );
}

function renderResources(state: NodeState): void {
  const r = state.resources;
  const rows: Array<[string, string]> = [
    ["Carga del hilo principal", r.loopLagMs !== undefined ? `${r.loopLagMs} ms de retraso` : "midiendo…"],
    ["Motor ocupado (último minuto)", `${r.engineBusyPct} %`],
    ["Memoria de la página", r.heapUsedMb !== undefined ? `${r.heapUsedMb} MB de ${r.heapLimitMb} MB` : "no disponible en este navegador"],
    ["Núcleos / memoria del equipo", `${r.cores ?? "?"} núcleos${r.deviceMemoryGb !== undefined ? ` · ${r.deviceMemoryGb} GB` : ""}`],
    ["Batería", r.batteryPct !== undefined ? `${r.batteryPct} %${r.charging ? " (cargando)" : ""}` : "no disponible en este navegador"],
    ["Red", r.network ?? "no disponible en este navegador"],
  ];
  resourcesBody.replaceChildren(
    ...rows.map(([name, value]) => {
      const tr = document.createElement("tr");
      tr.append(cell(name), cell(value));
      return tr;
    }),
  );
}

async function keepAwake(): Promise<void> {
  try {
    const api = (navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (api && !wakeLock) wakeLock = await api.request("screen");
  } catch {
    // Sin Wake Lock el teléfono puede apagar la pantalla: el nodo lo dirá al volver.
  }
}

async function join(): Promise<void> {
  if (joining || running) return;
  joining = true;
  toggle.disabled = true;
  statusEl.textContent = "uniéndose a la red…";
  try {
    const [bootstrap, key] = await Promise.all([loadBootstrap(), loadOrCreateIdentity()]);
    running = await startSatelliteNode({
      bootstrap,
      key,
      solve: solver.run,
      resetEngine: solver.reset,
      isAccepting: accepting,
      log,
      onState: render,
    });
    toggle.textContent = "Salir de la red";
    await keepAwake();
  } catch (error) {
    statusEl.textContent = `no se pudo unir: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    joining = false;
    toggle.disabled = false;
  }
}

async function leave(): Promise<void> {
  const node = running;
  running = undefined;
  toggle.textContent = "Unirme a la red";
  statusEl.textContent = "fuera de la red";
  await node?.stop().catch(() => undefined);
  await wakeLock?.release().catch(() => undefined);
  wakeLock = undefined;
}

toggle.addEventListener("click", () => void (running ? leave() : join()));
copyBtn.addEventListener("click", () => {
  void navigator.clipboard?.writeText(didEl.textContent ?? "").then(() => log("DID copiado"));
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) {
    wakeLock = undefined;
    void keepAwake();
    running.advertiseNow();
    log("de nuevo en primer plano");
  }
});
// Muestra el DID aun antes de unirse (hace falta para FHS_CALC_NODES).
void loadOrCreateIdentity().then((key) => {
  if (!didEl.textContent) didEl.textContent = didFromRaw(key.publicKey.raw);
});
