//! Ciclo de misión: offer → bids → selección → assign (`mission-cycle.ts`).

use std::time::Duration;
use std::time::Instant;

use uuid::Uuid;

use crate::p2p::node::NodeHandle;
use crate::p2p::wire::{self, TOPIC_MISSIONS_ASSIGN, TOPIC_MISSIONS_OFFER};
use crate::protocol::fhs::{MissionBidMessage, MissionOfferMessage};

pub const DEFAULT_BID_DEADLINE: Duration = Duration::from_secs(2);

pub struct MissionRequest<'a> {
    /// `chat` o `tool_call`.
    pub mission_type: &'a str,
    pub required_capabilities: Vec<String>,
    pub preferred_model: Option<String>,
    /// Provider que el runtime ya eligió: gana si pujó.
    pub preferred_provider: Option<String>,
    pub bid_deadline: Duration,
    /// Id de la misión; por defecto uno nuevo (UUID). Permite que la
    /// autorización del usuario y el ciclo compartan el mismo id.
    pub mission_id: Option<String>,
    /// Si se da, **solo cuentan** las pujas de estos DIDs y con conexión viva
    /// (DEC-0096: restringe quién puede ganar; el ciclo no se acorta).
    pub allowed_provider_dids: Option<Vec<String>>,
}

pub struct WinningBid {
    pub mission_id: String,
    pub bid: MissionBidMessage,
}

fn trust_rank(level: &str) -> i32 {
    match level {
        "delegated" => 4,
        "standard" => 3,
        "community" => 2,
        "unverified" => 1,
        _ => 0,
    }
}

/// `true` si `offered` incluye **todas** las capacidades `required`
/// (semántica de `required_capabilities`, DEC-0095). Es la regla de puja de
/// los providers y el filtro de pujas del Navigator.
pub fn covers<R: AsRef<str>, O: AsRef<str>>(required: &[R], offered: &[O]) -> bool {
    required
        .iter()
        .all(|r| offered.iter().any(|o| o.as_ref() == r.as_ref()))
}

/// Descarta las pujas que no ofrecen todas las capacidades `required` (no se
/// confía solo en la regla de puja del provider). Entre las demás, el
/// preferido gana si pujó; si no, trust → reputación → latencia (misma regla
/// que `selectWinningBid` del Navigator TS, E2E-030).
pub fn select_winning_bid<'a>(
    bids: &'a [MissionBidMessage],
    required: &[String],
    preferred: Option<&str>,
) -> Option<&'a MissionBidMessage> {
    let eligible = || {
        bids.iter()
            .filter(|b| covers(required, &b.offered_capabilities))
    };
    if let Some(preferred) = preferred {
        if let Some(bid) = eligible().find(|b| b.provider_did == preferred) {
            return Some(bid);
        }
    }
    eligible().min_by(|a, b| {
        trust_rank(&b.trust_level)
            .cmp(&trust_rank(&a.trust_level))
            .then(b.reputation_score.total_cmp(&a.reputation_score))
            .then(a.estimated_latency_ms.cmp(&b.estimated_latency_ms))
    })
}

/// Deja solo las pujas de DIDs permitidos que `connected` reconoce vivos.
pub fn filter_allowed(
    bids: Vec<MissionBidMessage>,
    allowed: &[String],
    connected: impl Fn(&str) -> bool,
) -> Vec<MissionBidMessage> {
    bids.into_iter()
        .filter(|bid| allowed.contains(&bid.provider_did) && connected(&bid.provider_did))
        .collect()
}

