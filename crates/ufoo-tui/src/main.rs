//! ufoo-tui — Rust TTY UI for ufoo chat / ucode (ufoo-ui/1).

mod action;
mod chat;
mod dispatch;
mod draw;
mod host;
mod model;
mod protocol;

use std::path::PathBuf;
use std::process;

use clap::{Parser, ValueEnum};

use crate::chat::{restore_terminal, run_surface, Surface as ChatSurface};
use crate::host::protocol_probe;
use crate::protocol::BINARY_VERSION;

#[derive(Debug, Clone, ValueEnum)]
enum Surface {
    Chat,
    Ucode,
    Probe,
}

#[derive(Debug, Parser)]
#[command(name = "ufoo-tui", version = BINARY_VERSION, about = "ufoo Rust TUI")]
struct Args {
    /// UI control socket path (ufoo-ui/1 newline JSON).
    #[arg(long)]
    ui_socket: Option<PathBuf>,

    /// Active surface.
    #[arg(long, value_enum, default_value = "chat")]
    surface: Surface,

    /// Protocol handshake only; exit after hello/welcome exchange.
    #[arg(long)]
    protocol_probe: bool,
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        restore_terminal();
        eprintln!("ufoo-tui panic: {info}");
    }));

    let args = Args::parse();
    let result = if args.protocol_probe {
        match args.ui_socket.as_ref() {
            Some(path) => protocol_probe(path),
            None => {
                eprintln!("ufoo-tui: --protocol-probe requires --ui-socket");
                Ok(2)
            }
        }
    } else {
        let surface = match args.surface {
            Surface::Chat => ChatSurface::Chat,
            Surface::Ucode => ChatSurface::Ucode,
            Surface::Probe => ChatSurface::Probe,
        };
        run_surface(surface, args.ui_socket)
    };

    match result {
        Ok(code) => {
            if code != 0 {
                restore_terminal();
            }
            process::exit(code);
        }
        Err(err) => {
            restore_terminal();
            eprintln!("ufoo-tui error: {err}");
            process::exit(1);
        }
    }
}
