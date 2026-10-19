use crate::Res;
use crate::config::{Config, LABEL, MAC, Paths, locations, plist, pretty, shell_quote, tunnel_args};
use crate::process::{DEFAULT_TIMEOUT, capture, run, strings, uid};
use serde_json::{Map, Value, json};
use std::fs;
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

pub fn private_write(file: &Path, text: impl AsRef<[u8]>, mode: u32) -> Res<()> {
    let fail = |error: std::io::Error| format!("{}: {error}", file.display());
    if let Some(parent) = file.parent() {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(parent).map_err(fail)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
    let mut out =
        fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(&temporary).map_err(fail)?;
    out.write_all(text.as_ref()).map_err(fail)?;
    fs::rename(&temporary, file).map_err(fail)?;
    fs::set_permissions(file, fs::Permissions::from_mode(mode)).map_err(fail)
}

/// Direct SSH to WSL (not through the tunnel), for setup and status.
fn ssh(config: &Config, script: &str) -> Res<String> {
    let mut args = strings([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ConnectTimeout=10",
    ]);
    args.extend([config.host.clone(), "/bin/sh -s".into()]);
    run("/usr/bin/ssh", &args, Some(script), DEFAULT_TIMEOUT)
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, byte)| n | u32::from(*byte) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { BASE64[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// Windows OpenSSH runs commands in Windows PowerShell; -EncodedCommand avoids nested quoting.
pub fn powershell(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!("powershell -NoProfile -NonInteractive -EncodedCommand {}", base64(&utf16))
}

pub fn windows_ssh_args(config: &Config, command: &str) -> Res<Vec<String>> {
    let windows =
        config.windows.as_ref().ok_or("Add \"windows\": {} to the config and run windows/setup.ps1 first.")?;
    let mut args = strings([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ConnectTimeout=10",
        "-p",
    ]);
    args.extend([windows.port.to_string(), windows.host.clone(), command.into()]);
    Ok(args)
}

fn windows_reachable(config: &Config) -> bool {
    let Ok(args) = windows_ssh_args(config, "exit") else { return false };
    capture("/usr/bin/ssh", &args, None, Duration::from_secs(20)).is_ok_and(|output| output.status == Some(0))
}

/// Last crash dump, keep-alive state and distro states, then restart the keep-alive task.
/// WSL starts from Task Scheduler, outside this SSH session's job, so it survives the
/// session closing (Windows sshd kills the processes a session starts).
pub const RECOVER_SCRIPT: &str = r#"$f = Get-ChildItem "$env:LOCALAPPDATA\Temp\wsl-crashes" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
if ($f) { "last crash: $($f.Name) $($f.LastWriteTime.ToString('s'))" } else { 'last crash: none' }
$i = Get-ScheduledTaskInfo -TaskName 'WSL keep-alive' -ErrorAction SilentlyContinue
if ($i) { "keep-alive: last run $($i.LastRunTime.ToString('s')), result 0x$($i.LastTaskResult.ToString('X'))" } else { 'keep-alive: task missing; run windows/setup.ps1' }
$env:WSL_UTF8 = '1'
wsl.exe -l -v | Where-Object { $_.Trim() }
Enable-ScheduledTask -TaskName 'WSL keep-alive' | Out-Null
Start-ScheduledTask -TaskName 'WSL keep-alive'
"#;

fn tcp_ready(port: u16, timeout: Duration) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), timeout).is_ok()
}

/// Runs on WSL, so every check crosses the tunnel the way agents use it. Checks run
/// in parallel, so a down service costs its own timeout, not the sum.
pub fn probe_script(config: &Config) -> String {
    let mut checks = Vec::new();
    if let Some(app) = &config.app {
        checks.push(format!(
            "{{ code=$(curl -s -o /dev/null -w '%{{http_code}}' --max-time 3 http://127.0.0.1:{}/ || true)
case \"$code\" in [1-5][0-9][0-9]) echo 'app ready';; *) echo 'app unavailable';; esac; }} &",
            app.remote_port
        ));
    }
    if let Some(login) = &config.mac_login {
        checks.push(format!(
            "{{ if timeout 8 ssh -F \"$HOME/.config/remote-access/mac-ssh.conf\" {} uname -s 2>/dev/null | grep -qx Darwin; then echo 'macLogin ready'; else echo 'macLogin unavailable'; fi; }} &",
            shell_quote(&login.address)
        ));
    }
    checks.push("wait".into());
    checks.join("\n")
}

fn launchctl(args: &[String]) -> Res<String> {
    run("/bin/launchctl", args, None, DEFAULT_TIMEOUT)
}

