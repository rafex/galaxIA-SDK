//! Mensajes FHS firmados que el nodo publica y recibe.
//!
//! Recibir: decodificar y verificar la firma (anuncios, pujas). Publicar:
//! armar el mensaje, firmar su cadena de firma y codificar. Envelopes: se
//! firman sobre la codificación prost del payload y se envían esos mismos
//! bytes; el receptor TS re-codifica respetando el orden recibido, así que
//! verifica (ver `signing::raw_envelope_payload` para el sentido contrario).

use prost::Message;
use uuid::Uuid;

use crate::p2p::identity::NodeIdentity;
use crate::p2p::peer_cache::now_ms;
use crate::protocol::fhs::{
    self, envelope::Payload, Beacon, DhtBeaconRecord, Envelope, MissionAssignMessage,
    MissionBidMessage, MissionOfferMessage, NodeAdvertiseMessage,
};
use crate::signing;

pub const TOPIC_NODES_ADVERTISE: &str = "fhs/v1/nodes/advertise";
pub const TOPIC_MISSIONS_OFFER: &str = "fhs/v1/missions/offer";
pub const TOPIC_MISSIONS_BID: &str = "fhs/v1/missions/bid";
pub const TOPIC_MISSIONS_ASSIGN: &str = "fhs/v1/missions/assign";
pub const TOPIC_REPUTATION_UPDATE: &str = "fhs/v1/reputation/update";
pub const FHS_STREAM_PROTOCOL: &str = "/fhs/v1/0.1.0";
pub const FHS_WIRE_VERSION: &str = "0.2";

