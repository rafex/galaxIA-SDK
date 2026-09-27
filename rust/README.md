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
