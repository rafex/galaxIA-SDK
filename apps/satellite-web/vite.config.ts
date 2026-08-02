import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: { outDir: 'dist' },
  // Vite 8 importa .wasm nativamente con ?init y Web Workers con ?worker —
  // no requiere plugin adicional para AssemblyScript, solo que el .wasm
  // sea un asset estático referenciado desde el worker.
  assetsInclude: ['**/*.wasm'],
});
