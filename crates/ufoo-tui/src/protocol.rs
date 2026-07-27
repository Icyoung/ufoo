//! ufoo-ui/1 newline-delimited JSON envelopes.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::os::unix::net::UnixStream;

pub const PROTOCOL: &str = "ufoo-ui/1";
pub const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub protocol: String,
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(default)]
    pub payload: serde_json::Value,
}

pub fn write_envelope(stream: &mut UnixStream, envelope: &serde_json::Value) -> io::Result<()> {
    let mut line =
        serde_json::to_string(envelope).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    line.push('\n');
    stream.write_all(line.as_bytes())?;
    stream.flush()
}

pub fn write_command(
    stream: &mut UnixStream,
    name: &str,
    request_id: &str,
    payload: serde_json::Value,
) -> io::Result<()> {
    write_envelope(
        stream,
        &json!({
            "protocol": PROTOCOL,
            "kind": "command",
            "name": name,
            "request_id": request_id,
            "payload": payload,
        }),
    )
}

pub fn read_envelope_line(reader: &mut impl BufRead) -> io::Result<Option<Envelope>> {
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        // Blank NDJSON lines are ignorable padding, not EOF.
        if line.trim().is_empty() {
            continue;
        }
        let env: Envelope = serde_json::from_str(line.trim())
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        return Ok(Some(env));
    }
}

pub fn hello_payload() -> serde_json::Value {
    let mut payload = json!({
        "supported_protocols": [PROTOCOL],
        "binary_version": BINARY_VERSION,
        "capabilities": [
            "fullscreen",
            "chat",
            "scrollback",
            "prompt",
            "multi-frames-v1"
        ]
    });
    if let Ok(token) = std::env::var("UFOO_UI_TOKEN") {
        if !token.is_empty() {
            payload["auth_token"] = json!(token);
        }
    }
    payload
}
