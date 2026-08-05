# Servicio CURP local

`satellite-web` publica una página HTTPS estática que ejecuta la construcción
y validación estructural de CURP en WebAssembly dentro de un Web Worker. Está
pensada para abrirse desde un celular conectado a la red GalaxIA; no existe
API HTTP de aplicación ni se envían nombres, apellidos o fechas a un servidor.

## Alcance normativo

La implementación sigue las 18 posiciones y el ejemplo de composición del
`Instructivo Normativo para la Asignación de la Clave Única de Registro de
Población`, DOF 18-10-2021. El instructivo remite los casos especiales y el
catálogo a reglas externas. Por ello:

- `Crear` produce una CURP candidata de 18 caracteres y permite indicar la
  posición 17; si se omite, usa `0` para años anteriores a 2000 y `A` para
  años desde 2000, dejando una advertencia.
- `Validar` comprueba longitud, posiciones, fecha real, entidad y dígito
  verificador local.
- Ninguna operación local demuestra que la clave exista, esté activa o sea
  única en RENAPO. Esa verificación requiere una fuente oficial autorizada y
  queda fuera del cálculo WASM.
- El PDF oficial muestra `SABC560626MDFLRN09` como ilustración, pero no
  publica en sus páginas el algoritmo del dígito verificador. El código usa
  la regla pública interoperable de checksum y lo marca como validación
  estructural, no como asignación oficial.

## Desarrollo

```sh
npm run build -w packages/satellite-capabilities
npm run build -w packages/satellite-capabilities-wasm
npm run dev -w apps/satellite-web
```

La compilación de producción genera el WASM y lo empaqueta como asset del
frontend. Para el despliegue E2E se usa
`containers/satellite-web/Containerfile`, que sirve los estáticos únicamente
por HTTPS.
