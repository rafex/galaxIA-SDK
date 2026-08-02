# TASKS.md — Rename requestId → missionId en galaxIA-SDK

## Metadata

- Iniciativa: `rename-requestid-missionid`
- DEC relacionada: DEC-0085 (rename de campo wire protocol)
- Owner: rafex
- Estado general: `done`
- Origen: trasladado desde galaxIA (repo IDL-only) — tarea original #53

## Contexto

El campo `requestId` en todos los mensajes del protocolo FHS fue renombrado a `missionId`
(DEC-0085). En este repo, el cambio afecta a:

- `packages/fhs-protocol/src/messages.ts` — 12 interfaces de mensaje
- `packages/fhs-protocol/src/identity.ts` — parámetro `requestId` en `invokeSignaturePayload`
- `packages/fhs-protocol/schemas/fhs-protocol.schema.json` — generado automáticamente

El nombre del parámetro en `invokeSignaturePayload(callerId, requestId, timestamp)` cambia a
`missionId`, pero el valor interpolado en el string firmado sigue siendo el mismo UUID —
el rename **no rompe firmas existentes** ni el esquema de CallerAuth.

Nota: CallerAuth fue eliminado posteriormente por DEC-0087 (Envelope P2P). Los schemas de
beacon y el IDL canónico viven en el repo `galaxIA` (IDL-only).

---

## Tareas

### TASK-REN-SDK-001 — Rename en packages/fhs-protocol/src/

- ID: TASK-REN-SDK-001
- State: `done`
- Owner: rafex
- Archivos modificados:
  - `packages/fhs-protocol/src/messages.ts` — 12 interfaces: `requestId → missionId`
  - `packages/fhs-protocol/src/identity.ts` — parámetro: `requestId → missionId`
- Validation: ✅ `grep -rn "requestId" packages/fhs-protocol/src/` devuelve 0 resultados.
  `grep -rn "missionId" packages/fhs-protocol/src/` devuelve 15 ocurrencias (verificado 2026-08-02).

---

### TASK-REN-SDK-002 — Regenerar fhs-protocol.schema.json

- ID: TASK-REN-SDK-002
- State: `done`
- Owner: rafex
- Dependencies: TASK-REN-SDK-001
- Comando: `npm run build:schemas` dentro de `packages/fhs-protocol`
  (ver `helpers/mk/protocol.mk` — invoca `ts-json-schema-generator` sobre `messages.ts`)
- Close criteria: `packages/fhs-protocol/schemas/fhs-protocol.schema.json` refleja `missionId`
  en todas las definiciones de mensaje. El schema no contiene `requestId`.
- Validation: ✅ Schema regenerado como parte de la migración inicial del monorepo SDK.
  Ver commit `cffcd84 feat: migrar packages TypeScript desde galaxIA`.

---

### TASK-REN-SDK-003 — Bump de versión y publicación

- ID: TASK-REN-SDK-003
- State: `done`
- Owner: rafex
- Dependencies: TASK-REN-SDK-002
- Notas: El rename es un cambio de wire protocol — bump de versión minor del paquete
  `@rafex/galaxia-fhs-protocol`. La publicación a GitHub Packages se dispara automáticamente
  desde el workflow de CD cuando se hace push a main con cambios en `packages/fhs-protocol/**`.
- Validation: ✅ Ver commits `aaf4502 chore: bump @rafex/galaxia-fhs-protocol version` y
  `4bc2b50 fix: usar GH_PACKAGES_TOKEN para publicar a GitHub Packages`.

---

## Dependencia hacia otros repos

Cualquier repo que consuma `@rafex/galaxia-fhs-protocol` debe pinnear la versión nueva
(con `missionId`) antes del redeploy coordinado. Los repos afectados:

- `galaxIA-Core` — `apps/navigator`
- `galaxIA-satellite-star` — todos los providers de referencia
