/**
 * Web Worker para las capacidades Rust/WASM del Ephemeral Satellite.
 * El módulo se genera con wasm-pack y todas las operaciones permanecen
 * localmente en el dispositivo.
 */

import initRustWasm, {
  compute_curp_encoded,
  solve_expression,
  validate_curp_encoded,
} from "../../../packages/satellite-capabilities-wasm/pkg/satellite_capabilities.js";
import wasmUrl from "../../../packages/satellite-capabilities-wasm/pkg/satellite_capabilities_bg.wasm?url";

interface IncomingMessage {
  id: number;
  type: "solve" | "curp-create" | "curp-validate";
  expr?: string;
  encoded?: string;
  curp?: string;
}

let wasmReady: Promise<void> | undefined;

function init(): Promise<void> {
  wasmReady ??= initRustWasm(wasmUrl);
  return wasmReady;
}

self.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  void init().then(() => {
    let result: string;
    try {
      if (msg.type === "solve") result = solve_expression(msg.expr ?? "");
      else if (msg.type === "curp-create") result = compute_curp_encoded(msg.encoded ?? "");
      else result = validate_curp_encoded(msg.curp ?? "");
    } catch (error) {
      result = `ERR:${String(error)}`;
    }
    self.postMessage({ id: msg.id, result });
  }).catch((error: unknown) => {
    self.postMessage({ id: msg.id, result: `ERR:Rust WASM no inicializado: ${String(error)}` });
  });
});
