import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const canonicalIdl = process.env.FHS_IDL_PATH
  ? resolve(process.env.FHS_IDL_PATH)
  : resolve(repositoryRoot, "../galaxIA/idl/fhs-protocol.proto");
const generatedDir = resolve(packageRoot, "src/generated");
const plugin = resolve(repositoryRoot, "node_modules/.bin/protoc-gen-es");

if (!existsSync(canonicalIdl)) {
  throw new Error(
    `No se encontró el IDL canónico en ${canonicalIdl}. ` +
      "Define FHS_IDL_PATH cuando los repositorios no estén como hermanos.",
  );
}

if (!existsSync(plugin)) {
  throw new Error(`No se encontró protoc-gen-es en ${plugin}. Ejecuta npm install primero.`);
}

mkdirSync(generatedDir, { recursive: true });
for (const entry of ["fhs-protocol_pb.ts"]) {
  rmSync(resolve(generatedDir, entry), { force: true });
}

const result = spawnSync(
  "protoc",
  [
    `--proto_path=${dirname(canonicalIdl)}`,
    `--plugin=protoc-gen-es=${plugin}`,
    "--es_out=target=ts:src/generated",
    canonicalIdl,
  ],
  { cwd: packageRoot, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
