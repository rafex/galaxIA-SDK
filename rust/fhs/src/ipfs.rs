//! Cliente de la API RPC de un nodo Kubo **local** (DEC-0095): el Navigator
//! sube y libera adjuntos, el OCR los lee. Solo feature `ipfs`.
//!
//! Reglas de seguridad:
//! - `IPFS_API_URL` pasa por [`parse_api_url`]: `http`, host literal
//!   `127.0.0.1` o `[::1]`, puerto explícito, sin ruta, usuario ni consulta.
//! - Sin proxy ni redirecciones; argumentos como parámetros de consulta.
//! - El token *bearer* se lee de archivo y viaja como cabecera sensible (no
//!   aparece en `Debug` ni en logs).
//! - Todo CID se canoniza ([`canonical_cid`], CIDv1 base32) antes de llamar.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::multipart::{Form, Part};
use serde::Deserialize;

pub const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Perfil de `add` congelado: el CID calculado con `only-hash` debe ser el
/// mismo que el del `add` real.
const ADD_PROFILE: &[(&str, &str)] = &[
    ("cid-version", "1"),
    ("hash", "sha2-256"),
    ("chunker", "size-262144"),
    ("raw-leaves", "true"),
    ("trickle", "false"),
    ("wrap-with-directory", "false"),
    ("inline", "false"),
    ("progress", "false"),
];

#[derive(Debug, thiserror::Error)]
pub enum KuboError {
    #[error("IPFS_API_URL inválida: {0}")]
    Url(String),
    #[error("token de la API de IPFS: {0}")]
    Token(String),
    #[error("CID inválido: {0}")]
    Cid(String),
    #[error("Kubo no respondió: {0}")]
    Http(String),
    #[error("Kubo respondió {status}: {message}")]
    Api { status: u16, message: String },
    #[error("respuesta de Kubo inesperada: {0}")]
    Parse(String),
    #[error("el contenido supera {0} bytes")]
    TooLarge(usize),
}

impl KuboError {
    fn http(error: reqwest::Error) -> Self {
        // Sin la URL: lleva el CID, que no hace falta repetir en el log.
        KuboError::Http(error.without_url().to_string())
    }
}

/// Valida `IPFS_API_URL` y devuelve la base sin barra final.
pub fn parse_api_url(raw: &str) -> Result<String, KuboError> {
    let bad = |why: &str| KuboError::Url(format!("{raw}: {why}"));
    let rest = raw
        .strip_prefix("http://")
        .ok_or_else(|| bad("solo se admite http:// hacia loopback"))?;
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.contains(['/', '?', '#', '@']) {
        return Err(bad("sin ruta, consulta ni usuario"));
    }
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (host, port) = v6.split_once("]:").ok_or_else(|| bad("puerto explícito"))?;
        (host, port)
    } else {
        authority
            .rsplit_once(':')
            .ok_or_else(|| bad("puerto explícito"))?
    };
    if host != "127.0.0.1" && host != "::1" {
        return Err(bad("el host debe ser 127.0.0.1 o [::1] literal"));
    }
    let port: u16 = port.parse().map_err(|_| bad("puerto inválido"))?;
    if port == 0 {
        return Err(bad("puerto inválido"));
    }
    Ok(if host == "::1" {
        format!("http://[::1]:{port}")
    } else {
        format!("http://127.0.0.1:{port}")
    })
}

/// CID válido en su forma canónica (CIDv1, base32 minúscula).
pub fn canonical_cid(raw: &str) -> Result<String, KuboError> {
    let cid = cid::Cid::try_from(raw.trim()).map_err(|e| KuboError::Cid(format!("{raw}: {e}")))?;
    let v1 = if cid.version() == cid::Version::V0 {
        cid::Cid::new_v1(cid.codec(), *cid.hash())
    } else {
        cid
    };
    v1.to_string_of_base(multibase::Base::Base32Lower)
        .map_err(|e| KuboError::Cid(e.to_string()))
}

pub struct KuboClient {
    base: String,
    auth: HeaderValue,
    http: reqwest::Client,
}

impl std::fmt::Debug for KuboClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KuboClient")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct AddResponse {
    #[serde(rename = "Hash")]
    hash: String,
}

#[derive(Deserialize)]
struct ApiError {
    #[serde(rename = "Message")]
    message: String,
}