/// Publica la oferta, recoge pujas y publica la asignación del ganador.
pub async fn run_mission_cycle(
    node: &NodeHandle,
    request: MissionRequest<'_>,
) -> Option<WinningBid> {
    let mission_id = request
        .mission_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let navigator_multiaddrs = node
        .status()
        .await
        .map(|s| s.multiaddrs)
        .unwrap_or_default();
    let required = request.required_capabilities;
    let offer = MissionOfferMessage {
        mission_id: mission_id.clone(),
        navigator_multiaddrs,
        mission_type: request.mission_type.into(),
        required_capabilities: required.clone(),
        preferred_model: request.preferred_model.unwrap_or_default(),
        bid_deadline_ms: request.bid_deadline.as_millis() as i64,
        ..Default::default()
    };
    let collecting = {
        let bids = node.bids.clone();
        let id = mission_id.clone();
        let deadline = request.bid_deadline;
        let preferred = request.preferred_provider.clone();
        tokio::spawn(async move { bids.collect(&id, deadline, preferred).await })
    };
    // La ventana se abre antes de publicar para no perder pujas rápidas.
    tokio::task::yield_now().await;
    let bid_wait_started = Instant::now();
    node.publish(
        TOPIC_MISSIONS_OFFER,
        wire::signed_mission_offer(&node.identity, offer),
    )
    .await;
    tracing::info!(
        "[mission] offer {mission_id} publicado (type={})",
        request.mission_type
    );

    let mut bids = collecting.await.unwrap_or_default();
    if let Some(allowed) = &request.allowed_provider_dids {
        bids = filter_allowed(bids, allowed, |did| {
            crate::p2p::identity::peer_id_of_did(did).is_ok_and(|peer| node.is_connected(&peer))
        });
    }
    tracing::info!(
        mission_id = %mission_id,
        bid_count = bids.len(),
        bid_wait_ms = bid_wait_started.elapsed().as_millis() as u64,
        preferred_provider = %request.preferred_provider.as_deref().unwrap_or("none"),
        "[mission] bids collected",
    );
    let Some(winner) = select_winning_bid(&bids, &required, request.preferred_provider.as_deref())
    else {
        if !bids.is_empty() {
            tracing::warn!(
                "[mission] {mission_id}: {} pujas sin todas las capacidades {required:?}",
                bids.len()
            );
        }
        return None;
    };
    let winner = winner.clone();

    node.publish(
        TOPIC_MISSIONS_ASSIGN,
        wire::signed_mission_assign(&node.identity, &mission_id, &winner.provider_did),
    )
    .await;
    tracing::info!("[mission] assign {mission_id} → {}", winner.provider_did);
    Some(WinningBid {
        mission_id,
        bid: winner,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OCR: &str = "document.ocr";

    fn bid(did: &str, trust: &str, reputation: f32, latency: i32) -> MissionBidMessage {
        MissionBidMessage {
            provider_did: did.into(),
            trust_level: trust.into(),
            reputation_score: reputation,
            estimated_latency_ms: latency,
            offered_capabilities: vec![OCR.into()],
            ..Default::default()
        }
    }

    fn required(caps: &[&str]) -> Vec<String> {
        caps.iter().map(|c| (*c).to_string()).collect()
    }

    #[test]
    fn allowed_filter_never_lets_a_disallowed_or_disconnected_bid_win() {
        // El no permitido tiene mejor confianza, reputación y latencia.
        let mut better = bid("no-permitido", "standard", 0.99, 1);
        better.trust_level = "delegated".into();
        let bids = vec![
            better,
            bid("permitido", "community", 0.1, 900),
            bid("caido", "community", 0.5, 10),
        ];
        let allowed = vec!["permitido".to_string(), "caido".to_string()];
        let kept = filter_allowed(bids, &allowed, |did| did != "caido");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].provider_did, "permitido");
        assert_eq!(
            select_winning_bid(&kept, &required(&[OCR]), Some("no-permitido"))
                .unwrap()
                .provider_did,
            "permitido"
        );
        assert!(filter_allowed(vec![bid("x", "standard", 1.0, 1)], &[], |_| true).is_empty());
    }

    #[test]
    fn discards_bids_that_miss_a_required_capability() {
        let mut with_ipfs = bid("con-ipfs", "community", 0.1, 900);
        with_ipfs
            .offered_capabilities
            .push("ipfs.native.public".into());
        let bids = [bid("sin-ipfs", "standard", 0.9, 10), with_ipfs];
        let need = required(&[OCR, "ipfs.native.public"]);
        // Ni siendo el preferido ni teniendo mejor trust gana el parcial.
        assert_eq!(
            select_winning_bid(&bids, &need, Some("sin-ipfs"))
                .unwrap()
                .provider_did,
            "con-ipfs"
        );
        assert!(select_winning_bid(&bids[..1], &need, None).is_none());
        assert!(covers(&need, &["ipfs.native.public", OCR, "extra"]));
        assert!(!covers(&need, &[OCR]));
        assert!(covers::<&str, &str>(&[], &[]));
    }

    #[test]
    fn preferred_provider_wins_if_it_bid() {
        let bids = [
            bid("a", "standard", 0.5, 100),
            bid("b", "community", 0.5, 100),
        ];
        assert_eq!(
            select_winning_bid(&bids, &required(&[OCR]), Some("b"))
                .unwrap()
                .provider_did,
            "b"
        );
    }

    #[test]
    fn otherwise_trust_then_reputation_then_latency() {
        let bids = [
            bid("a", "community", 0.9, 50),
            bid("b", "standard", 0.1, 900),
            bid("c", "standard", 0.1, 100),
        ];
        assert_eq!(
            select_winning_bid(&bids, &required(&[OCR]), Some("ausente"))
                .unwrap()
                .provider_did,
            "c"
        );
        assert!(select_winning_bid(&[], &required(&[OCR]), None).is_none());
    }
}
