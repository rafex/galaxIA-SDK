//! Misión completa entre nodos reales en 127.0.0.1 (WebSocket sin TLS):
//! bootstrap (reenvía GossipSub, como Atlas) ← provider y Navigator.
//! El Navigator usa el mismo cliente que `galaxIA-agent`; el provider, el
//! lado [`provider`] del SDK. Cubre offer → bid → assign → stream → respuesta.

use std::sync::Arc;
use std::time::Duration;

use galaxia_fhs::p2p::{
    client::{self, ChatRequest, ToolRequest},
    dynamic,
    identity::NodeIdentity,
    node::{self, NodeConfig, NodeHandle, Role},
    provider::{self, BidTerms, Provider, Reply, Request},
    tls,
};
use galaxia_fhs::protocol::fhs::{Message, MissionOfferMessage};
use libp2p::{identity::Keypair, Multiaddr};
use serde_json::json;

struct EchoProvider;

impl Provider for EchoProvider {
    fn bid(&self, offer: &MissionOfferMessage) -> Option<BidTerms> {
        match offer.mission_type.as_str() {
            "chat" if offer.required_capabilities.iter().any(|c| c == "chat") => {
                Some(BidTerms::new("star", &["chat"], 200))
            }
            "tool_call"
                if offer
                    .required_capabilities
                    .iter()
                    .any(|c| c == "echo.upper") =>
            {
                Some(BidTerms::new("satellite", &["echo.upper"], 50))
            }
            _ => None,
        }
    }

    async fn handle(&self, request: Request, reply: &mut Reply) {
        match request {
            Request::Chat(chat) => {
                reply.dispatch_ack(&chat.mission_id).await;
                let question = chat
                    .messages
                    .last()
                    .map(|m| m.content.clone())
                    .unwrap_or_default();
                for word in ["eco: ", &question] {
                    reply.chat_delta(&chat.mission_id, word).await;
                }
                reply
                    .chat_completed(&chat.mission_id, format!("eco: {question}"), vec![])
                    .await;
            }
            Request::Tools(call) => {
                reply.dispatch_ack(&call.mission_id).await;
                for tool_call in call.tool_calls {
                    let args = tool_call
                        .function
                        .and_then(|f| f.arguments)
                        .map(|a| dynamic::to_json(&a))
                        .unwrap_or_default();
                    let text = args["text"].as_str().unwrap_or_default().to_uppercase();
                    reply
                        .tool_result(
                            &call.mission_id,
                            &tool_call.id,
                            dynamic::from_json(&json!({ "text": text })).unwrap(),
                        )
                        .await;
                }
            }
        }
    }
}

fn start(role: Role, bootstrap: Vec<Multiaddr>) -> NodeHandle {
    let identity = NodeIdentity::from_keypair(Keypair::generate_ed25519()).unwrap();
    node::start(NodeConfig {
        role,
        agent_version: "galaxia-fhs-test".into(),
        identity,
        listen: vec!["/ip4/127.0.0.1/tcp/0/ws".parse().unwrap()],
        announce: vec![],
        bootstrap,
        tls: tls::websocket_config(None, None, &[]).unwrap(),
        advertise: None,
        dht_beacon: None,
    })
    .unwrap()
}

async fn listen_addr(node: &NodeHandle) -> Multiaddr {
    for _ in 0..50 {
        if let Some(addr) = node
            .status()
            .await
            .and_then(|s| s.multiaddrs.into_iter().next())
        {
            return addr.parse().unwrap();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("el nodo no empezó a escuchar");
}

#[tokio::test(flavor = "multi_thread")]
async fn chat_and_tool_missions_run_end_to_end() {
    let atlas = start(Role::Bootstrap, vec![]);
    let atlas_addr = listen_addr(&atlas).await;
    let star = start(Role::Provider, vec![atlas_addr.clone()]);
    tokio::spawn(provider::serve(star.clone(), Arc::new(EchoProvider)));
    let navigator = start(Role::Navigator, vec![atlas_addr]);
    // Suscripciones y malla GossipSub (heartbeat de 1 s).
    tokio::time::sleep(Duration::from_secs(3)).await;

    let mut deltas = Vec::new();
    let chat = client::chat(
        &navigator,
        ChatRequest {
            messages: vec![Message {
                role: "user".into(),
                content: "hola".into(),
                ..Default::default()
            }],
            tools: vec![],
            model: String::new(),
            preferred_provider: None,
            timeout: Duration::from_secs(20),
        },
        |delta| deltas.push(delta.to_string()),
    )
    .await
    .expect("misión de chat");
    assert_eq!(chat.provider, star.identity.did);
    assert_eq!(deltas, vec!["eco: ", "hola"]);
    assert_eq!(chat.content, "eco: hola");
    assert!(chat.dispatch_ms.is_some());

    let tool = client::call_tool(
        &navigator,
        ToolRequest {
            capability: "echo.upper".into(),
            tool_name: "upper".into(),
            arguments: dynamic::from_json(&json!({ "text": "fhs" })).unwrap(),
            // Con el preferido la subasta cierra en cuanto puja.
            preferred_provider: Some(star.identity.did.clone()),
            timeout: Duration::from_secs(20),
        },
    )
    .await
    .expect("misión de tool");
    assert_eq!(tool.provider, star.identity.did);
    assert_eq!(
        dynamic::to_json(&tool.result.unwrap()),
        json!({ "text": "FHS" })
    );

    // Nadie puja por una capacidad desconocida.
    let none = client::call_tool(
        &navigator,
        ToolRequest {
            capability: "nadie.la.tiene".into(),
            tool_name: "x".into(),
            arguments: dynamic::from_json(&json!({})).unwrap(),
            preferred_provider: None,
            timeout: Duration::from_secs(5),
        },
    )
    .await;
    assert!(matches!(none, Err(client::MissionError::NoBids(_))));
}
