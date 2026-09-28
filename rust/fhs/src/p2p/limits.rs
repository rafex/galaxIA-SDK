//! Admisión de streams `/fhs/v1/0.1.0` entrantes (DEC-0095): como máximo
//! [`MAX_INBOUND_STREAMS`] abiertos por nodo y [`MAX_INBOUND_STREAMS_PER_PEER`]
//! por peer. Los siguientes se rechazan al abrir (se suelta el stream), antes
//! de leer nada.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use libp2p::PeerId;

pub const MAX_INBOUND_STREAMS: usize = 64;
pub const MAX_INBOUND_STREAMS_PER_PEER: usize = 8;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum Rejected {
    #[error("el nodo ya tiene {0} streams entrantes abiertos")]
    NodeFull(usize),
    #[error("el peer ya tiene {0} streams entrantes abiertos")]
    PeerFull(usize),
}

#[derive(Clone, Default)]
pub struct StreamLimiter {
    state: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    total: usize,
    per_peer: HashMap<PeerId, usize>,
}

/// Plaza de un stream admitido; se libera al soltarla.
pub struct StreamPermit {
    limiter: StreamLimiter,
    peer: PeerId,
}

impl StreamLimiter {
    pub fn try_admit(&self, peer: PeerId) -> Result<StreamPermit, Rejected> {
        let mut state = self.state.lock().expect("límites");
        if state.total >= MAX_INBOUND_STREAMS {
            return Err(Rejected::NodeFull(state.total));
        }
        let open = state.per_peer.get(&peer).copied().unwrap_or(0);
        if open >= MAX_INBOUND_STREAMS_PER_PEER {
            return Err(Rejected::PeerFull(open));
        }
        state.total += 1;
        state.per_peer.insert(peer, open + 1);
        Ok(StreamPermit {
            limiter: self.clone(),
            peer,
        })
    }

    pub fn open(&self) -> usize {
        self.state.lock().expect("límites").total
    }
}

impl Drop for StreamPermit {
    fn drop(&mut self) {
        let mut state = self.limiter.state.lock().expect("límites");
        state.total -= 1;
        if let Some(open) = state.per_peer.get_mut(&self.peer) {
            *open -= 1;
            if *open == 0 {
                state.per_peer.remove(&self.peer);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_streams_per_peer_and_per_node() {
        let limiter = StreamLimiter::default();
        let greedy = PeerId::random();
        let mut held: Vec<_> = (0..MAX_INBOUND_STREAMS_PER_PEER)
            .map(|_| limiter.try_admit(greedy).unwrap())
            .collect();
        // El 9.º del mismo peer se rechaza.
        assert!(matches!(
            limiter.try_admit(greedy),
            Err(Rejected::PeerFull(MAX_INBOUND_STREAMS_PER_PEER))
        ));
        // Otros peers llenan el nodo hasta 64; el 65.º se rechaza.
        while limiter.open() < MAX_INBOUND_STREAMS {
            held.push(limiter.try_admit(PeerId::random()).unwrap());
        }
        assert!(matches!(
            limiter.try_admit(PeerId::random()),
            Err(Rejected::NodeFull(MAX_INBOUND_STREAMS))
        ));
        // Al cerrarse, las plazas vuelven.
        held.truncate(MAX_INBOUND_STREAMS_PER_PEER - 1);
        assert!(limiter.try_admit(greedy).is_ok());
        drop(held);
        assert_eq!(limiter.open(), 0);
    }
}
