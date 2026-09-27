//! Lado provider de una misión (Star, Satellite): puja por las ofertas que
//! puede atender, acepta el stream directo `/fhs/v1/0.1.0` y responde chat o
//! tools. Equivale al `index.ts` de los providers TS sobre `fhs-wire`.
//!
//! Cada provider implementa [`Provider`] y llama a [`serve`]; el ciclo
//! offer/bid/assign, el handshake, las firmas y el framing quedan aquí.

use std::future::Future;
use std::sync::Arc;

use futures::StreamExt;

use crate::p2p::framing::{self, FrameError};
use crate::p2p::identity::NodeIdentity;
use crate::p2p::node::NodeHandle;
use crate::p2p::peer_cache::now_ms;
use crate::p2p::wire::{self, FHS_WIRE_VERSION, TOPIC_MISSIONS_BID};
use crate::protocol::fhs::{
    envelope::Payload, ChatCompletedMessage, ChatDeltaMessage, ChatErrorMessage,
    ChatRequestMessage, DispatchAckMessage, DynamicValue, ErrorMessage, FhsErrorCode,
    HandshakeAckMessage, MissionBidMessage, MissionOfferMessage, PongMessage, ToolCall,
    ToolCallErrorMessage, ToolCallRequestMessage, ToolCallResultMessage, ToolDefinition,
    ToolListResponseMessage,
};

/// Duración del lease que se concede en el `handshake_ack` (como el TS).
const LEASE_SECONDS: i32 = 300;
const HEARTBEAT_SECONDS: i32 = 30;

/// Términos de una puja; el resto (misión, DID, direcciones, firma) lo pone
/// [`serve`].
#[derive(Clone, Debug)]
pub struct BidTerms {
    /// `"star"`, `"satellite"` o `"nova"`.
    pub provider_type: String,
    pub offered_capabilities: Vec<String>,
    pub offered_model: String,
    pub reputation_score: f32,
    pub estimated_latency_ms: i32,
    pub trust_level: String,
}

impl BidTerms {
    pub fn new(provider_type: &str, capabilities: &[&str], estimated_latency_ms: i32) -> Self {
        Self {
            provider_type: provider_type.into(),
            offered_capabilities: capabilities.iter().map(|c| (*c).to_string()).collect(),
            offered_model: String::new(),
            reputation_score: 0.5,
            estimated_latency_ms,
            trust_level: "community".into(),
        }
    }
}

/// Lo que llega por el stream después del handshake.
#[derive(Debug)]
pub enum Request {
    Chat(Box<ChatRequestMessage>),
    Tools(ToolCallRequestMessage),
}

pub trait Provider: Send + Sync + 'static {
    /// Decide si puja por la oferta. `None`: no puja.
    fn bid(&self, offer: &MissionOfferMessage) -> Option<BidTerms>;

    /// Tools que anuncia en `tool_list` (vacío para un Star).
    fn tools(&self) -> Vec<ToolDefinition> {
        Vec::new()
    }

    /// Atiende una petición y responde por `reply`. Los errores se envían como
    /// `chat_error`/`tool_error`; aquí no hay nada que propagar.
    fn handle<'a>(
        &'a self,
        request: Request,
        reply: &'a mut Reply,
    ) -> impl Future<Output = ()> + Send + 'a;
}

/// Respuestas firmadas por el stream de una misión.
pub struct Reply {
    stream: libp2p::Stream,
    identity: NodeIdentity,
    broken: bool,
}

impl Reply {
    /// Envía un payload sellado. Si el Navigator cerró el stream, las demás
    /// escrituras se omiten (no hay a quién responder).
    pub async fn send(&mut self, payload: Payload) {
        if self.broken {
            return;
        }
        let envelope = wire::sealed_envelope(&self.identity, "", payload);
        if let Err(error) = framing::write_envelope(&mut self.stream, &envelope).await {
            tracing::warn!("[stream] no se pudo responder: {error}");
            self.broken = true;
        }
    }

    /// `false` si el Navigator ya cerró el stream.
    pub fn is_open(&self) -> bool {
        !self.broken
    }

    pub async fn dispatch_ack(&mut self, mission_id: &str) {
        self.send(Payload::DispatchAck(DispatchAckMessage {
            mission_id: mission_id.into(),
            queued_at: now_ms(),
        }))
        .await;
    }

    pub async fn chat_delta(&mut self, mission_id: &str, delta: &str) {
        self.send(Payload::ChatDelta(ChatDeltaMessage {
            mission_id: mission_id.into(),
            delta: delta.into(),
        }))
        .await;
    }

    pub async fn chat_completed(
        &mut self,
        mission_id: &str,
        content: String,
        tool_calls: Vec<ToolCall>,
    ) {
        self.send(Payload::ChatCompleted(ChatCompletedMessage {
            mission_id: mission_id.into(),
            content,
            tool_calls,
        }))
        .await;
    }

    pub async fn chat_error(&mut self, mission_id: &str, error: &str) {
        self.send(Payload::ChatError(ChatErrorMessage {
            mission_id: mission_id.into(),
            error: error.into(),
        }))
        .await;
    }

    pub async fn tool_result(
        &mut self,
        mission_id: &str,
        tool_call_id: &str,
        result: DynamicValue,
    ) {
        self.send(Payload::ToolResult(ToolCallResultMessage {
            mission_id: mission_id.into(),
            tool_call_id: tool_call_id.into(),
            result: Some(result),
        }))
        .await;
    }

    pub async fn tool_error(&mut self, mission_id: &str, tool_call_id: &str, error: &str) {
        self.send(Payload::ToolError(ToolCallErrorMessage {
            mission_id: mission_id.into(),
            tool_call_id: tool_call_id.into(),
            error: error.into(),
        }))
        .await;
    }

