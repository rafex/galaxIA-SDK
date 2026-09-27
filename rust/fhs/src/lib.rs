//! Protocolo FHS de galaxIA en Rust, compatible con la red js-libp2p.
//!
//! - [`protocol`]: tipos generados del IDL canónico (`proto/`).
//! - [`signing`]: cadenas de firma Ed25519 idénticas a las del SDK TS.
//! - [`p2p`]: nodo rust-libp2p (WSS+TLS, Noise, yamux, GossipSub, Kademlia),
//!   misiones del lado Navigator y del lado provider.
pub mod p2p;
pub mod protocol;
pub mod signing;
