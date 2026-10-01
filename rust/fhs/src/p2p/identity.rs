//! Identidad del nodo: la misma que usan los nodos TS.
//!
//! El archivo (`IDENTITY_KEY_PATH`) guarda la llave privada Ed25519 en la
//! codificación protobuf de libp2p (`privateKeyToProtobuf` en JS,
//! `Keypair::to_protobuf_encoding` aquí), en uno de dos formatos JSON:
//! `{ "privateKeyHex": … }` (Navigator y providers) o `{ "key": <base64> }`
//! (`@rafex/galaxia-fhs-node`, Atlas). Se leen los dos y se escribe el
//! primero, así un reemplazo conserva PeerId y DID con el mismo volumen.

use std::path::Path;

use base64::Engine;
use libp2p::{identity::Keypair, PeerId};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedIdentity {
    private_key_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnyIdentity {
    private_key_hex: Option<String>,
    key: Option<String>,
}

fn protobuf_key(raw: &str) -> Result<Vec<u8>, String> {
    let persisted: AnyIdentity = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    match (persisted.private_key_hex, persisted.key) {
        (Some(hex_key), _) => hex::decode(hex_key.trim()).map_err(|e| e.to_string()),
        (None, Some(b64)) => base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| e.to_string()),
        (None, None) => Err("falta privateKeyHex o key".into()),
    }
}

#[derive(Clone)]
pub struct NodeIdentity {
    pub keypair: Keypair,
    pub peer_id: PeerId,
    pub did: String,
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("no se pudo leer/escribir la identidad {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("identidad inválida en {path}: {reason}")]
    Invalid { path: String, reason: String },
}

impl NodeIdentity {
    pub fn from_keypair(keypair: Keypair) -> Result<Self, String> {
        let public = keypair
            .public()
            .try_into_ed25519()
            .map_err(|_| "la llave de identidad FHS debe ser Ed25519".to_string())?;
        let mut multicodec = vec![0xed, 0x01];
        multicodec.extend_from_slice(&public.to_bytes());
        Ok(Self {
            peer_id: keypair.public().to_peer_id(),
            did: format!("did:key:z{}", bs58::encode(multicodec).into_string()),
            keypair,
        })
    }

    /// Carga la identidad o la crea (y la persiste) si el archivo no existe.
    pub fn load_or_create(path: &Path) -> Result<Self, IdentityError> {
        let label = path.display().to_string();
        if path.exists() {
            let raw = std::fs::read_to_string(path).map_err(|source| IdentityError::Io {
                path: label.clone(),
                source,
            })?;
            let bytes = protobuf_key(&raw).map_err(|reason| IdentityError::Invalid {
                path: label.clone(),
                reason,
            })?;
            let keypair =
                Keypair::from_protobuf_encoding(&bytes).map_err(|e| IdentityError::Invalid {
                    path: label.clone(),
                    reason: e.to_string(),
                })?;
            return Self::from_keypair(keypair).map_err(|reason| IdentityError::Invalid {
                path: label,
                reason,
            });
        }
        let keypair = Keypair::generate_ed25519();
        let bytes = keypair
            .to_protobuf_encoding()
            .map_err(|e| IdentityError::Invalid {
                path: label.clone(),
                reason: e.to_string(),
            })?;
        let persisted = PersistedIdentity {
            private_key_hex: hex::encode(bytes),
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| IdentityError::Io {
                path: label.clone(),
                source,
            })?;
        }
        std::fs::write(
            path,
            serde_json::to_string_pretty(&persisted).expect("json"),
        )
        .map_err(|source| IdentityError::Io {
            path: label.clone(),
            source,
        })?;
        Self::from_keypair(keypair).map_err(|reason| IdentityError::Invalid {
            path: label,
            reason,
        })
    }

    /// Firma una cadena de firma FHS (UTF-8) con la llave del nodo.
    pub fn sign(&self, payload: &str) -> Vec<u8> {
        self.keypair
            .sign(payload.as_bytes())
            .expect("Ed25519 siempre firma")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn did_matches_the_ts_derivation_for_the_fixture_seed() {
        // Misma semilla que export-wire-fixtures.ts (bytes 1..=32).
        let seed: Vec<u8> = (1..=32).collect();
        let keypair = Keypair::ed25519_from_bytes(seed).unwrap();
        let identity = NodeIdentity::from_keypair(keypair).unwrap();
        assert_eq!(
            identity.did,
            "did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7"
        );
        assert_eq!(
            identity.peer_id.to_string(),
            "12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf"
        );
    }

    #[test]
    fn reads_the_fhs_node_format_used_by_atlas() {
        let keypair = Keypair::ed25519_from_bytes((1..=32).collect::<Vec<u8>>()).unwrap();
        let bytes = keypair.to_protobuf_encoding().unwrap();
        let dir = std::env::temp_dir().join(format!("galaxia-id-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".fhs-identity-atlas.json");
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        std::fs::write(&path, format!("{{\"key\":\"{b64}\"}}")).unwrap();
        let loaded = NodeIdentity::load_or_create(&path).unwrap();
        assert_eq!(
            loaded.peer_id.to_string(),
            "12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf"
        );
        // El archivo no se reescribe.
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"key\""));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn persists_and_reloads_the_same_identity() {
        let dir = std::env::temp_dir().join(format!("galaxia-id-{}", uuid::Uuid::new_v4()));
        let path = dir.join("id.json");
        let created = NodeIdentity::load_or_create(&path).unwrap();
        let loaded = NodeIdentity::load_or_create(&path).unwrap();
        assert_eq!(created.did, loaded.did);
        assert_eq!(created.peer_id, loaded.peer_id);
        std::fs::remove_dir_all(dir).ok();
    }
}

/// PeerId de libp2p que corresponde a un `did:key` Ed25519 (misma clave).
pub fn peer_id_of_did(did: &str) -> Result<libp2p::PeerId, String> {
    let raw =
        crate::signing::did_public_key(did).map_err(|e| format!("DID inválido ({did}): {e:?}"))?;
    let key = libp2p::identity::ed25519::PublicKey::try_from_bytes(&raw)
        .map_err(|e| format!("clave Ed25519 inválida: {e}"))?;
    Ok(libp2p::identity::PublicKey::from(key).to_peer_id())
}

#[cfg(test)]
mod did_peer_tests {
    use super::*;

    #[test]
    fn did_maps_to_the_same_peer_id_as_its_key() {
        let identity =
            NodeIdentity::from_keypair(libp2p::identity::Keypair::generate_ed25519()).unwrap();
        assert_eq!(peer_id_of_did(&identity.did).unwrap(), identity.peer_id);
        assert!(peer_id_of_did("did:web:x").is_err());
        assert!(peer_id_of_did("did:key:z2").is_err());
    }
}