fn agent_state(name: &str) -> &'static str {
    match launchctl(&[String::from("print"), format!("gui/{}/{name}", uid())]) {
        Ok(output) if output.contains("state = running") => "running",
        Ok(_) => "restarting",
        Err(_) => "not loaded",
    }
}

pub struct Report {
    pub json: Value,
    pub healthy: bool,
}

pub fn status(config: &Config) -> Report {
    let probe = probe_script(config);
    // Separates "Windows down" (laptop off or offline) from "WSL down" (recover).
    let (windows, output) = thread::scope(|scope| {
        let windows = (MAC && config.windows.is_some()).then(|| scope.spawn(|| windows_reachable(config)));
        let output =
            if MAC { ssh(config, &probe) } else { run("/bin/sh", &strings(["-s"]), Some(&probe), DEFAULT_TIMEOUT) };
        (windows.map(|check| check.join().unwrap_or(false)), output)
    });
    let found: Vec<(String, String)> = output
        .as_deref()
        .unwrap_or("")
        .lines()
        .filter_map(|line| line.split_once(' ').map(|(name, state)| (name.into(), state.into())))
        .collect();
    let mut services = Map::new();
    for name in config.service_names() {
        let state = found.iter().find(|(found, _)| found == name).map_or("unavailable", |(_, state)| state.as_str());
        services.insert(name.into(), state.into());
    }
    let mut healthy = services.values().all(|state| state == "ready" || state == "available");
    let mut report = json!({ "side": if MAC { "mac" } else { "wsl" }, "host": config.host, "services": services });
    if MAC {
        let tunnel = agent_state(LABEL);
        healthy &= tunnel == "running";
        report["agents"] = json!({ "tunnel": tunnel });
    }
    if let Some(ready) = windows {
        healthy &= ready;
        report["windows"] = (if ready { "ready" } else { "unavailable" }).into();
    }
    if let Err(error) = output {
        report["error"] = error.into();
    }
    Report { json: report, healthy }
}

/// Human-readable status, with what to do when WSL is down.
pub fn status_text(report: &Value) -> String {
    let mut lines =
        vec![format!("{} → {}", report["side"].as_str().unwrap_or(""), report["host"].as_str().unwrap_or(""))];
    for group in ["agents", "services"] {
        if let Some(states) = report[group].as_object() {
            lines.extend(states.iter().map(|(name, state)| format!("  {name}: {}", state.as_str().unwrap_or(""))));
        }
    }
    let windows = report["windows"].as_str();
    if let Some(windows) = windows {
        lines.push(format!("  windows: {windows}"));
    }
    if let Some(error) = report["error"].as_str() {
        lines.push(format!("  error: {error}"));
        if let Some(windows) = windows {
            lines.push(format!(
                "  {}",
                if windows == "ready" {
                    "WSL down, Windows up: run remote-access recover"
                } else {
                    "Windows unreachable too: laptop off, asleep or offline"
                }
            ));
        }
    }
    lines.join("\n")
}

fn ssh_public_key(text: &str) -> String {
    text.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
}

/// authorized_keys with any old line for this key replaced by a Tailscale-only entry.
fn authorize(existing: &[u8], key: &str) -> Vec<u8> {
    let mut text: Vec<u8> = existing
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty() && !line.windows(key.len()).any(|window| window == key.as_bytes()))
        .flat_map(|line| line.iter().copied().chain([b'\n']))
        .collect();
    let options = "from=\"100.64.0.0/10\",no-agent-forwarding,no-port-forwarding,no-X11-forwarding";
    text.extend(format!("{options} {key} remote-access-mac\n").as_bytes());
    text
}

