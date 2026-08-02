# helpers/mk/protocol.mk — automatización de publicación de los 3 paquetes
# distribuibles del SDK (@rafex/galaxia-fhs-protocol,
# @rafex/galaxia-satellite-capabilities, @rafex/galaxia-satellite-capabilities-wasm)
# a GitHub Packages.
# Depende de: helpers/mk/common.mk, helpers/mk/node.mk
# Incluir con: include helpers/mk/protocol.mk

include helpers/mk/common.mk

.PHONY: protocol-bump-check protocol-bump protocol-verify protocol-publish
protocol-bump-check:
	$(call section,Verificando si hace falta subir la versión de @rafex/galaxia-fhs-protocol)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py packages/fhs-protocol --check

protocol-bump:
	$(call section,Subiendo versión de @rafex/galaxia-fhs-protocol si ya está publicada)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py packages/fhs-protocol
	$(call ok,Bump de versión completo (o no hacía falta))

protocol-verify:
	$(call section,Verificando contenido del paquete de fhs-protocol)
	@sh helpers/shell/verify-package.sh packages/fhs-protocol
	$(call ok,Paquete verificado)

protocol-publish: protocol-bump protocol-verify
	$(call section,Publicando @rafex/galaxia-fhs-protocol a GitHub Packages)
	npm publish -w packages/fhs-protocol
	$(call ok,Publicado)

.PHONY: capabilities-bump-check capabilities-bump capabilities-verify capabilities-publish
capabilities-bump-check:
	$(call section,Verificando si hace falta subir la versión de @rafex/galaxia-satellite-capabilities)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py packages/satellite-capabilities --check

capabilities-bump:
	$(call section,Subiendo versión de @rafex/galaxia-satellite-capabilities si ya está publicada)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py packages/satellite-capabilities
	$(call ok,Bump de versión completo (o no hacía falta))

capabilities-verify:
	$(call section,Verificando contenido del paquete satellite-capabilities)
	@sh helpers/shell/verify-package.sh packages/satellite-capabilities
	$(call ok,Paquete verificado)

capabilities-publish: capabilities-bump capabilities-verify
	$(call section,Publicando @rafex/galaxia-satellite-capabilities a GitHub Packages)
	npm publish -w packages/satellite-capabilities
	$(call ok,Publicado)

.PHONY: wasm-bump-check wasm-bump wasm-publish
wasm-bump-check:
	$(call section,Verificando si hace falta subir la versión de @rafex/galaxia-satellite-capabilities-wasm)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py packages/satellite-capabilities-wasm --check

wasm-bump:
	$(call section,Subiendo versión de @rafex/galaxia-satellite-capabilities-wasm si ya está publicada)
	@GH_TOKEN=$${GH_TOKEN:?"GH_TOKEN requerido — export GH_TOKEN=$$(gh auth token)"} \
		uv run helpers/python/bump_package_version.py packages/satellite-capabilities-wasm
	$(call ok,Bump de versión completo (o no hacía falta))

wasm-publish: wasm-bump
	$(call section,Compilando y publicando @rafex/galaxia-satellite-capabilities-wasm a GitHub Packages)
	npm run build -w packages/satellite-capabilities-wasm
	npm publish -w packages/satellite-capabilities-wasm
	$(call ok,Publicado)
