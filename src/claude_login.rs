use crate::Res;
use crate::config::{MAC, locations, read_config, shell_quote};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

fn login_url(text: &str) -> Option<&str> {
    [
        "https://claude.com/cai/oauth/authorize?",
        "https://claude.ai/oauth/authorize?",
        "https://platform.claude.com/oauth/authorize?",
    ]
    .iter()
    .find_map(|prefix| {
        let start = text.find(prefix)?;
        let rest = &text[start..];
        let end = rest.find(|c: char| c.is_whitespace() || c.is_control())?;
        Some(&rest[..end])
    })
}

pub fn login(home: &Path, email: Option<&str>) -> Res<i32> {
    let paths = locations(home, MAC);
    let mut command = if MAC {
        let host = read_config(&paths)?.host;
        // No remote browser means Claude uses its hosted code callback, avoiding
        // a localhost callback that would land on the wrong machine.
        let mut remote = "stty -echo; BROWSER=false claude auth login --claudeai".to_owned();
        if let Some(email) = email {
            remote.push_str(&format!(" --email {}", shell_quote(email)));
        }
        let mut ssh = Command::new("/usr/bin/ssh");
        ssh.args([
            "-tt",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            &host,
            &remote,
        ]);
        ssh
    } else {
        let mut claude = Command::new("claude");
        claude.env("BROWSER", "false").args(["auth", "login", "--claudeai"]);
        if let Some(email) = email {
            claude.args(["--email", email]);
        }
        claude
    };
    crate::say("Approve the Claude sign-in in your Mac browser, then paste its code into this terminal.");
    let mut child = command
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Cannot start Claude login: {e}"))?;
    let result = (|| -> Res<i32> {
        let mut stream = child.stdout.take().expect("piped");
        let mut pending = Vec::new();
        let mut opened = false;
        let mut buffer = [0; 4096];
        loop {
            let read = stream.read(&mut buffer).map_err(|e| format!("Cannot read login output: {e}"))?;
            if read == 0 {
                break;
            }
            std::io::stdout().write_all(&buffer[..read]).map_err(|e| e.to_string())?;
            let _ = std::io::stdout().flush();
            if !opened {
                pending.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&pending);
                if let Some(url) = login_url(&text) {
                    let result = if MAC {
                        Command::new("/usr/bin/open")
                            .arg(url)
                            .status()
                            .map_err(|e| e.to_string())
                            .and_then(|s| if s.success() { Ok(()) } else { Err("Browser opener failed".into()) })
                    } else {
                        crate::open::open_on_mac(url, &paths, Duration::from_secs(15))
                    };
                    if let Err(error) = result {
                        eprintln!("Could not open your browser: {error}. Open the URL above manually.");
                    }
                    opened = true;
                    pending.clear();
                } else if pending.len() > 65536 {
                    pending.drain(..pending.len() - 32768);
                }
            }
        }
        child.wait().map(|s| s.code().unwrap_or(1)).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_hyperlinks_and_waits_for_complete_urls() {
        let url = "https://claude.com/cai/oauth/authorize?code=true&state=example";
        assert_eq!(login_url(&format!("\x1b]8;;{url}\x07label\x1b]8;;\x07")), Some(url));
        assert_eq!(login_url(url), None);
        assert_eq!(login_url(&format!("Visit: {url}\r\n")), Some(url));
        assert_eq!(login_url("https://example.com/oauth/authorize?a=b\n"), None);
    }
}
