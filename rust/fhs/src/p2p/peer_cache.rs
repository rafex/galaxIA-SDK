//! Providers conocidos por sus `NodeAdvertise` firmados (GossipSub
//! `fhs/v1/nodes/advertise`). A diferencia del TS, las entradas expiran:
//! un provider que deja de anunciarse sale de la caché al vencer su TTL.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::Notify;

use serde::Serialize;

use crate::protocol::fhs::{self, NodeAdvertiseMessage, ProviderType};

#[derive(Clone, Debug)]
pub struct PeerEntry {
    pub did: String,
    pub beacon: fhs::Beacon,
    pub multiaddrs: Vec<String>,
    pub trust_level: String,
    pub reputation_score: f64,
    pub peer_type: &'static str,
    pub capabilities: Vec<String>,
    pub last_seen_ms: i64,
    pub expires_at_ms: i64,
    /// `timestamp + ttl` del anuncio (sin la gracia de la caché ni la hora de
    /// recepción): un anuncio reinyectado no la extiende.
    pub advert_expires_ms: i64,
    /// `timestamp` del último anuncio aceptado de este DID.
    pub advert_timestamp_ms: i64,
}

impl PeerEntry {
    pub fn name(&self) -> String {
        self.beacon
            .provider
            .as_ref()
            .map(|p| p.name.clone())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| self.did.clone())
    }
    pub fn description(&self) -> String {
        self.beacon
            .provider
            .as_ref()
            .map(|p| p.description.clone())
            .unwrap_or_default()
    }
    pub fn tags(&self) -> Vec<String> {
        self.beacon
            .provider
            .as_ref()
            .map(|p| p.tags.clone())
            .unwrap_or_default()
    }
    pub fn provider_id(&self) -> String {
        self.beacon
            .provider
            .as_ref()
            .map(|p| p.id.clone())
            .unwrap_or_default()
    }
    pub fn visibility(&self) -> i32 {
        self.beacon
            .provider
            .as_ref()
            .map(|p| p.visibility)
            .unwrap_or_default()
    }
}

/// Vista de `/status` (mismos campos que el Navigator TS; `doctor.sh` los lee).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownPeer {
    pub did: String,
    pub peer_type: &'static str,
    pub capabilities: Vec<String>,
    pub multiaddrs: Vec<String>,
    pub trust_level: String,
    pub last_seen: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn peer_type(provider_type: i32) -> &'static str {
    match ProviderType::try_from(provider_type) {
        Ok(ProviderType::Star) => "star",
        Ok(ProviderType::Satellite) => "satellite",
        Ok(ProviderType::Nova) => "nova",
        _ => "unknown",
    }
}

/// Margen sobre el TTL anunciado antes de olvidar a un provider (un anuncio
/// perdido en la malla no debe sacarlo de la caché).
const TTL_GRACE: Duration = Duration::from_secs(30);

/// Desfase máximo del reloj de un anuncio y TTL máximo (SPEC-CMD-0001).
pub const MAX_ADVERT_SKEW: Duration = Duration::from_secs(120);
pub const MAX_ADVERT_TTL_SECONDS: i64 = 120;

/// Tras arrancar, un provider puede tardar hasta un ciclo de anuncios (30 s)
/// en aparecer. Durante esta ventana una búsqueda vacía espera en vez de fallar.
pub const WARM_UP: Duration = Duration::from_secs(35);

#[derive(Clone)]
pub struct PeerCache {
    inner: Arc<RwLock<HashMap<String, PeerEntry>>>,
    started: Instant,
    changed: Arc<Notify>,
}

impl Default for PeerCache {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            started: Instant::now(),
            changed: Arc::new(Notify::new()),
        }
    }
}

impl PeerCache {
    /// Espera a que `ready` se cumpla, solo mientras dure el arranque
    /// ([`WARM_UP`]); después responde de inmediato.
    pub async fn settle(&self, ready: impl Fn(&PeerCache) -> bool) {
        loop {
            let notified = self.changed.notified();
            if ready(self) {
                return;
            }
            let Some(left) = WARM_UP.checked_sub(self.started.elapsed()) else {
                return;
            };
            let _ = tokio::time::timeout(left, notified).await;
        }
    }

