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
            allowed_provider_dids: None,
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
            extra_capabilities: vec![],
            tool_name: "upper".into(),
            arguments: dynamic::from_json(&json!({ "text": "fhs" })).unwrap(),
            // Con el preferido la subasta cierra en cuanto puja.
            preferred_provider: Some(star.identity.did.clone()),
            mission_id: None,
            allowed_provider_dids: None,
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

    // Una capacidad extra que el provider no ofrece: su puja no cubre todo.
    let partial = client::call_tool(
        &navigator,
        ToolRequest {
            capability: "echo.upper".into(),
            extra_capabilities: vec!["ipfs.native.public".into()],
            tool_name: "upper".into(),
            arguments: dynamic::from_json(&json!({ "text": "fhs" })).unwrap(),
            preferred_provider: Some(star.identity.did.clone()),
            mission_id: None,
            allowed_provider_dids: None,
            timeout: Duration::from_secs(20),
        },
    )
    .await;
    assert!(matches!(partial, Err(client::MissionError::NoBids(_))));

    // Nadie puja por una capacidad desconocida.
    let none = client::call_tool(
        &navigator,
        ToolRequest {
            capability: "nadie.la.tiene".into(),
            extra_capabilities: vec![],
            tool_name: "x".into(),
            arguments: dynamic::from_json(&json!({})).unwrap(),
            preferred_provider: None,
            mission_id: None,
            allowed_provider_dids: None,
            timeout: Duration::from_secs(5),
        },
    )
    .await;
    assert!(matches!(none, Err(client::MissionError::NoBids(_))));
}

#[tokio::test(flavor = "multi_thread")]
async fn late_subscriber_gets_current_advertises_from_the_bootstrap() {
    let atlas = start(Role::Bootstrap, vec![]);
    let atlas_addr = listen_addr(&atlas).await;
    let identity = NodeIdentity::from_keypair(Keypair::generate_ed25519()).unwrap();
    let beacon = galaxia_fhs::p2p::wire::provider_beacon(
        &identity.did,
        galaxia_fhs::protocol::fhs::ProviderType::Satellite,
        "tardío",
        "",
        &["echo.upper"],
        vec![],
    );
    let did = identity.did.clone();
    let _provider = node::start(NodeConfig {
        role: Role::Provider,
        agent_version: "galaxia-fhs-test".into(),
        identity,
        listen: vec!["/ip4/127.0.0.1/tcp/0/ws".parse().unwrap()],
        announce: vec![],
        bootstrap: vec![atlas_addr.clone()],
        tls: tls::websocket_config(None, None, &[]).unwrap(),
        advertise: Some(beacon),
        dht_beacon: None,
    })
    .unwrap();
    // Que el anuncio llegue a Atlas antes de que exista el suscriptor.
    for _ in 0..50 {
        if atlas.peers.get(&did).is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        atlas.peers.get(&did).is_some(),
        "Atlas no recibió el anuncio"
    );

    // El siguiente anuncio periódico sería en ~30 s; debe llegar mucho antes.
    let navigator = start(Role::Navigator, vec![atlas_addr]);
    let started = std::time::Instant::now();
    while navigator.peers.get(&did).is_none() {
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "el suscriptor tardío no recibió el anuncio vigente"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn changed_beacon_is_announced_right_away() {
    let atlas = start(Role::Bootstrap, vec![]);
    let atlas_addr = listen_addr(&atlas).await;
    let identity = NodeIdentity::from_keypair(Keypair::generate_ed25519()).unwrap();
    let did = identity.did.clone();
    let beacon = |caps: &[&str]| {
        galaxia_fhs::p2p::wire::provider_beacon(
            &did,
            galaxia_fhs::protocol::fhs::ProviderType::Satellite,
            "ocr",
            "",
            caps,
            vec![],
        )
    };
    let provider = node::start(NodeConfig {
        role: Role::Provider,
        agent_version: "galaxia-fhs-test".into(),
        identity,
        listen: vec!["/ip4/127.0.0.1/tcp/0/ws".parse().unwrap()],
        announce: vec![],
        bootstrap: vec![atlas_addr.clone()],
        tls: tls::websocket_config(None, None, &[]).unwrap(),
        advertise: Some(beacon(&["document.ocr"])),
        dht_beacon: None,
    })
    .unwrap();
    let navigator = start(Role::Navigator, vec![atlas_addr]);
    let caps_seen = |caps: &[&str]| {
        navigator
            .peers
            .get(&did)
            .is_some_and(|p| p.capabilities == caps)
    };
    let started = std::time::Instant::now();
    while !caps_seen(&["document.ocr"]) {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "sin anuncio inicial"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // El siguiente anuncio periódico sería en ~30 s: el cambio no espera.
    provider.set_advertise_beacon(beacon(&["document.ocr", "ipfs.native.public"]));
    let started = std::time::Instant::now();
    while !caps_seen(&["document.ocr", "ipfs.native.public"]) {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "el cambio de capacidades no se anunció de inmediato"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
