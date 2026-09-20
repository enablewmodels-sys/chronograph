//! Machine-readable public REST contract. MCP and OpenAPI share input schemas.
use serde_json::{Value, json};

pub fn asset_metadata() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["version","kind","encoding"],"properties":{
        "version":{"type":"integer","const":1},"kind":{"enum":["tensor","opaque","image","audio","video"]},
        "encoding":{"type":"string","minLength":1,"maxLength":80},
        "dtype":{"enum":[null,"u8","i8","u16","u32","u64","i16","i32","i64","f16","bf16","f32","f64","bool"]},
        "shape":{"type":"array","maxItems":8,"items":{"type":"integer","minimum":1}},
        "provenance":{"type":"object","maxProperties":32,"additionalProperties":{"type":"string","maxLength":1024}}
    },"description":"Tensors require raw_le encoding, non-null dtype and exact row-major little-endian bytes. Scalars have shape []. Non-tensors require null/omitted dtype and empty/omitted shape. 1 byte to 16 MiB per composed asset."})
}
pub fn record() -> Value {
    let id = json!({"type":"string","pattern":"^[0-9]+$"});
    json!({"type":"object","additionalProperties":false,"required":["src","dst","timestamp_us","fields"],"properties":{
        "src":id,"dst":id,"timestamp_us":{"type":"string","pattern":"^-?[0-9]+$"},
        "valid_to":{"type":["string","null"],"pattern":"^-?[0-9]+$"},
        "episode":{"type":["string","null"],"minLength":1,"maxLength":128},
        "assets":{"type":"object","maxProperties":32,"additionalProperties":{"type":"string","pattern":"^[0-9a-f]{32}$"}},
        "fields":{"type":"object","maxProperties":64}
    },"description":"IDs are u64 strings; times are i64 microsecond strings in the binding's clock domain. Asset/field names are identifiers of at most 48 ASCII characters. Domain validation depends on the immutable connector binding."})
}
fn operation(
    name: &str,
    description: &str,
    scope: &str,
    schema: Option<Value>,
    binary: bool,
) -> Value {
    let success = if binary {
        json!({"application/octet-stream":{"schema":{"type":"string","format":"binary"}}})
    } else {
        json!({"application/json":{"schema":{"type":"object","additionalProperties":true}}})
    };
    let mut result = json!({"operationId":name,"description":description,"x-required-scope":scope,
        "responses":{"200":{"description":"Success. See API.md for operation-specific response fields.","content":success},"default":{"description":"Structured API error; 429/503 may include Retry-After. Proxies may return non-JSON bodies.","headers":{"Retry-After":{"schema":{"type":"string"}}},"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Error"}}}}}});
    if let Some(schema) = schema {
        result["requestBody"] =
            json!({"required":true,"content":{"application/json":{"schema":schema}}});
    }
    result
}
/// Export with `cargo run -p chronograph-server --example export_openapi`.
pub fn openapi() -> Value {
    let mut paths = serde_json::Map::new();
    for tool in crate::mcp::definitions() {
        let op = crate::operations::canonical(&tool.name);
        let scope = if matches!(op, "backup" | "schema_apply" | "load_demo") {
            "admin"
        } else if crate::operations::is_write(op) {
            "ingest"
        } else {
            "read"
        };
        paths.insert(format!("/v1/{op}"), json!({"post":operation(op,tool.description.as_deref().unwrap_or(""),scope,Some(json!(tool.input_schema)),false)}));
    }
    for (path, method, name, scope, binary, schema) in [
        ("/v1/info", "get", "info", "read", false, None),
        ("/v1/stats", "get", "stats_get", "read", false, None),
        ("/v1/metrics", "get", "metrics", "read", false, None),
        ("/v1/tokens", "get", "tokens", "admin", false, None),
        (
            "/v1/tokens",
            "post",
            "create_token",
            "admin",
            false,
            Some(
                json!({"type":"object","additionalProperties":false,"required":["name","scope","days"],"properties":{"name":{"type":"string","minLength":1,"maxLength":80},"scope":{"enum":["read","ingest","admin"]},"days":{"type":"integer","minimum":1,"maximum":365}}}),
            ),
        ),
        (
            "/v1/tokens/{id}",
            "delete",
            "revoke_token",
            "admin",
            false,
            None,
        ),
        ("/v1/backups", "get", "backups", "admin", false, None),
        (
            "/v1/backups/{id}",
            "get",
            "download_backup",
            "admin",
            true,
            None,
        ),
        (
            "/v1/backups/{id}",
            "delete",
            "delete_backup",
            "admin",
            false,
            None,
        ),
        (
            "/v1/export_arrow",
            "post",
            "export_arrow",
            "read",
            true,
            Some(
                json!({"type":"object","additionalProperties":false,"required":["t"],"properties":{"t":{"type":"string","pattern":"^-?[0-9]+$"},"fork":{"type":"string","pattern":"^[0-9]+$"}},"description":"Arrow IPC stream at t, optionally in a fork. Maximum 1M stored versions; configure the SDK response byte limit for large exports."}),
            ),
        ),
        (
            "/v1/load_demo",
            "post",
            "load_demo",
            "admin",
            false,
            Some(json!({"type":"object","additionalProperties":false})),
        ),
    ] {
        let mut entry = operation(name, name, scope, schema, binary);
        if name == "metrics" {
            entry["description"] =
                json!("Authenticated Prometheus operational metrics; counters reset on restart.");
            entry["responses"]["200"]["content"] =
                json!({"text/plain":{"schema":{"type":"string"}}});
        }
        if path.contains("{id}") {
            entry["parameters"] = json!([{"name":"id","in":"path","required":true,"schema":{"type":"string","pattern":"^[A-Za-z0-9_-]+$"}}]);
        }
        paths.entry(path).or_insert(json!({}))[method] = entry;
    }
    json!({"openapi":"3.1.0","info":{"title":"Chronograph Community API","version":env!("CARGO_PKG_VERSION"),"description":"REST v1 with decimal-string IDs and timestamps, scoped bearer authentication and bounded requests. Input schemas are shared with MCP. Responses remain extensible JSON objects; this specification is not a complete generated response type library."},
        "servers":[{"url":"http://127.0.0.1:8080","description":"Local development; use HTTPS remotely"}],
        "security":[{"bearerAuth":[]}],"paths":paths,
        "components":{"securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer"}},"schemas":{
            "AssetMetadata":asset_metadata(),"RecordV1":record(),
            "Error":{"type":"object","required":["error"],"properties":{"error":{"type":"object","required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"}}}}}
        }},"x-connector-catalog":crate::connectors::catalog()})
}