#[derive(Deserialize)]
struct PinLs {
    #[serde(rename = "Keys", default)]
    keys: std::collections::HashMap<String, serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
pub struct RepoStat {
    #[serde(rename = "RepoSize")]
    pub repo_size: u64,
    #[serde(rename = "StorageMax")]
    pub storage_max: u64,
}

#[derive(Deserialize)]
struct DiagSys {
    diskinfo: DiskInfo,
}

#[derive(Deserialize)]
struct DiskInfo {
    free_space: u64,
}

#[derive(Deserialize)]
struct SwarmPeers {
    #[serde(rename = "Peers", default)]
    peers: Option<Vec<SwarmPeer>>,
}

#[derive(Deserialize)]
struct SwarmPeer {
    #[serde(rename = "Peer")]
    peer: String,
}

#[derive(Deserialize)]
struct Id {
    #[serde(rename = "ID")]
    id: String,
}

impl KuboClient {
    /// `url` pasa por [`parse_api_url`]; `token_file` tiene el token *bearer*.
    pub fn new(url: &str, token_file: &Path) -> Result<Self, KuboError> {
        let token = std::fs::read_to_string(token_file)
            .map_err(|e| KuboError::Token(format!("{}: {e}", token_file.display())))?;
        Self::with_token(url, token.trim())
    }

    pub fn with_token(url: &str, token: &str) -> Result<Self, KuboError> {
        let base = parse_api_url(url)?;
        if token.is_empty() {
            return Err(KuboError::Token("vacío".into()));
        }
        let mut auth = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| KuboError::Token("caracteres inválidos".into()))?;
        auth.set_sensitive(true);
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(CALL_TIMEOUT)
            .build()
            .map_err(KuboError::http)?;
        Ok(Self { base, auth, http })
    }

    async fn call(
        &self,
        command: &str,
        query: &[(&str, &str)],
        form: Option<Form>,
    ) -> Result<reqwest::Response, KuboError> {
        let mut request = self
            .http
            .post(format!("{}/api/v0/{command}", self.base))
            .header(AUTHORIZATION, self.auth.clone())
            .query(query);
        if let Some(form) = form {
            request = request.multipart(form);
        }
        let response = request.send().await.map_err(KuboError::http)?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<ApiError>(&body)
            .map(|e| e.message)
            .unwrap_or_else(|_| body.chars().take(200).collect());
        Err(KuboError::Api {
            status: status.as_u16(),
            message,
        })
    }

