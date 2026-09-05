import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: { outDir: 'dist' },
  // El paquete Rust/WASM generado por wasm-pack se importa desde el Web Worker.
  assetsInclude: ['**/*.wasm'],
});
