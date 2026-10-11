//! Clipboard output belongs to the TTY process, never to agent prompts or bus messages.

use std::io::{self, Write};

use base64::{engine::general_purpose::STANDARD, Engine};

pub fn copy(text: &str, output: &mut impl Write) -> io::Result<()> {
    // Prefer the system clipboard for a local macOS session, independently of
    // terminal-specific OSC 52 permissions. Remote sessions target their terminal.
    #[cfg(target_os = "macos")]
    if std::env::var_os("SSH_TTY").is_none()
        && std::env::var_os("SSH_CONNECTION").is_none()
        && copy_macos(text).is_ok()
    {
        return Ok(());
    }
    // The payload is encoded: copied terminal text cannot inject escape codes.
    write!(output, "{}", osc52(text))?;
    output.flush()
}

fn osc52(text: &str) -> String {
    format!("\x1b]52;c;{}\x07", STANDARD.encode(text.as_bytes()))
}

#[cfg(target_os = "macos")]
fn copy_macos(text: &str) -> io::Result<()> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let text = text.to_owned();
    // A stalled helper must not block the TUI on pipe backpressure.
    let writer = std::thread::spawn(move || stdin.write_all(text.as_bytes()));
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let written = writer
                    .join()
                    .map_err(|_| io::Error::other("clipboard writer failed"))?;
                written?;
                return if status.success() {
                    Ok(())
                } else {
                    Err(io::Error::other("clipboard write failed"))
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = writer.join();
                return Err(result.err().unwrap_or_else(|| {
                    io::Error::new(io::ErrorKind::TimedOut, "clipboard write timed out")
                }));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc52_round_trips_unicode_multiline_text_without_terminal_injection() {
        let text = "你好🙂\n  code\x1b]52;c;hostile\x07";
        let output = osc52(text);
        let payload = output
            .strip_prefix("\x1b]52;c;")
            .unwrap()
            .strip_suffix('\x07')
            .unwrap();
        assert!(!payload.contains('\x1b'));
        assert_eq!(STANDARD.decode(payload).unwrap(), text.as_bytes());
    }
}
