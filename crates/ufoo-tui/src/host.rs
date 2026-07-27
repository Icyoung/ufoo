//! Unix socket host client (blocking reader thread + shared writer).

use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::json;

use crate::protocol::{self, Envelope, BINARY_VERSION, PROTOCOL};

pub struct HostClient {
    writer: Arc<Mutex<UnixStream>>,
    pub rx: Receiver<HostEvent>,
}

#[derive(Debug)]
pub enum HostEvent {
    Envelope(Envelope),
    Disconnected,
}

impl HostClient {
    pub fn connect(socket_path: &Path) -> std::io::Result<Self> {
        let mut stream = UnixStream::connect(socket_path)?;
        stream.set_nonblocking(false)?;
        protocol::write_envelope(
            &mut stream,
            &json!({
                "protocol": PROTOCOL,
                "kind": "hello",
                "name": "",
                "payload": protocol::hello_payload(),
            }),
        )?;

        // One BufReader for handshake + ongoing reads so buffered bytes after
        // welcome are not lost across clones.
        let writer_stream = stream.try_clone()?;
        writer_stream.set_read_timeout(None)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut reader = BufReader::new(stream);

        match protocol::read_envelope_line(&mut reader)? {
            Some(welcome) if welcome.protocol == PROTOCOL && welcome.kind == "welcome" => {}
            Some(other) if other.kind == "error" => {
                let msg = other
                    .payload
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("handshake rejected");
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    msg,
                ));
            }
            Some(other) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unexpected handshake: {}", other.kind),
                ));
            }
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "empty welcome",
                ));
            }
        }
        // Clear handshake timeout on the underlying stream via writer clone;
        // reader owns the original fd.
        let _ = writer_stream.set_read_timeout(None);

        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("ufoo-ui-reader".into())
            .spawn(move || reader_loop(reader, tx))
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;

        Ok(Self {
            writer: Arc::new(Mutex::new(writer_stream)),
            rx,
        })
    }

    pub fn send_command(
        &self,
        name: &str,
        request_id: &str,
        payload: serde_json::Value,
    ) -> std::io::Result<()> {
        let mut guard = self
            .writer
            .lock()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "writer lock poisoned"))?;
        protocol::write_command(&mut guard, name, request_id, payload)
    }

    pub fn try_recv(&self) -> Option<HostEvent> {
        self.rx.try_recv().ok()
    }
}

fn reader_loop(mut reader: BufReader<UnixStream>, tx: Sender<HostEvent>) {
    loop {
        match protocol::read_envelope_line(&mut reader) {
            Ok(Some(env)) => {
                if tx.send(HostEvent::Envelope(env)).is_err() {
                    break;
                }
            }
            Ok(None) => {
                let _ = tx.send(HostEvent::Disconnected);
                break;
            }
            Err(_) => {
                let _ = tx.send(HostEvent::Disconnected);
                break;
            }
        }
    }
}

pub fn protocol_probe(socket_path: &Path) -> std::io::Result<i32> {
    let mut stream = UnixStream::connect(socket_path)?;
    stream.set_nonblocking(false)?;
    protocol::write_envelope(
        &mut stream,
        &json!({
            "protocol": PROTOCOL,
            "kind": "hello",
            "name": "",
            "payload": protocol::hello_payload(),
        }),
    )?;
    let mut reader = BufReader::new(stream);
    match protocol::read_envelope_line(&mut reader)? {
        Some(welcome) if welcome.protocol == PROTOCOL && welcome.kind == "welcome" => {
            println!("ufoo-tui protocol-probe ok version={BINARY_VERSION}");
            Ok(0)
        }
        Some(other) if other.kind == "error" => {
            eprintln!(
                "ufoo-tui: handshake rejected: {}",
                other
                    .payload
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unauthorized")
            );
            Ok(2)
        }
        Some(other) => {
            eprintln!("ufoo-tui: unexpected welcome: {:?}", other);
            Ok(2)
        }
        None => Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "empty welcome",
        )),
    }
}