fn provision_mac_login(config: &Config, home: &Path) -> Res<()> {
    let Some(login) = &config.mac_login else { return Ok(()) };
    // The private key lives only on WSL. Pin the Mac's host key rather than trusting on first use.
    let host_key = ssh_public_key(
        &fs::read_to_string("/etc/ssh/ssh_host_ed25519_key.pub").map_err(|error| format!("Mac host key: {error}"))?,
    );
    let key = ssh_public_key(&ssh(
        config,
        r#"set -eu
umask 077; mkdir -p "$HOME/.config/remote-access"
key="$HOME/.config/remote-access/mac_ed25519"
[ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -C remote-access-mac -f "$key"
cat "$key.pub"
"#,
    )?);
    let valid = key
        .strip_prefix("ssh-ed25519 ")
        .is_some_and(|body| !body.is_empty() && body.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)));
    if !valid {
        return Err("WSL returned an invalid SSH public key.".into());
    }
    // WSL connects only over Tailscale (100.64.0.0/10).
    let authorized = home.join(".ssh/authorized_keys");
    // Kept as bytes so other keys survive whatever encoding their comments use.
    let existing = match fs::read(&authorized) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("{}: {error}; not changing it.", authorized.display())),
    };
    private_write(&authorized, authorize(&existing, &key), 0o600)?;
    // Connection reuse turns each helper call's ~0.2s handshake into ~0.03s.
    let mac_config = format!(
        "Host {0}\n  HostName {0}\n  User {1}\n  IdentityFile ~/.config/remote-access/mac_ed25519\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ~/.config/remote-access/mac_known_hosts\n  ConnectTimeout 5\n  ControlMaster auto\n  ControlPath ~/.config/remote-access/cm-%C\n  ControlPersist 10m\n",
        login.address, login.user
    );
    ssh(
        config,
        &format!(
            "set -eu; umask 077; cd \"$HOME/.config/remote-access\"\nprintf %s {} > mac-ssh.conf\nprintf '%s\\n' {} > mac_known_hosts\n",
            shell_quote(&mac_config),
            shell_quote(&format!("{} {host_key}", login.address))
        ),
    )?;
    Ok(())
}

fn domain() -> String {
    format!("gui/{}", uid())
}

fn plist_file(paths: &Paths) -> PathBuf {
    paths.agents.join(format!("{LABEL}.plist"))
}

fn loaded() -> bool {
    launchctl(&[String::from("print"), format!("{}/{LABEL}", domain())]).is_ok()
}