    async fn error(&mut self, code: FhsErrorCode, message: &str) {
        self.send(Payload::Error(ErrorMessage {
            code: code as i32,
            message: message.into(),
        }))
        .await;
    }
}

/// Atiende la red hasta que el nodo se detenga: puja por las ofertas que
/// acepta `provider` y responde cada stream entrante en su propia tarea.
pub async fn serve<P: Provider>(node: NodeHandle, provider: Arc<P>) {
    tokio::spawn(bid_loop(node.clone(), provider.clone()));
    tokio::spawn(assign_log(node.clone()));

    let mut control = node.stream_control();
    let mut incoming = match control.accept(NodeHandle::fhs_protocol()) {
        Ok(incoming) => incoming,
        Err(error) => {
            tracing::error!(
                "no se pudo registrar {}: {error}",
                wire::FHS_STREAM_PROTOCOL
            );
            return;
        }
    };
    while let Some((peer, stream)) = incoming.next().await {
        tracing::info!("[stream] conexión entrante de {peer}");
        let provider = provider.clone();
        let identity = node.identity.clone();
        tokio::spawn(async move {
            if let Err(error) = run_stream(provider, identity, stream).await {
                tracing::warn!("[stream] {peer}: {error}");
            }
        });
    }
}

async fn bid_loop<P: Provider>(node: NodeHandle, provider: Arc<P>) {
    let mut offers = node.subscribe_offers();
    loop {
        let offer = match offers.recv().await {
            Ok(offer) => offer,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                tracing::warn!("[bid] se perdieron {skipped} ofertas (canal lleno)");
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        };
        if offer.mission_id.is_empty() {
            continue;
        }
        let Some(terms) = provider.bid(&offer) else {
            continue;
        };
        let bid = MissionBidMessage {
            mission_id: offer.mission_id.clone(),
            provider_multiaddrs: node.own_addrs(),
            provider_type: terms.provider_type,
            offered_capabilities: terms.offered_capabilities,
            offered_model: terms.offered_model,
            reputation_score: terms.reputation_score,
            estimated_latency_ms: terms.estimated_latency_ms,
            trust_level: terms.trust_level,
            ..Default::default()
        };
        node.publish(
            TOPIC_MISSIONS_BID,
            wire::signed_mission_bid(&node.identity, bid),
        )
        .await;
        tracing::info!("[bid] puja enviada para la misión {}", offer.mission_id);
    }
}

async fn assign_log(node: NodeHandle) {
    let mut assigns = node.subscribe_assigns();
    while let Ok(assign) = assigns.recv().await {
        if assign.assigned_provider == node.identity.did {
            tracing::info!(
                "[assign] misión {} asignada; se espera el stream del Navigator",
                assign.mission_id
            );
        }
    }
}

async fn run_stream<P: Provider>(
    provider: Arc<P>,
    identity: NodeIdentity,
    stream: libp2p::Stream,
) -> Result<(), FrameError> {
    let mut reply = Reply {
        stream,
        identity,
        broken: false,
    };

    match framing::read_verified(&mut reply.stream).await? {
        Some(envelope) if matches!(envelope.payload, Some(Payload::Handshake(_))) => {}
        Some(_) => {
            reply
                .error(
                    FhsErrorCode::InvalidArguments,
                    "esperaba handshake como primer mensaje",
                )
                .await;
            return Ok(());
        }
        None => return Ok(()),
    }
    reply
        .send(Payload::HandshakeAck(HandshakeAckMessage {
            fhs_version: FHS_WIRE_VERSION.into(),
            lease_seconds: LEASE_SECONDS,
            heartbeat_seconds: HEARTBEAT_SECONDS,
            lease_expires: now_ms() + i64::from(LEASE_SECONDS) * 1000,
            accepted_services: 1,
            trust_level: "community".into(),
        }))
        .await;

    // Varias peticiones por stream, una a la vez, hasta que el Navigator cierre.
    while reply.is_open() {
        let Some(envelope) = framing::read_verified(&mut reply.stream).await? else {
            return Ok(());
        };
        match envelope.payload {
            Some(Payload::ChatRequest(request)) => {
                provider
                    .handle(Request::Chat(Box::new(request)), &mut reply)
                    .await;
            }
            Some(Payload::ToolCall(request)) => {
                provider.handle(Request::Tools(request), &mut reply).await;
            }
            Some(Payload::ToolList(request)) => {
                let tools = provider.tools();
                reply
                    .send(Payload::ToolListResp(ToolListResponseMessage {
                        mission_id: request.mission_id,
                        tools,
                    }))
                    .await;
            }
            Some(Payload::Ping(_)) => {
                reply
                    .send(Payload::Pong(PongMessage {
                        server_timestamp: now_ms(),
                    }))
                    .await;
            }
            // Cancelación: el Navigator cierra el stream y la escritura
            // siguiente falla, lo que detiene la respuesta.
            Some(Payload::ChatCancel(_)) | Some(Payload::ToolCancel(_)) => return Ok(()),
            other => {
                let case = other.as_ref().map_or("vacío", payload_name);
                reply
                    .error(
                        FhsErrorCode::InvalidArguments,
                        &format!("tipo de mensaje inesperado: {case}"),
                    )
                    .await;
                return Ok(());
            }
        }
    }
    Ok(())
}

fn payload_name(payload: &Payload) -> &'static str {
    match payload {
        Payload::Handshake(_) => "handshake",
        Payload::HandshakeAck(_) => "handshake_ack",
        Payload::Error(_) => "error",
        _ => "otro",
    }
}
