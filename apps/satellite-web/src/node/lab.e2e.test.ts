/**
 * Prueba de laboratorio (manual): levanta el nodo móvil en Node contra el
 * Atlas real y atiende misiones hasta FHS_LAB_SECONDS. No corre en CI.
 *
 *   FHS_LAB=1 FHS_LAB_BOOTSTRAP=/ip4/192.168.1.139/tcp/4001/tls/ws \
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx vitest run src/node/lab.e2e.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { describe, it } from "vitest";
import { startSatelliteNode } from "./satellite-node.js";

const enabled = process.env.FHS_LAB === "1";

describe.skipIf(!enabled)("nodo móvil contra el laboratorio", () => {
  it("se anuncia, puja y atiende", async () => {
    const wasmDir = new URL("../../../../packages/satellite-capabilities-wasm/pkg/", import.meta.url);
    const wasm = (await import(/* @vite-ignore */ new URL("satellite_capabilities.js", wasmDir).href)) as {
      default: (input: { module_or_path: Uint8Array }) => Promise<unknown>;
      solve_expression: (expr: string) => string;
    };
    await wasm.default({ module_or_path: readFileSync(new URL("satellite_capabilities_bg.wasm", wasmDir)) });

    // FHS_LAB_KEY_FILE fija el DID entre corridas (hace falta para FHS_CALC_NODES).
    const keyFile = process.env.FHS_LAB_KEY_FILE;
    const key =
      keyFile && existsSync(keyFile)
        ? privateKeyFromProtobuf(new Uint8Array(readFileSync(keyFile)))
        : await generateKeyPair("Ed25519");
    if (keyFile && !existsSync(keyFile)) writeFileSync(keyFile, privateKeyToProtobuf(key), { mode: 0o600 });
    const node = await startSatelliteNode({
      bootstrap: (process.env.FHS_LAB_BOOTSTRAP ?? "").split(",").filter(Boolean),
      key,
      solve: (expression) => Promise.resolve(wasm.solve_expression(expression)),
      resetEngine: () => undefined,
      isAccepting: () => true,
      log: (line) => console.log(`[nodo] ${line}`),
      onState: (state) => console.log(`[estado] red=${state.bootstrapConnected} navigator=${state.navigatorConnected} pujas=${state.summary.bids} ok=${state.summary.ok}`),
    });
    console.log(`[nodo] DID ${node.did}`);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FHS_LAB_SECONDS ?? "60") * 1_000));
    await node.stop();
  }, 3_600_000);
});
