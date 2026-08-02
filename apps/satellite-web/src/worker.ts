/**
 * Web Worker que carga el módulo WASM satellite-capabilities y expone
 * las dos capacidades (aritmética + CURP) vía postMessage.
 *
 * Protocolo de mensajes:
 *   → { id: number, type: 'solve', expr: string }
 *   → { id: number, type: 'curp', encoded: string }
 *   ← { id: number, result: string }   (prefixo OK: o ERR:)
 */

import { type ASUtil, instantiateStreaming, type ResultObject } from "@assemblyscript/loader";
import wasmUrl from "../../../packages/satellite-capabilities-wasm/build/satellite-capabilities.wasm?url";

interface SatelliteExports extends Record<string, unknown> {
  solveExpression(ptr: number): number;
  computeCurpEncoded(ptr: number): number;
}

type WasmInstance = ResultObject & { exports: ASUtil & SatelliteExports };

type IncomingMessage =
  | { id: number; type: "solve"; expr: string }
  | { id: number; type: "curp"; encoded: string };

let wasmInstance: WasmInstance | null = null;

async function init(): Promise<void> {
  const response = await fetch(wasmUrl);
  wasmInstance = await instantiateStreaming<SatelliteExports>(response, {
    env: {
      abort(_msgPtr: number, _filePtr: number, line: number, _col: number): void {
        console.error(`[satellite-wasm] abort at line ${line}`);
      },
    },
  });
}

const ready = init();

self.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  void ready.then(() => {
    if (!wasmInstance) { self.postMessage({ id: msg.id, result: "ERR:WASM no inicializado" }); return; }
    const { exports } = wasmInstance;
    let result: string;
    try {
      if (msg.type === "solve") {
        const inPtr = exports.__newString(msg.expr);
        const outPtr = exports.solveExpression(inPtr);
        result = exports.__getString(outPtr);
      } else {
        const inPtr = exports.__newString(msg.encoded);
        const outPtr = exports.computeCurpEncoded(inPtr);
        result = exports.__getString(outPtr);
      }
    } catch (e) {
      result = "ERR:" + String(e);
    }
    self.postMessage({ id: msg.id, result });
  });
});
