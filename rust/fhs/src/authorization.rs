//! Autorización explícita por uso (SPEC-AUTH-0001, DEC-0099): digests canónicos.
//!
//! Todo digest es `SHA-256( dominio ‖ 0x00 ‖ versión ‖ 0x00 ‖ bytes_canónicos )`,
//! con un dominio distinto por clase de dato para que un digest no se pueda
//! reutilizar en otro contexto. Los fixtures de `galaxIA/idl/fixtures/` los
//! comparten Rust y TypeScript.

use sha2::{Digest, Sha256};

use crate::protocol::fhs::{dynamic_value::Kind, AuthorizationItem, DynamicValue};

/// Versión de la forma canónica; cambia solo con una nueva spec.
pub const DIGEST_VERSION: &str = "1";

pub const DOMAIN_USER_MESSAGE: &str = "fhs/auth/user_message";
pub const DOMAIN_DOCUMENT: &str = "fhs/auth/document";
pub const DOMAIN_DERIVED_TEXT: &str = "fhs/auth/derived_text";
pub const DOMAIN_COMMAND_ARGS: &str = "fhs/auth/command_args";
pub const DOMAIN_QUERY: &str = "fhs/auth/query";
pub const DOMAIN_TOOL_ARGS: &str = "fhs/auth/tool_args";
pub const DOMAIN_TOOL_OUTPUT: &str = "fhs/auth/tool_output";
pub const DOMAIN_IPFS: &str = "fhs/auth/ipfs";
pub const DOMAIN_BATCH: &str = "fhs/auth/batch";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DigestError {
    #[error("el valor no es canonizable: {0}")]
    NotCanonical(&'static str),
}

/// `SHA-256(dominio ‖ 0x00 ‖ versión ‖ 0x00 ‖ cuerpo)`.
pub fn framed(domain: &str, body: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(DIGEST_VERSION.as_bytes());
    hasher.update([0]);
    hasher.update(body);
    hasher.finalize().into()
}

fn push_len(out: &mut Vec<u8>, len: usize) {
    out.extend_from_slice(&(len as u32).to_be_bytes());
}

fn push_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    push_len(out, bytes.len());
    out.extend_from_slice(bytes);
}

/// Texto exacto en UTF-8, sin normalización Unicode adicional.
pub fn text_digest(domain: &str, text: &str) -> [u8; 32] {
    framed(domain, text.as_bytes())
}

pub fn user_message_digest(text: &str) -> [u8; 32] {
    text_digest(DOMAIN_USER_MESSAGE, text)
}

/// Los bytes reales de un archivo (no su descriptor).
pub fn document_digest(bytes: &[u8]) -> [u8; 32] {
    framed(DOMAIN_DOCUMENT, bytes)
}

/// Un archivo subido a IPFS: el CID y el digest de los bytes del contenido.
pub fn ipfs_digest(cid: &str, content: &[u8]) -> [u8; 32] {
    let mut body = Vec::new();
    push_bytes(&mut body, cid.as_bytes());
    push_bytes(&mut body, &document_digest(content));
    framed(DOMAIN_IPFS, &body)
}

/// Un conjunto de fragmentos, en el orden en que se envían, cada uno con su
/// longitud de 4 bytes.
pub fn chunks_digest(domain: &str, chunks: &[&str]) -> [u8; 32] {
    let mut body = Vec::new();
    push_len(&mut body, chunks.len());
    for chunk in chunks {
        push_bytes(&mut body, chunk.as_bytes());
    }
    framed(domain, &body)
}

/// Forma canónica de un valor dinámico (`cv1`): etiqueta de un byte y datos de
/// largo explícito; los objetos van con las claves ordenadas por sus bytes.
pub fn encode_value(value: &DynamicValue, out: &mut Vec<u8>) -> Result<(), DigestError> {
    match &value.kind {
        None => out.push(0x00),
        Some(Kind::BooleanValue(b)) => {
            out.push(0x01);
            out.push(u8::from(*b));
        }
        Some(Kind::IntegerValue(i)) => {
            out.push(0x02);
            out.extend_from_slice(&i.to_be_bytes());
        }
        Some(Kind::NumberValue(n)) => {
            if !n.is_finite() {
                return Err(DigestError::NotCanonical("número no finito"));
            }
            // -0.0 y 0.0 son el mismo número.
            let n = if *n == 0.0 { 0.0 } else { *n };
            out.push(0x03);
            out.extend_from_slice(&n.to_bits().to_be_bytes());
        }
        Some(Kind::StringValue(s)) => {
            out.push(0x04);
            push_bytes(out, s.as_bytes());
        }
        Some(Kind::BytesValue(b)) => {
            out.push(0x05);
            push_bytes(out, b);
        }
        Some(Kind::ListValue(list)) => {
            out.push(0x06);
            push_len(out, list.values.len());
            for item in &list.values {
                encode_value(item, out)?;
            }
        }
        Some(Kind::ObjectValue(object)) => {
            out.push(0x07);
            let mut keys: Vec<&String> = object.fields.keys().collect();
            keys.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            push_len(out, keys.len());
            for key in keys {
                push_bytes(out, key.as_bytes());
                encode_value(&object.fields[key], out)?;
            }
        }
        Some(Kind::ArtifactRef(_)) => {
            return Err(DigestError::NotCanonical(
                "un archivo se autoriza por el digest de sus bytes, no dentro de argumentos",
            ))
        }
    }
    Ok(())
}

