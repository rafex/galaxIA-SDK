# galaxIA-SDK — Makefile de construcción

include helpers/mk/common.mk
include helpers/mk/node.mk
include helpers/mk/protocol.mk

.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "$(C_CYAN)$(C_BOLD)galaxIA-SDK — Makefile$(C_RESET)"
	@echo ""
	@echo "$(C_BOLD)Construcción:$(C_RESET)"
	@echo "  make build                     Build completo (fhs-protocol + capabilities + wasm + web)"
	@echo "  make build-protocol            Solo fhs-protocol"
	@echo "  make build-capabilities        Solo satellite-capabilities"
	@echo "  make build-wasm                Solo satellite-capabilities-wasm"
	@echo "  make build-web                 Solo satellite-web"
	@echo ""
	@echo "$(C_BOLD)Verificación:$(C_RESET)"
	@echo "  make typecheck                 TypeScript typecheck en todos los workspaces"
	@echo "  make lint                      Lint en todos los workspaces"
	@echo "  make test                      Tests (vitest)"
	@echo ""
	@echo "$(C_BOLD)Utilidades:$(C_RESET)"
	@echo "  make install                   npm ci"
	@echo "  make clean                     Eliminar dist/ y build/ en todos los workspaces"
	@echo ""
	@echo "$(C_BOLD)Paquetes npm (GitHub Packages):$(C_RESET)"
	@echo "  make protocol-publish          @rafex/galaxia-fhs-protocol: bump + verify + npm publish"
	@echo "  make capabilities-publish      @rafex/galaxia-satellite-capabilities: bump + verify + npm publish"
	@echo "  make wasm-publish              @rafex/galaxia-satellite-capabilities-wasm: bump + npm publish"
	@echo "  (cada uno también tiene -bump-check/-bump/-verify por separado, requiere GH_TOKEN)"
