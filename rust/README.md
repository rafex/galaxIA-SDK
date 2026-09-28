# Crates Rust del SDK

`galaxia-fhs` es la base compartida de los servicios Rust de galaxIA
(Navigator `galaxIA-agent`, Star, Satellites y Atlas). Habla el mismo wire que
los nodos js-libp2p: se verifica con fixtures generados desde el TS y con una
misión completa entre nodos reales.

| Módulo | Qué hace |
|---|---|
| `protocol` | Tipos del IDL canónico (`fhs/proto/`, igual a `galaxIA/idl`; `fhs/scripts/check-idl.sh`) |
| `signing` | Cadenas de firma Ed25519 idénticas a `@rafex/galaxia-fhs-protocol` |
| `p2p::identity` | Llave Ed25519 → PeerId + `did:key`, mismo archivo `{privateKeyHex}` que el TS |
| `p2p::tls` | WSS con rustls; acepta por pin el certificado del laboratorio (`NODE_EXTRA_CA_CERTS`) |
| `p2p::node` | Nodo libp2p (Noise, yamux, GossipSub, Kademlia, identify, ping) con papel `Navigator`, `Provider` o `Bootstrap` |
| `p2p::mission`, `p2p::client` | Lado Navigator: offer → bids → assign → stream (chat con deltas, tools) |
| `p2p::provider` | Lado provider: puja, `handshake_ack`, chat/tools por el stream |
| `p2p::peer_cache`, `p2p::wire`, `p2p::framing`, `p2p::dynamic` | Caché de anuncios con TTL, mensajes firmados, frames con prefijo varint, JSON ↔ `DynamicValue` |
| `ipfs` (feature `ipfs`) | Cliente de la API de un Kubo local: URL solo loopback literal, token *bearer* desde archivo, sin proxy ni redirecciones, CID canónico, `add` con perfil congelado, `pin rm` idempotente, `cat` con tope |
| `p2p::limits` | Admisión de streams entrantes: 64 por nodo, 8 por peer (`NodeHandle::admit_stream`) |

## Límites de protocolo (DEC-0095)

Iguales en todos los nodos, no configurables:

- Frame de 33 MB (`framing::MAX_FRAME_BYTES`), comprobado sobre el prefijo de
  longitud antes de reservar memoria; adjunto de 32 MB
  (`framing::MAX_ATTACHMENT_BYTES`).
- Presupuesto de decodificación de 128 MB por proceso: cada frame toma el doble
  de su longitud mientras se lee y decodifica. Como máximo 16 frames esperando
  y 10 s de espera; si no, se cierra el stream (`FrameError::Overloaded`).
- 5 frames seguidos con firma inválida cierran el stream.
- Una puja gana solo si ofrece **todas** las `required_capabilities`
  (`mission::covers`); los providers usan la misma regla para pujar.
- `NodeHandle::set_advertise_beacon` cambia el beacon en caliente (p. ej. al
  ganar o perder `ipfs.native.<red>`): anuncio inmediato y beacon DHT nuevo.

## Usarlo desde otro repo

```toml
[dependencies]
galaxia-fhs = { git = "https://github.com/rafex/galaxIA-SDK", branch = "main" }

# Obligatorio: los [patch] de una dependencia no se heredan.
[patch.crates-io]
libp2p-websocket = { git = "https://github.com/rafex/galaxIA-SDK", branch = "main" }
```

El parche de `libp2p-websocket` agrega `tls::Config::from_rustls`, que
necesita el verificador por pin (ver `vendor/libp2p-websocket/GALAXIA-PATCH.md`).
La compilación necesita `protoc` (`protobuf-compiler`).

Para probar cambios locales del SDK sin publicarlos:

```sh
cargo build --config 'patch."https://github.com/rafex/galaxIA-SDK".galaxia-fhs.path="../galaxIA-SDK/rust/fhs"'
```

`cargo test --all-features --test kubo_live` corre contra un Kubo real si se
definen `FHS_KUBO_API_URL` y `FHS_KUBO_TOKEN_FILE` (ver el archivo).

## Desarrollo

```sh
cd rust
cargo fmt --check
cargo clippy --all-targets -p galaxia-fhs -- -D warnings
cargo test -p galaxia-fhs
(cd fhs && sh scripts/check-idl.sh)
```

Regenerar los fixtures del wire TS:
`cd galaxIA-Core/apps/navigator && npx tsx scripts/export-wire-fixtures.ts ../../../galaxIA-SDK/rust/fhs/tests/fixtures/wire.json`
