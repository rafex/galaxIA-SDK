# helpers/mk/node.mk — targets de build Node.js / npm workspaces
# Depende de: helpers/mk/common.mk
# Incluir con: include helpers/mk/node.mk

include helpers/mk/common.mk

WS_PROTOCOL     := packages/fhs-protocol
WS_CAPABILITIES := packages/satellite-capabilities
WS_WASM         := packages/satellite-capabilities-wasm
WS_WEB          := apps/satellite-web

WS_ALL          := $(WS_PROTOCOL) $(WS_CAPABILITIES) $(WS_WASM) $(WS_WEB)

.PHONY: install
install:
	$(call section,Instalando dependencias)
	npm ci
	$(call ok,Dependencias instaladas)

.PHONY: build
build: build-protocol build-capabilities build-wasm build-web
	$(call ok,Build completo terminado)

.PHONY: build-protocol
build-protocol:
	$(call info,Compilando fhs-protocol)
	npm run build -w $(WS_PROTOCOL)
	$(call ok,fhs-protocol compilado)

.PHONY: build-capabilities
build-capabilities:
	$(call info,Compilando satellite-capabilities)
	npm run build -w $(WS_CAPABILITIES)
	$(call ok,satellite-capabilities compilado)

.PHONY: build-wasm
build-wasm: build-capabilities
	$(call info,Compilando satellite-capabilities-wasm)
	npm run build -w $(WS_WASM)
	$(call ok,satellite-capabilities-wasm compilado)

.PHONY: build-web
build-web: build-wasm
	$(call info,Compilando satellite-web)
	npm run build -w $(WS_WEB)
	$(call ok,satellite-web compilado)

.PHONY: typecheck
typecheck:
	$(call section,Typecheck)
	npm run typecheck --workspaces
	$(call ok,Typecheck pasado)

.PHONY: lint
lint:
	$(call section,Lint)
	npm run lint --workspaces
	$(call ok,Lint pasado)

.PHONY: test
test:
	$(call section,Tests)
	npm run test
	$(call ok,Tests pasados)

.PHONY: clean
clean:
	$(call section,Limpiando artefactos)
	@for ws in $(WS_ALL); do \
		printf "$(C_BLUE)[CLEAN]$(C_RESET) $$ws\n"; \
		rm -rf $$ws/dist $$ws/.tsbuildinfo 2>/dev/null || true; \
	done
	rm -rf packages/satellite-capabilities-wasm/build 2>/dev/null || true
	rm -rf node_modules/.cache 2>/dev/null || true
	$(call ok,Artefactos eliminados)
