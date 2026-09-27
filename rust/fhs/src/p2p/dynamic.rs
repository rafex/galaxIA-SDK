//! JSON ↔ `DynamicValue` (argumentos y resultados de tools), con las mismas
//! reglas que `dynamicValueFromLocal` / `dynamicValueToJson` de `fhs-wire`:
//! enteros y decimales se distinguen, `null` no se admite y un `ArtifactRef`
//! se ve en JSON como `{transport: "inline", base64, filename}` o
//! `{transport: "ipfs", cid, network, gatewayUrl, filename, retention}`.

use std::collections::HashMap;

use base64::Engine;
use serde_json::{Map, Number, Value};

use crate::protocol::fhs::{
    artifact_ref::Transport, dynamic_value::Kind, ArtifactRef, DynamicList, DynamicObject,
    DynamicValue, InlineArtifact, IpfsArtifact,
};

const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("DynamicValue no admite null (en {0})")]
pub struct NullNotAllowed(pub String);

pub fn from_json(value: &Value) -> Result<DynamicValue, NullNotAllowed> {
    from_json_at(value, "$")
}

fn from_json_at(value: &Value, path: &str) -> Result<DynamicValue, NullNotAllowed> {
    let kind = match value {
        Value::Null => return Err(NullNotAllowed(path.to_string())),
        Value::Bool(b) => Kind::BooleanValue(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) if n.is_i64() => Kind::IntegerValue(i),
            _ => Kind::NumberValue(n.as_f64().unwrap_or_default()),
        },
        Value::String(s) => Kind::StringValue(s.clone()),
        Value::Array(items) => Kind::ListValue(DynamicList {
            values: items
                .iter()
                .enumerate()
                .map(|(i, item)| from_json_at(item, &format!("{path}[{i}]")))
                .collect::<Result<_, _>>()?,
        }),
        Value::Object(_) if artifact_from_json(value).is_some() => {
            Kind::ArtifactRef(artifact_from_json(value).unwrap_or_default())
        }
        Value::Object(map) => Kind::ObjectValue(DynamicObject {
            fields: map
                .iter()
                .map(|(k, v)| Ok((k.clone(), from_json_at(v, &format!("{path}.{k}"))?)))
                .collect::<Result<HashMap<_, _>, NullNotAllowed>>()?,
        }),
    };
    Ok(DynamicValue { kind: Some(kind) })
}

pub fn to_json(value: &DynamicValue) -> Value {
    match &value.kind {
        None => Value::Null,
        Some(Kind::BooleanValue(b)) => Value::Bool(*b),
        Some(Kind::IntegerValue(i)) => Value::Number((*i).into()),
        Some(Kind::NumberValue(f)) => Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Some(Kind::StringValue(s)) => Value::String(s.clone()),
        Some(Kind::BytesValue(bytes)) => Value::String(BASE64.encode(bytes)),
        Some(Kind::ListValue(list)) => Value::Array(list.values.iter().map(to_json).collect()),
        Some(Kind::ObjectValue(object)) => {
            let mut map = Map::new();
            let mut keys: Vec<&String> = object.fields.keys().collect();
            keys.sort();
            for key in keys {
                map.insert(key.clone(), to_json(&object.fields[key]));
            }
            Value::Object(map)
        }
        Some(Kind::ArtifactRef(artifact)) => artifact_to_json(artifact),
    }
}

/// `ArtifactRef` → JSON local de `fhs-wire` (`artifactRefFromProto`).
pub fn artifact_to_json(artifact: &ArtifactRef) -> Value {
    let mut map = Map::new();
    let mut put = |key: &str, value: &str| {
        if !value.is_empty() {
            map.insert(key.into(), Value::String(value.into()));
        }
    };
    match &artifact.transport {
        Some(Transport::Inline(inline)) => {
            put("transport", "inline");
            put("filename", &inline.filename);
            map.insert("base64".into(), Value::String(BASE64.encode(&inline.data)));
        }
        Some(Transport::Ipfs(ipfs)) => {
            put("transport", "ipfs");
            put("cid", &ipfs.cid);
            put("network", &ipfs.network);
            put("gatewayUrl", &ipfs.gateway_url);
            put("filename", &ipfs.filename);
            let retention = if ipfs.retention == "reuse" {
                "reuse"
            } else {
                "ephemeral"
            };
            put("retention", retention);
        }
        None => return Value::Null,
    }
    Value::Object(map)
}

/// JSON local → `ArtifactRef`, si `transport` es `inline` o `ipfs`
/// (`isArtifactRef` + `artifactRefToProto` de `fhs-wire`).
pub fn artifact_from_json(value: &Value) -> Option<ArtifactRef> {
    let text = |key: &str| value[key].as_str().unwrap_or_default().to_string();
    let transport = match value["transport"].as_str()? {
        "inline" => Transport::Inline(InlineArtifact {
            data: BASE64.decode(text("base64")).ok()?,
            filename: text("filename"),
        }),
        "ipfs" => Transport::Ipfs(IpfsArtifact {
            cid: text("cid"),
            network: text("network"),
            gateway_url: text("gatewayUrl"),
            filename: text("filename"),
            retention: match value["retention"].as_str() {
                Some("reuse") => "reuse".into(),
                _ => "ephemeral".into(),
            },
        }),
        _ => return None,
    };
    Some(ArtifactRef {
        transport: Some(transport),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    #[test]
    fn roundtrips_json_with_integers_and_decimals_apart() {
        let json = serde_json::json!({"entero": 3, "decimal": 0.25, "texto": "sí", "lista": [1, "dos"], "ok": true});
        let value = from_json(&json).unwrap();
        assert_eq!(to_json(&value), json);
    }

    #[test]
    fn rejects_null_with_its_path() {
        assert_eq!(
            from_json(&serde_json::json!({"a": [1, null]})),
            Err(NullNotAllowed("$.a[1]".into()))
        );
    }

    #[test]
    fn decodes_the_ts_fixtures_to_the_same_json() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/wire.json")).unwrap();
        for entry in fixtures["dynamic_values"].as_array().unwrap() {
            let bytes = hex::decode(entry["bytes_hex"].as_str().unwrap()).unwrap();
            let value = DynamicValue::decode(bytes.as_slice()).unwrap();
            assert_eq!(to_json(&value), entry["json"], "{}", entry["name"]);
        }
    }

    #[test]
    fn artifacts_travel_as_the_ts_local_shape() {
        let json = serde_json::json!({
            "file": {"transport": "inline", "base64": "aG9sYQ==", "filename": "a.pdf"},
            "lang": "spa"
        });
        let value = from_json(&json).unwrap();
        let Some(Kind::ObjectValue(object)) = &value.kind else {
            panic!("objeto")
        };
        let Some(Kind::ArtifactRef(artifact)) = &object.fields["file"].kind else {
            panic!("el archivo debe viajar como ArtifactRef")
        };
        let Some(Transport::Inline(inline)) = &artifact.transport else {
            panic!("inline")
        };
        assert_eq!(inline.data, b"hola");
        assert_eq!(to_json(&value), json);

        let ipfs = serde_json::json!({"transport": "ipfs", "cid": "bafy", "network": "public", "retention": "ephemeral"});
        assert_eq!(to_json(&from_json(&ipfs).unwrap()), ipfs);
        // Un objeto con otro `transport` sigue siendo un objeto.
        let other = serde_json::json!({"transport": "tcp"});
        assert_eq!(to_json(&from_json(&other).unwrap()), other);
    }
}