    /// Registra un anuncio ya verificado. Devuelve false si no tiene DID, si no
    /// es fresco (reloj ±120 s, TTL 1..=120) o si su `timestamp` no es
    /// estrictamente mayor al último aceptado de ese DID (anti-replay).
    pub fn upsert(&self, message: &NodeAdvertiseMessage) -> bool {
        self.upsert_at(message, now_ms())
    }

    pub fn upsert_at(&self, message: &NodeAdvertiseMessage, now: i64) -> bool {
        if message.did.is_empty() {
            return false;
        }
        let ttl = i64::from(message.ttl_seconds);
        if !(1..=MAX_ADVERT_TTL_SECONDS).contains(&ttl)
            || message.timestamp.abs_diff(now) > MAX_ADVERT_SKEW.as_millis() as u64
        {
            return false;
        }
        let Some(advert_expires_ms) = ttl
            .checked_mul(1000)
            .and_then(|ms| message.timestamp.checked_add(ms))
        else {
            return false;
        };
        if self
            .inner
            .read()
            .expect("peer cache")
            .get(&message.did)
            .is_some_and(|known| message.timestamp <= known.advert_timestamp_ms)
        {
            return false;
        }
        let beacon = message.beacon.clone().unwrap_or_default();
        let mut capabilities: Vec<String> =
            beacon.capabilities.iter().map(|c| c.id.clone()).collect();
        capabilities.extend(beacon.agent_capabilities.iter().map(|c| c.id.clone()));
        let ttl_ms = ttl * 1000 + TTL_GRACE.as_millis() as i64;
        let entry = PeerEntry {
            did: message.did.clone(),
            peer_type: peer_type(
                beacon
                    .provider
                    .as_ref()
                    .map(|p| p.r#type)
                    .unwrap_or_default(),
            ),
            beacon,
            multiaddrs: message.multiaddrs.clone(),
            trust_level: message.trust_level.clone(),
            reputation_score: 0.5,
            capabilities,
            last_seen_ms: now,
            // La vida la fija el anuncio, no la recepción.
            expires_at_ms: message.timestamp + ttl_ms,
            advert_expires_ms,
            advert_timestamp_ms: message.timestamp,
        };
        self.inner
            .write()
            .expect("peer cache")
            .insert(entry.did.clone(), entry);
        self.changed.notify_waiters();
        true
    }

    fn live(&self) -> Vec<PeerEntry> {
        let now = now_ms();
        let mut map = self.inner.write().expect("peer cache");
        map.retain(|_, entry| entry.expires_at_ms > now);
        map.values().cloned().collect()
    }

    pub fn all(&self) -> Vec<PeerEntry> {
        self.live()
    }
    pub fn stars(&self) -> Vec<PeerEntry> {
        self.live()
            .into_iter()
            .filter(|p| p.peer_type == "star")
            .collect()
    }
    pub fn satellites(&self) -> Vec<PeerEntry> {
        self.live()
            .into_iter()
            .filter(|p| p.peer_type == "satellite")
            .collect()
    }
    pub fn get(&self, did: &str) -> Option<PeerEntry> {
        self.live().into_iter().find(|p| p.did == did)
    }
    /// Como `get`, con la hora dada (pruebas deterministas).
    pub fn get_at(&self, did: &str, now: i64) -> Option<PeerEntry> {
        self.inner
            .read()
            .expect("peer cache")
            .get(did)
            .filter(|entry| entry.expires_at_ms > now)
            .cloned()
    }

    pub fn known_peers(&self) -> Vec<KnownPeer> {
        let mut peers: Vec<KnownPeer> = self
            .live()
            .into_iter()
            .map(|p| KnownPeer {
                did: p.did,
                peer_type: p.peer_type,
                capabilities: p.capabilities,
                multiaddrs: p.multiaddrs,
                trust_level: p.trust_level,
                last_seen: iso8601(p.last_seen_ms),
            })
            .collect();
        peers.sort_by(|a, b| a.did.cmp(&b.did));
        peers
    }

    #[cfg(test)]
    pub(crate) fn expire_all_for_test(&self) {
        for entry in self.inner.write().expect("peer cache").values_mut() {
            entry.expires_at_ms = 0;
        }
    }
}

/// ISO 8601 UTC con milisegundos (como `Date.toISOString()`).
pub fn iso8601(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Algoritmo de días civiles (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn settle_waits_during_warm_up_until_the_provider_appears() {
        let cache = PeerCache::default();
        let waiting = {
            let cache = cache.clone();
            tokio::spawn(async move { cache.settle(|p| !p.stars().is_empty()).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiting.is_finished());
        cache.upsert(&advertise("did:key:zStar", ProviderType::Star));
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("settle debe terminar al llegar el anuncio")
            .unwrap();
        // Ya listo: no espera.
        tokio::time::timeout(
            Duration::from_millis(50),
            cache.settle(|p| !p.stars().is_empty()),
        )
        .await
        .unwrap();
    }

    fn advertise(did: &str, provider_type: ProviderType) -> NodeAdvertiseMessage {
        NodeAdvertiseMessage {
            did: did.into(),
            beacon: Some(fhs::Beacon {
                provider: Some(fhs::ProviderIdentity {
                    r#type: provider_type as i32,
                    name: "KB".into(),
                    ..Default::default()
                }),
                capabilities: vec![fhs::CapabilityDescriptor {
                    id: "knowledge.query".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ttl_seconds: 60,
            timestamp: now_ms(),
            trust_level: "community".into(),
            ..Default::default()
        }
    }

    #[test]
    fn classifies_and_expires_providers() {
        let cache = PeerCache::default();
        assert!(cache.upsert(&advertise("did:key:zKB", ProviderType::Satellite)));
        assert!(cache.upsert(&advertise("did:key:zStar", ProviderType::Star)));
        assert_eq!(cache.satellites().len(), 1);
        assert_eq!(cache.stars().len(), 1);
        assert_eq!(
            cache.get("did:key:zKB").unwrap().capabilities,
            vec!["knowledge.query"]
        );
        cache.expire_all_for_test();
        assert!(cache.all().is_empty());
    }

    #[test]
    fn rejects_stale_future_replayed_and_out_of_range_adverts() {
        let cache = PeerCache::default();
        let now = 1_790_000_000_000;
        let mut advert = advertise("did:key:zKB", ProviderType::Satellite);
        advert.timestamp = now;
        assert!(cache.upsert_at(&advert, now));

        // Un anuncio igual o más viejo (reinyección) no se acepta ni extiende la vida.
        assert!(!cache.upsert_at(&advert, now + 10_000));
        let mut older = advert.clone();
        older.timestamp = now - 1_000;
        assert!(!cache.upsert_at(&older, now + 10_000));
        let entry = cache.get_at("did:key:zKB", now).unwrap();
        assert_eq!(entry.advert_expires_ms, now + 60_000);

        // Reloj fuera de ±120 s, en cualquier sentido.
        let mut stale = advertise("did:key:zOld", ProviderType::Satellite);
        stale.timestamp = now - 121_000;
        assert!(!cache.upsert_at(&stale, now));
        let mut future = advertise("did:key:zFut", ProviderType::Satellite);
        future.timestamp = now + 121_000;
        assert!(!cache.upsert_at(&future, now));

        // TTL fuera de 1..=120 y desbordamientos.
        for ttl in [0, -1, 121, i32::MAX] {
            let mut bad = advertise("did:key:zTtl", ProviderType::Satellite);
            bad.timestamp = now;
            bad.ttl_seconds = ttl;
            assert!(!cache.upsert_at(&bad, now), "ttl {ttl}");
        }
        let mut overflow = advertise("did:key:zOvf", ProviderType::Satellite);
        overflow.timestamp = i64::MAX;
        assert!(!cache.upsert_at(&overflow, i64::MAX));

        // Un anuncio posterior sí avanza la vida.
        let mut newer = advert.clone();
        newer.timestamp = now + 30_000;
        assert!(cache.upsert_at(&newer, now + 30_000));
        assert_eq!(
            cache
                .get_at("did:key:zKB", now + 30_000)
                .unwrap()
                .advert_expires_ms,
            now + 90_000
        );
    }

    #[test]
    fn iso8601_matches_js_to_iso_string() {
        assert_eq!(iso8601(1_790_000_000_000), "2026-09-21T14:13:20.000Z");
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
    }
}
