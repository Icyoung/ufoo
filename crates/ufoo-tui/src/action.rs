//! Elm-style Action / Effect for chat + ucode surfaces.

use crossterm::event::KeyEvent;

use crate::protocol::Envelope;

#[derive(Debug, Clone)]
pub enum Action {
    Key(KeyEvent),
    Paste(String),
    MouseClick { column: u16, row: u16 },
    /// Positive = scroll up (older), negative = scroll down (newer).
    MouseScroll { lines: i32 },
    Host(Envelope),
    HostDisconnected,
    Tick,
}

#[derive(Debug, Clone)]
pub enum Effect {
    SendCommand {
        name: String,
        request_id: String,
        payload: serde_json::Value,
    },
    Exit(i32),
}