    async fn json<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        query: &[(&str, &str)],
    ) -> Result<T, KuboError> {
        let body = self
            .call(command, query, None)
            .await?
            .bytes()
            .await
            .map_err(KuboError::http)?;
        serde_json::from_slice(&body).map_err(|e| KuboError::Parse(format!("{command}: {e}")))
    }

    /// `add` con el perfil congelado. `pin=false, only_hash=true` calcula el
    /// CID sin guardar nada. Devuelve el CID canónico.
    pub async fn add(&self, bytes: Vec<u8>, only_hash: bool) -> Result<String, KuboError> {
        let mut query: Vec<(&str, &str)> = ADD_PROFILE.to_vec();
        query.push(("only-hash", if only_hash { "true" } else { "false" }));
        query.push(("pin", if only_hash { "false" } else { "true" }));
        let form = Form::new().part("file", Part::bytes(bytes).file_name("blob"));
        let body = self
            .call("add", &query, Some(form))
            .await?
            .text()
            .await
            .map_err(KuboError::http)?;
        let last = body
            .lines()
            .rfind(|l| !l.trim().is_empty())
            .ok_or_else(|| KuboError::Parse("add sin respuesta".into()))?;
        let added: AddResponse =
            serde_json::from_str(last).map_err(|e| KuboError::Parse(format!("add: {e}")))?;
        canonical_cid(&added.hash)
    }

    /// Quita el pin recursivo. Idempotente: "no fijado" cuenta como éxito.
    pub async fn pin_rm(&self, cid: &str) -> Result<(), KuboError> {
        let cid = canonical_cid(cid)?;
        match self
            .call("pin/rm", &[("arg", &cid), ("recursive", "true")], None)
            .await
        {
            Ok(_) => Ok(()),
            Err(KuboError::Api { message, .. }) if message.contains("not pinned") => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// CIDs fijados de un tipo (`recursive` o `direct`), canónicos.
    pub async fn pin_ls(&self, kind: &str) -> Result<HashSet<String>, KuboError> {
        let pins: PinLs = self.json("pin/ls", &[("type", kind)]).await?;
        pins.keys.keys().map(|cid| canonical_cid(cid)).collect()
    }

    pub async fn repo_stat(&self) -> Result<RepoStat, KuboError> {
        self.json("repo/stat", &[("size-only", "true")]).await
    }

    /// Espacio libre del filesystem del repositorio de Kubo.
    pub async fn free_space(&self) -> Result<u64, KuboError> {
        let sys: DiagSys = self.json("diag/sys", &[]).await?;
        Ok(sys.diskinfo.free_space)
    }

    pub async fn id(&self) -> Result<String, KuboError> {
        let id: Id = self.json("id", &[]).await?;
        Ok(id.id)
    }

    /// PeerIDs conectados.
    pub async fn swarm_peers(&self) -> Result<HashSet<String>, KuboError> {
        let peers: SwarmPeers = self.json("swarm/peers", &[]).await?;
        Ok(peers
            .peers
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.peer)
            .collect())
    }

    /// Lee el contenido de `cid` con un tope; al superarlo se descarta lo
    /// leído y se devuelve [`KuboError::TooLarge`].
    pub async fn cat(&self, cid: &str, max_bytes: usize) -> Result<Vec<u8>, KuboError> {
        let cid = canonical_cid(cid)?;
        let limit = (max_bytes + 1).to_string();
        let mut response = self
            .call("cat", &[("arg", &cid), ("length", &limit)], None)
            .await?;
        let mut out = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(KuboError::http)? {
            if out.len() + chunk.len() > max_bytes {
                return Err(KuboError::TooLarge(max_bytes));
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn api_url_must_be_literal_loopback_http_with_port() {
        assert_eq!(
            parse_api_url("http://127.0.0.1:5001").unwrap(),
            "http://127.0.0.1:5001"
        );
        assert_eq!(
            parse_api_url("http://127.0.0.1:5001/").unwrap(),
            "http://127.0.0.1:5001"
        );
        assert_eq!(
            parse_api_url("http://[::1]:5001").unwrap(),
            "http://[::1]:5001"
        );
        for bad in [
            "https://127.0.0.1:5001",
            "http://localhost:5001",
            "http://192.168.1.139:5001",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:5001/api",
            "http://127.0.0.1:5001?x=1",
            "http://user@127.0.0.1:5001",
            "http://127.0.0.1.nip.io:5001",
            "127.0.0.1:5001",
        ] {
            assert!(parse_api_url(bad).is_err(), "{bad} debió rechazarse");
        }
    }

    #[test]
    fn cids_are_canonicalized_to_v1_base32() {
        let v1 = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
        assert_eq!(canonical_cid(v1).unwrap(), v1);
        assert_eq!(
            canonical_cid("QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn").unwrap(),
            "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354"
        );
        for bad in ["", "zzz", "../../config", "bafy?arg=x"] {
            assert!(canonical_cid(bad).is_err(), "{bad}");
        }
    }

    /// Servidor HTTP mínimo: responde siempre lo mismo y guarda las
    /// peticiones recibidas.
    async fn mock(status: &'static str, body: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 64 * 1024];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[..n]).into_owned());
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nlocation: http://127.0.0.1:9/x\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        (url, seen)
    }

    #[tokio::test]
    async fn sends_bearer_token_and_frozen_add_profile() {
        let (url, seen) = mock(
            "200 OK",
            r#"{"Name":"blob","Hash":"bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku","Size":"0"}"#,
        )
        .await;
        let client = KuboClient::with_token(&url, "secreto").unwrap();
        assert!(!format!("{client:?}").contains("secreto"));
        let cid = client.add(vec![], true).await.unwrap();
        assert_eq!(
            cid,
            "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
        );
        let request = seen.lock().unwrap()[0].clone();
        assert!(request.starts_with("POST /api/v0/add?cid-version=1&hash=sha2-256&chunker=size-262144&raw-leaves=true&trickle=false&wrap-with-directory=false&inline=false&progress=false&only-hash=true&pin=false "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer secreto"));
        assert!(request.contains("filename=\"blob\""));
    }

    #[tokio::test]
    async fn pin_rm_of_an_unpinned_cid_is_success() {
        let (url, _) = mock(
            "500 Internal Server Error",
            r#"{"Message":"not pinned or pinned indirectly","Code":0,"Type":"error"}"#,
        )
        .await;
        let client = KuboClient::with_token(&url, "t").unwrap();
        client
            .pin_rm("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn invalid_cid_never_reaches_kubo() {
        let (url, seen) = mock("200 OK", "{}").await;
        let client = KuboClient::with_token(&url, "t").unwrap();
        assert!(matches!(
            client.pin_rm("../config").await,
            Err(KuboError::Cid(_))
        ));
        assert!(matches!(
            client.cat("nada", 10).await,
            Err(KuboError::Cid(_))
        ));
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let (url, seen) = mock("307 Temporary Redirect", "").await;
        let client = KuboClient::with_token(&url, "t").unwrap();
        assert!(matches!(
            client.id().await,
            Err(KuboError::Api { status: 307, .. })
        ));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn empty_pin_ls_and_cat_limit() {
        let (url, _) = mock("200 OK", "{}").await;
        let client = KuboClient::with_token(&url, "t").unwrap();
        assert!(client.pin_ls("direct").await.unwrap().is_empty());
        let (url, _) = mock("200 OK", "0123456789").await;
        let client = KuboClient::with_token(&url, "t").unwrap();
        let cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
        assert_eq!(client.cat(cid, 10).await.unwrap(), b"0123456789");
        assert!(matches!(
            client.cat(cid, 9).await,
            Err(KuboError::TooLarge(9))
        ));
    }
}
