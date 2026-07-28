//! Chat / ucode fullscreen event loop.

use std::io;
use std::path::PathBuf;
use std::time::Duration;

use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyEventKind, MouseButton, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::cursor::{Hide, Show};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::action::{Action, Effect};
use crate::dispatch::{dispatch, multi_viewport_effects_public};
use crate::draw;
use crate::host::{HostClient, HostEvent};
use crate::model::AppState;

pub enum Surface {
    Chat,
    Ucode,
    Probe,
}

pub fn run_surface(surface: Surface, ui_socket: Option<PathBuf>) -> io::Result<i32> {
    let (title, surface_name) = match surface {
        Surface::Chat => (" 🛸 UFOO ", "chat"),
        Surface::Ucode => (" 🛸 UFOO ", "ucode"),
        Surface::Probe => ("ufoo-tui probe", "probe"),
    };
    let mut state = AppState::new(title, surface_name);

    let host = match ui_socket.as_ref() {
        Some(path) => Some(HostClient::connect(path)?),
        None => {
            state.status = "no --ui-socket (local-only keys)".into();
            None
        }
    };

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableBracketedPaste,
        EnableMouseCapture,
        Hide
    )?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    if let Ok(size) = terminal.size() {
        state.multi.term_cols = size.width;
        state.multi.term_rows = size.height;
    }

    let mut exit_code = 0;
    loop {
        let mut had_work = false;
        if let Some(client) = host.as_ref() {
            while let Some(evt) = client.try_recv() {
                had_work = true;
                let action = match evt {
                    HostEvent::Envelope(env) => Action::Host(env),
                    HostEvent::Disconnected => Action::HostDisconnected,
                };
                let effects = dispatch(&mut state, action);
                if let Some(code) = apply_effects(client, &effects)? {
                    exit_code = code;
                    state.exit_requested = true;
                }
            }
        }

        let tick_effects = dispatch(&mut state, Action::Tick);
        if !tick_effects.is_empty() {
            had_work = true;
        }
        if let Some(client) = host.as_ref() {
            if let Some(code) = apply_effects(client, &tick_effects)? {
                exit_code = code;
                state.exit_requested = true;
            }
        }

        if state.dirty || had_work {
            let mut cursor = None;
            terminal.draw(|frame| {
                cursor = draw::draw(frame, &mut state);
                if let Some((x, y)) = cursor {
                    frame.set_cursor_position((x, y));
                }
            })?;
            // IME / CJK preedit follows the hardware caret. Keep it visible when
            // we positioned it inside the prompt; otherwise hide so it cannot
            // paint past the footer and scroll a ghost agent bar.
            if cursor.is_some() {
                execute!(terminal.backend_mut(), Show)?;
            } else {
                execute!(terminal.backend_mut(), Hide)?;
            }
            state.dirty = false;
        }

        if state.exit_requested {
            break;
        }

        if event::poll(Duration::from_millis(40))? {
            match event::read()? {
                Event::Key(key) => {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }
                    let effects = dispatch(&mut state, Action::Key(key));
                    if let Some(client) = host.as_ref() {
                        if let Some(code) = apply_effects(client, &effects)? {
                            exit_code = code;
                            state.exit_requested = true;
                        }
                    } else if effects.iter().any(|e| matches!(e, Effect::Exit(_))) {
                        exit_code = 0;
                        state.exit_requested = true;
                    }
                }
                Event::Paste(text) => {
                    let effects = dispatch(&mut state, Action::Paste(text));
                    if let Some(client) = host.as_ref() {
                        let _ = apply_effects(client, &effects)?;
                    }
                }
                Event::Mouse(mouse) => {
                    let action = match mouse.kind {
                        MouseEventKind::Down(MouseButton::Left) => Some(Action::MouseClick {
                            column: mouse.column,
                            row: mouse.row,
                        }),
                        MouseEventKind::ScrollUp => Some(Action::MouseScroll { lines: 3 }),
                        MouseEventKind::ScrollDown => Some(Action::MouseScroll { lines: -3 }),
                        _ => None,
                    };
                    if let Some(action) = action {
                        let effects = dispatch(&mut state, action);
                        if let Some(client) = host.as_ref() {
                            let _ = apply_effects(client, &effects)?;
                        }
                    }
                }
                Event::Resize(w, h) => {
                    state.multi.term_cols = w;
                    state.multi.term_rows = h;
                    state.mark_dirty();
                    if state.multi.active {
                        let effects = multi_viewport_effects_public(&mut state);
                        if let Some(client) = host.as_ref() {
                            let _ = apply_effects(client, &effects)?;
                        }
                    }
                }
                _ => {}
            }
        }
    }

    restore_terminal_full(&mut terminal)?;
    Ok(exit_code)
}

fn apply_effects(client: &HostClient, effects: &[Effect]) -> io::Result<Option<i32>> {
    let mut exit = None;
    for effect in effects {
        match effect {
            Effect::SendCommand {
                name,
                request_id,
                payload,
            } => {
                client.send_command(name, request_id, payload.clone())?;
            }
            Effect::Exit(code) => exit = Some(*code),
        }
    }
    Ok(exit)
}

fn restore_terminal_full(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> io::Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableBracketedPaste,
        DisableMouseCapture,
        Show
    )?;
    terminal.show_cursor()?;
    Ok(())
}

pub fn restore_terminal() {
    let _ = disable_raw_mode();
    let mut stdout = io::stdout();
    let _ = execute!(
        stdout,
        LeaveAlternateScreen,
        DisableBracketedPaste,
        DisableMouseCapture,
        Show
    );
}
