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
const statsEl = $("net-stats");
const lastEl = $("net-last");
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
  statsEl.textContent = `pujas enviadas: ${state.bids} · misiones atendidas: ${state.served}`;
  lastEl.textContent = state.last ? `última: ${state.last.expression} → ${state.last.outcome}` : "";
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