/// Beacon con el que el Portal reconoce a un Navigator (`provider.id == "navigator"`).
pub fn navigator_beacon(name: &str) -> Beacon {
    Beacon {
        fhs_version: FHS_WIRE_VERSION.into(),
        provider: Some(fhs::ProviderIdentity {
            id: "navigator".into(),
            r#type: fhs::ProviderType::Multi as i32,
            visibility: fhs::Visibility::Community as i32,
            name: name.into(),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// Beacon de un provider (`createProviderBeacon` de `fhs-wire`): el id es el
/// propio DID y cada tool se anuncia como etiqueta `tool:<nombre>`.
pub fn provider_beacon(
    did: &str,
    provider_type: fhs::ProviderType,
    name: &str,
    description: &str,
    capabilities: &[&str],
    tags: Vec<String>,
) -> Beacon {
    Beacon {
        fhs_version: FHS_WIRE_VERSION.into(),
        provider: Some(fhs::ProviderIdentity {
            id: did.into(),
            r#type: provider_type as i32,
            visibility: fhs::Visibility::Community as i32,
            name: name.into(),
            description: description.into(),
            tags,
            ..Default::default()
        }),
        capabilities: capabilities
            .iter()
            .map(|id| fhs::CapabilityDescriptor {
                id: (*id).into(),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

pub fn signed_node_advertise(
    identity: &NodeIdentity,
    beacon: Beacon,
    multiaddrs: Vec<String>,
    ttl_seconds: i32,
) -> Vec<u8> {
    let mut message = NodeAdvertiseMessage {
        did: identity.did.clone(),
        beacon: Some(beacon),
        multiaddrs,
        timestamp: now_ms(),
        ttl_seconds,
        trust_level: "community".into(),
        ..Default::default()
    };
    message.signature = identity.sign(&signing::node_advertise_payload(&message));
    message.encode_to_vec()
}

/// Vigencia del beacon en el DHT (igual que el TS y los providers).
pub const DHT_BEACON_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Clave DHT del beacon: `/fhs/beacon/<did>` (espacio `fhs` en kad-dht).
pub fn dht_beacon_key(did: &str) -> Vec<u8> {
    format!("/fhs/beacon/{did}").into_bytes()
}

/// `DhtBeaconRecord` firmado. El Portal descarta los registros sin firma
/// válida.
pub fn signed_dht_beacon(
    identity: &NodeIdentity,
    beacon: Beacon,
    multiaddrs: Vec<String>,
) -> Vec<u8> {
    let published_at = now_ms();
    let mut record = DhtBeaconRecord {
        did: identity.did.clone(),
        beacon: Some(beacon),
        multiaddrs,
        published_at,
        expires_at: published_at + DHT_BEACON_TTL_MS,
        fhs_version: FHS_WIRE_VERSION.into(),
        signature: Vec::new(),
    };
    record.signature = identity.sign(&signing::dht_beacon_payload(&record));
    record.encode_to_vec()
}

pub fn signed_mission_offer(identity: &NodeIdentity, mut message: MissionOfferMessage) -> Vec<u8> {
    message.navigator_did = identity.did.clone();
    message.timestamp = now_ms();
    message.signature = Vec::new();
    message.signature = identity.sign(&signing::mission_offer_payload(&message));
    message.encode_to_vec()
}

pub fn signed_mission_assign(
    identity: &NodeIdentity,
    mission_id: &str,
    assigned_provider: &str,
) -> Vec<u8> {
    let mut message = MissionAssignMessage {
        mission_id: mission_id.into(),
        navigator_did: identity.did.clone(),
        assigned_provider: assigned_provider.into(),
        timestamp: now_ms(),
        signature: Vec::new(),
    };
    message.signature = identity.sign(&signing::mission_assign_payload(&message));
    message.encode_to_vec()
}

/// Puja firmada; `provider_did` y `timestamp` los pone este nodo.
pub fn signed_mission_bid(identity: &NodeIdentity, mut message: MissionBidMessage) -> Vec<u8> {
    message.provider_did = identity.did.clone();
    message.timestamp = now_ms();
    message.signature = Vec::new();
    message.signature = identity.sign(&signing::mission_bid_payload(&message));
    message.encode_to_vec()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Rejected {
    Decode,
    MissingSignature,
    BadSignature,
}

pub fn verified_node_advertise(bytes: &[u8]) -> Result<NodeAdvertiseMessage, Rejected> {
    let message = NodeAdvertiseMessage::decode(bytes).map_err(|_| Rejected::Decode)?;
    if message.signature.is_empty() {
        return Err(Rejected::MissingSignature);
    }
    if !signing::verify_node_advertise(&message) {
        return Err(Rejected::BadSignature);
    }
    Ok(message)
}

pub fn verified_mission_bid(bytes: &[u8]) -> Result<MissionBidMessage, Rejected> {
    let message = MissionBidMessage::decode(bytes).map_err(|_| Rejected::Decode)?;
    if message.signature.is_empty() {
        return Err(Rejected::MissingSignature);
    }
    if !signing::verify_mission_bid(&message) {
        return Err(Rejected::BadSignature);
    }
    Ok(message)
}

pub fn verified_mission_offer(bytes: &[u8]) -> Result<MissionOfferMessage, Rejected> {
    let message = MissionOfferMessage::decode(bytes).map_err(|_| Rejected::Decode)?;
    if message.signature.is_empty() {
        return Err(Rejected::MissingSignature);
    }
    if !signing::verify_mission_offer(&message) {
        return Err(Rejected::BadSignature);
    }
    Ok(message)
}

pub fn verified_mission_assign(bytes: &[u8]) -> Result<MissionAssignMessage, Rejected> {
    let message = MissionAssignMessage::decode(bytes).map_err(|_| Rejected::Decode)?;
    if message.signature.is_empty() {
        return Err(Rejected::MissingSignature);
    }
    if !signing::verify_mission_assign(&message) {
        return Err(Rejected::BadSignature);
    }
    Ok(message)
}

/// Envelope nuevo, sellado (firmado) por este nodo.
pub fn sealed_envelope(identity: &NodeIdentity, dest_peer_id: &str, payload: Payload) -> Envelope {
    let mut envelope = Envelope {
        message_id: Uuid::new_v4().to_string(),
        source_peer_id: identity.did.clone(),
        dest_peer_id: dest_peer_id.into(),
        timestamp: now_ms(),
        version: FHS_WIRE_VERSION.into(),
        signature: Vec::new(),
        payload: Some(payload),
    };
    envelope.signature = identity.sign(&signing::envelope_payload(&envelope));
    envelope
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    fn identity() -> NodeIdentity {
        NodeIdentity::from_keypair(Keypair::generate_ed25519()).unwrap()
    }

    #[test]
    fn dht_beacon_is_signed_like_the_portal_expects() {
        let id = identity();
        let bytes = signed_dht_beacon(
            &id,
            navigator_beacon("Navigator FHS"),
            vec!["/ip4/1.2.3.4/tcp/4010/tls/ws".into()],
        );
        let record = DhtBeaconRecord::decode(bytes.as_slice()).unwrap();
        assert_eq!(record.expires_at - record.published_at, DHT_BEACON_TTL_MS);
        // Misma cadena que readDhtBeacon en portal-chat/p2p-discovery.ts.
        let expected = format!(
            "{}:{}:{}:{}",
            id.did,
            signing::beacon_sha256(record.beacon.as_ref()),
            record.published_at,
            record.expires_at
        );
        assert!(signing::verify(&id.did, &expected, &record.signature));
        assert_eq!(
            dht_beacon_key("did:key:zX"),
            b"/fhs/beacon/did:key:zX".to_vec()
        );
    }

    #[test]
    fn own_signed_messages_verify_with_the_shared_rules() {
        let id = identity();
        let advertise = signed_node_advertise(
            &id,
            navigator_beacon("Navigator FHS"),
            vec!["/ip4/1.2.3.4/tcp/4010/tls/ws".into()],
            60,
        );
        let decoded = verified_node_advertise(&advertise).unwrap();
        assert_eq!(decoded.did, id.did);

        let assign =
            MissionAssignMessage::decode(signed_mission_assign(&id, "m", "did:key:zP").as_slice())
                .unwrap();
        assert!(signing::verify_mission_assign(&assign));

        let offer = MissionOfferMessage::decode(
            signed_mission_offer(
                &id,
                MissionOfferMessage {
                    mission_id: "m".into(),
                    mission_type: "chat".into(),
                    bid_deadline_ms: 2000,
                    ..Default::default()
                },
            )
            .as_slice(),
        )
        .unwrap();
        assert!(signing::verify_mission_offer(&offer));
        assert_eq!(
            verified_mission_offer(&offer.encode_to_vec())
                .unwrap()
                .mission_id,
            "m"
        );
        assert!(verified_mission_assign(&assign.encode_to_vec()).is_ok());

        let bid = verified_mission_bid(&signed_mission_bid(
            &id,
            MissionBidMessage {
                mission_id: "m".into(),
                offered_capabilities: vec!["knowledge.query".into(), "chat".into()],
                ..Default::default()
            },
        ))
        .unwrap();
        assert_eq!(bid.provider_did, id.did);

        let mut tampered = offer.clone();
        tampered.mission_type = "tool_call".into();
        assert_eq!(
            verified_mission_offer(&tampered.encode_to_vec()),
            Err(Rejected::BadSignature)
        );
    }

    #[test]
    fn provider_beacon_matches_create_provider_beacon() {
        let beacon = provider_beacon(
            "did:key:zKb",
            fhs::ProviderType::Satellite,
            "KB Provider FHS",
            "Constitución",
            &["knowledge.query"],
            vec!["tool:kb_query".into()],
        );
        let provider = beacon.provider.unwrap();
        assert_eq!(provider.id, "did:key:zKb");
        assert_eq!(provider.visibility, fhs::Visibility::Community as i32);
        assert_eq!(beacon.capabilities[0].id, "knowledge.query");
        assert_eq!(provider.tags, vec!["tool:kb_query"]);
    }

    #[test]
    fn sealed_envelope_verifies_from_its_wire_bytes() {
        let id = identity();
        let envelope = sealed_envelope(
            &id,
            "did:key:zStar",
            Payload::ChatDelta(fhs::ChatDeltaMessage {
                mission_id: "m".into(),
                delta: "hola".into(),
            }),
        );
        let bytes = envelope.encode_to_vec();
        assert!(signing::verify_envelope_bytes(&bytes).unwrap().is_some());
    }

    #[test]
    fn rejects_tampered_advertise() {
        let id = identity();
        let mut message = NodeAdvertiseMessage::decode(
            signed_node_advertise(&id, navigator_beacon("N"), vec![], 60).as_slice(),
        )
        .unwrap();
        message.ttl_seconds = 999;
        assert_eq!(
            verified_node_advertise(&message.encode_to_vec()),
            Err(Rejected::BadSignature)
        );
    }
}