/// Argumentos de herramienta o de comando (valores dinámicos).
pub fn value_digest(domain: &str, value: &DynamicValue) -> Result<[u8; 32], DigestError> {
    let mut body = Vec::new();
    encode_value(value, &mut body)?;
    Ok(framed(domain, &body))
}

/// Digest del lote: identifica exactamente lo que se le muestra al usuario.
pub fn batch_digest(
    authorization_id: &str,
    conversation_id: &str,
    turn_id: &str,
    expires_at: i64,
    items: &[AuthorizationItem],
) -> [u8; 32] {
    let mut body = Vec::new();
    push_bytes(&mut body, authorization_id.as_bytes());
    push_bytes(&mut body, conversation_id.as_bytes());
    push_bytes(&mut body, turn_id.as_bytes());
    push_bytes(&mut body, expires_at.to_string().as_bytes());
    let mut sorted: Vec<&AuthorizationItem> = items.iter().collect();
    sorted.sort_by(|a, b| a.item_id.as_bytes().cmp(b.item_id.as_bytes()));
    push_len(&mut body, sorted.len());
    for item in sorted {
        push_bytes(&mut body, item.item_id.as_bytes());
        push_bytes(&mut body, &item.payload_digest);
        push_bytes(&mut body, item.provider_did.as_bytes());
        push_bytes(&mut body, item.capability_id.as_bytes());
        push_bytes(&mut body, item.data_class.to_string().as_bytes());
        push_bytes(&mut body, item.destination.to_string().as_bytes());
        push_bytes(&mut body, item.retention.to_string().as_bytes());
        let mut deps: Vec<&String> = item.depends_on.iter().collect();
        deps.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        push_len(&mut body, deps.len());
        for dep in deps {
            push_bytes(&mut body, dep.as_bytes());
        }
    }
    framed(DOMAIN_BATCH, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::fhs::{DynamicList, DynamicObject};
    use std::collections::HashMap;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn string(s: &str) -> DynamicValue {
        DynamicValue {
            kind: Some(Kind::StringValue(s.into())),
        }
    }

    fn object(fields: Vec<(&str, DynamicValue)>) -> DynamicValue {
        DynamicValue {
            kind: Some(Kind::ObjectValue(DynamicObject {
                fields: fields
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v))
                    .collect::<HashMap<_, _>>(),
            })),
        }
    }

    #[test]
    fn domains_separate_the_same_bytes() {
        assert_ne!(
            text_digest(DOMAIN_USER_MESSAGE, "hola"),
            text_digest(DOMAIN_QUERY, "hola")
        );
        assert_ne!(user_message_digest("hola"), user_message_digest("hola "));
    }

    #[test]
    fn object_key_order_does_not_change_the_digest() {
        let a = object(vec![("expression", string("2+2")), ("zeta", string("z"))]);
        let b = object(vec![("zeta", string("z")), ("expression", string("2+2"))]);
        assert_eq!(
            value_digest(DOMAIN_COMMAND_ARGS, &a).unwrap(),
            value_digest(DOMAIN_COMMAND_ARGS, &b).unwrap()
        );
        let c = object(vec![("expression", string("2+3")), ("zeta", string("z"))]);
        assert_ne!(
            value_digest(DOMAIN_COMMAND_ARGS, &a).unwrap(),
            value_digest(DOMAIN_COMMAND_ARGS, &c).unwrap()
        );
    }

    #[test]
    fn numbers_and_lists_are_canonical_and_non_finite_is_rejected() {
        let zero = DynamicValue {
            kind: Some(Kind::NumberValue(0.0)),
        };
        let neg_zero = DynamicValue {
            kind: Some(Kind::NumberValue(-0.0)),
        };
        assert_eq!(
            value_digest(DOMAIN_TOOL_ARGS, &zero).unwrap(),
            value_digest(DOMAIN_TOOL_ARGS, &neg_zero).unwrap()
        );
        let nan = DynamicValue {
            kind: Some(Kind::NumberValue(f64::NAN)),
        };
        assert!(value_digest(DOMAIN_TOOL_ARGS, &nan).is_err());
        let list = |values: Vec<DynamicValue>| DynamicValue {
            kind: Some(Kind::ListValue(DynamicList { values })),
        };
        assert_ne!(
            value_digest(DOMAIN_TOOL_ARGS, &list(vec![string("a"), string("b")])).unwrap(),
            value_digest(DOMAIN_TOOL_ARGS, &list(vec![string("b"), string("a")])).unwrap()
        );
    }

    #[test]
    fn chunk_sets_depend_on_order_and_boundaries() {
        assert_ne!(
            chunks_digest(DOMAIN_DERIVED_TEXT, &["ab", "c"]),
            chunks_digest(DOMAIN_DERIVED_TEXT, &["a", "bc"])
        );
        assert_ne!(
            chunks_digest(DOMAIN_DERIVED_TEXT, &["a", "b"]),
            chunks_digest(DOMAIN_DERIVED_TEXT, &["b", "a"])
        );
    }

    #[test]
    fn batch_digest_covers_every_field_and_ignores_item_order() {
        let item = |id: &str, did: &str| AuthorizationItem {
            item_id: id.into(),
            capability_id: "document.ocr".into(),
            provider_did: did.into(),
            payload_digest: vec![7; 32],
            ..Default::default()
        };
        let base = batch_digest(
            "a1",
            "c1",
            "t1",
            1000,
            &[item("i1", "did:x"), item("i2", "did:y")],
        );
        let reordered = batch_digest(
            "a1",
            "c1",
            "t1",
            1000,
            &[item("i2", "did:y"), item("i1", "did:x")],
        );
        assert_eq!(base, reordered);
        assert_ne!(
            base,
            batch_digest(
                "a1",
                "c1",
                "t1",
                1000,
                &[item("i1", "did:z"), item("i2", "did:y")]
            )
        );
        assert_ne!(
            base,
            batch_digest(
                "a2",
                "c1",
                "t1",
                1000,
                &[item("i1", "did:x"), item("i2", "did:y")]
            )
        );
        assert_ne!(
            base,
            batch_digest(
                "a1",
                "c1",
                "t1",
                1001,
                &[item("i1", "did:x"), item("i2", "did:y")]
            )
        );
    }

    /// Los vectores de `galaxIA/idl/fixtures/authorization-digests.json` los
    /// comparten Rust y TypeScript. `WRITE_FIXTURES=<ruta>` los regenera.
    #[test]
    fn shared_fixtures() {
        let cases: Vec<(&str, String)> = vec![
            ("user_message:hola", hex(&user_message_digest("hola"))),
            (
                "user_message:unicode",
                hex(&user_message_digest(
                    "¿Qué es un Navigator? ñ 日本 \u{1F680}",
                )),
            ),
            ("document:bytes", hex(&document_digest(&[0, 1, 2, 3, 255]))),
            (
                "ipfs:cid",
                hex(&ipfs_digest(
                    "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
                    b"contenido",
                )),
            ),
            (
                "derived_text:chunks",
                hex(&chunks_digest(
                    DOMAIN_DERIVED_TEXT,
                    &["primer fragmento", "segundo ñandú"],
                )),
            ),
            (
                "command_args:expression",
                hex(&value_digest(
                    DOMAIN_COMMAND_ARGS,
                    &object(vec![("expression", string("(12+8)*3^2/4"))]),
                )
                .unwrap()),
            ),
            (
                "tool_args:mixed",
                hex(&value_digest(
                    DOMAIN_TOOL_ARGS,
                    &object(vec![
                        (
                            "zeta",
                            DynamicValue {
                                kind: Some(Kind::IntegerValue(-5)),
                            },
                        ),
                        (
                            "alfa",
                            DynamicValue {
                                kind: Some(Kind::NumberValue(1.5)),
                            },
                        ),
                        (
                            "beta",
                            DynamicValue {
                                kind: Some(Kind::BooleanValue(true)),
                            },
                        ),
                        (
                            "lista",
                            DynamicValue {
                                kind: Some(Kind::ListValue(DynamicList {
                                    values: vec![string("x"), string("y")],
                                })),
                            },
                        ),
                    ]),
                )
                .unwrap()),
            ),
            (
                "batch:two_items",
                hex(&batch_digest(
                    "auth-1",
                    "conv-1",
                    "turn-1",
                    1_790_000_000_000,
                    &[
                        AuthorizationItem {
                            item_id: "b".into(),
                            capability_id: "document.ocr".into(),
                            provider_did: "did:key:zOCR".into(),
                            payload_digest: document_digest(b"pdf").to_vec(),
                            data_class: 3,
                            destination: 2,
                            retention: 1,
                            ..Default::default()
                        },
                        AuthorizationItem {
                            item_id: "a".into(),
                            capability_id: "document.index".into(),
                            provider_did: "did:key:zRAG".into(),
                            payload_digest: text_digest(DOMAIN_DERIVED_TEXT, "texto").to_vec(),
                            data_class: 2,
                            destination: 2,
                            retention: 2,
                            depends_on: vec!["b".into()],
                            ..Default::default()
                        },
                    ],
                )),
            ),
        ];
        let json = format!(
            "{{\n  \"version\": \"{DIGEST_VERSION}\",\n  \"cases\": {{\n{}\n  }}\n}}\n",
            cases
                .iter()
                .map(|(name, digest)| format!("    \"{name}\": \"{digest}\""))
                .collect::<Vec<_>>()
                .join(",\n")
        );
        if let Ok(path) = std::env::var("WRITE_FIXTURES") {
            std::fs::write(path, &json).unwrap();
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../galaxIA/idl/fixtures/authorization-digests.json");
        if let Ok(committed) = std::fs::read_to_string(&path) {
            assert_eq!(committed, json, "los fixtures compartidos no coinciden");
        }
    }
}