fn pause(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

/// bootout returns before launchd finishes unloading; wait so a following bootstrap does not fail.
pub fn stop() -> Res<()> {
    if loaded() {
        launchctl(&[String::from("bootout"), format!("{}/{LABEL}", domain())])?;
        for _ in 0..40 {
            if !loaded() {
                break;
            }
            pause(250);
        }
    }
    Ok(())
}

/// launchd can still answer "Bootstrap failed: 5" briefly after an unload.
pub fn start(home: &Path) -> Res<()> {
    let file = plist_file(&locations(home, true));
    if !file.exists() || loaded() {
        return Ok(());
    }
    let args = [String::from("bootstrap"), domain(), file.display().to_string()];
    for attempt in 0.. {
        match launchctl(&args) {
            Ok(_) => break,
            Err(error) if attempt < 10 && error.contains(": 5:") => pause(500),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub fn install(config: &Config, home: &Path) -> Res<Value> {
    if !MAC {
        return Err("Install on your Mac. WSL uses status, mac, open, install-helpers and skills-sync.".into());
    }
    let paths = locations(home, true);
    ssh(config, "true\n")?;
    if config.mac_login.is_some() && !tcp_ready(22, Duration::from_secs(2)) {
        return Err("Enable Mac Remote Login in System Settings → General → Sharing, then retry.".into());
    }
    provision_mac_login(config, home)?;
    stop()?;

    let saved = format!("{}\n", pretty(&config.to_json()));
    private_write(&paths.config, &saved, 0o600)?;
    let log = paths.directory.join("tunnel.log").display().to_string();
    let mut program = vec![String::from("/usr/bin/ssh")];
    program.extend(tunnel_args(config));
    private_write(&plist_file(&paths), plist(LABEL, &program, &log), 0o644)?;
    start(home)?;

    let ready = (0..40).any(|_| {
        pause(500);
        agent_state(LABEL) == "running"
            && config.app.as_ref().is_none_or(|app| tcp_ready(app.local_port, Duration::from_secs(2)))
    });
    if !ready {
        return Err(format!("Tunnel not ready. See {log}."));
    }

    ssh(
        config,
        &format!(
            "set -eu; umask 077; cd \"$HOME/.config/remote-access\"\nprintf %s {} > config.json\n",
            shell_quote(&saved)
        ),
    )?;
    let report = status(config).json;
    if report["services"]["macLogin"] == "unavailable" {
        return Err("Mac SSH from WSL failed; check Remote Login allows this account.".into());
    }
    Ok(report)
}

pub fn recover(config: &Config, timeout: Duration) -> Res<()> {
    let args = windows_ssh_args(config, &powershell(RECOVER_SCRIPT))?;
    let output = capture("/usr/bin/ssh", &args, None, Duration::from_secs(60));
    // ssh exits 255 for its own failures; any other nonzero status is the script's.
    let output = match output {
        Ok(output) if output.status != Some(255) && !output.timed_out => output,
        failed => {
            let detail = match failed {
                Ok(output) if output.timed_out => "timed out".into(),
                Ok(output) => output.stderr.trim().to_owned(),
                Err(error) => error.to_string(),
            };
            return Err(format!("Windows SSH unreachable ({detail}); the laptop is off, asleep or offline."));
        }
    };
    if !output.stdout.trim().is_empty() {
        crate::say(output.stdout.trim());
    }
    if output.status != Some(0) {
        let detail = match output.stderr.trim() {
            "" => format!("exit {}", output.status.map_or("signal".into(), |code| code.to_string())),
            stderr => stderr.into(),
        };
        return Err(format!("Recover script failed on Windows: {detail}"));
    }
    let started = Instant::now();
    while ssh(config, "true\n").is_err() {
        if started.elapsed() > timeout {
            return Err(format!("WSL SSH still down after {}s.", timeout.as_secs()));
        }
        pause(3000);
    }
    crate::say(format!("WSL SSH: ready after {}s", started.elapsed().as_secs_f64().round()));
    Ok(())
}

pub fn uninstall(home: &Path) -> Res<()> {
    stop()?;
    match fs::remove_file(plist_file(&locations(home, true))) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::validate;

    fn config(extra: Value) -> Config {
        let mut input = json!({ "version": 1, "host": "laptop.ts.net", "services": {
            "app": { "localPort": 8080, "remotePort": 8080 }, "macLogin": { "user": "me", "address": "mac" } } });
        input["windows"] = extra;
        validate(&input).unwrap()
    }

    #[test]
    fn base64_matches_known_answers() {
        for (input, expected) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
    }

    #[test]
    fn recover_runs_an_encoded_powershell_script_against_the_windows_port() {
        // "A" in UTF-16LE is 41 00.
        assert_eq!(powershell("A"), "powershell -NoProfile -NonInteractive -EncodedCommand QQA=");
        assert!(RECOVER_SCRIPT.contains(r"Temp\wsl-crashes"));
        // A disabled task makes Start-ScheduledTask fail, so enable it first.
        assert!(RECOVER_SCRIPT.contains(
            "Enable-ScheduledTask -TaskName 'WSL keep-alive' | Out-Null\nStart-ScheduledTask -TaskName 'WSL keep-alive'"
        ));
        let command = powershell(RECOVER_SCRIPT);
        let args = windows_ssh_args(&config(json!({})), &command).unwrap();
        assert_eq!(args[args.len() - 4..], ["-p".into(), "2222".into(), "laptop.ts.net".into(), command]);
        assert!(args.contains(&"BatchMode=yes".into()));
        assert!(windows_ssh_args(&config(Value::Null), "exit").is_err());
    }

    #[test]
    fn probe_runs_checks_in_parallel_and_reports_one_line_each() {
        let script = probe_script(&config(Value::Null));
        assert_eq!(script.matches("} &").count(), 2);
        assert!(script.ends_with("\nwait"));
        let output = run("/bin/sh", &strings(["-n"]), Some(&script), DEFAULT_TIMEOUT);
        assert!(output.is_ok(), "{output:?}");
    }

    #[test]
    fn status_text_points_at_recover_only_when_windows_is_up() {
        let report = json!({ "side": "mac", "host": "wsl", "services": { "app": "unavailable" },
            "agents": { "tunnel": "running" }, "windows": "ready", "error": "ssh failed: timeout" });
        assert_eq!(
            status_text(&report),
            "mac → wsl\n  tunnel: running\n  app: unavailable\n  windows: ready\n  error: ssh failed: timeout\n  WSL down, Windows up: run remote-access recover"
        );
    }

    #[test]
    fn authorize_keeps_other_keys_byte_for_byte_and_replaces_this_one() {
        let existing = b"ssh-rsa AAA caf\xe9\nold ssh-ed25519 KEY remote-access-mac\n\nssh-ed25519 OTHER";
        let text = authorize(existing, "ssh-ed25519 KEY");
        let expected: &[u8] = b"ssh-rsa AAA caf\xe9\nssh-ed25519 OTHER\nfrom=\"100.64.0.0/10\",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 KEY remote-access-mac\n";
        assert_eq!(text, expected);
    }

    #[test]
    fn private_write_replaces_atomically_with_the_given_mode() {
        let file = std::env::temp_dir().join(format!("remote-access-test-{}/nested/file", std::process::id()));
        private_write(&file, "one", 0o600).unwrap();
        private_write(&file, "two", 0o644).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "two");
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o644);
        fs::remove_dir_all(file.parent().unwrap().parent().unwrap()).unwrap();
    }
}
