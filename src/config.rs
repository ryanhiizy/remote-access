use crate::Res;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const LABEL: &str = "io.github.ryanhiizy.remote-access";
pub const MAC: bool = cfg!(target_os = "macos");

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn xml(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn home() -> Res<PathBuf> {
    std::env::var_os("HOME").filter(|home| !home.is_empty()).map(PathBuf::from).ok_or_else(|| "HOME is not set.".into())
}

pub struct Paths {
    pub directory: PathBuf,
    pub config: PathBuf,
    pub ssh_config: PathBuf,
    pub agents: PathBuf,
}

pub fn locations(home: &Path, mac: bool) -> Paths {
    let directory =
        if mac { home.join("Library/Application Support/remote-access") } else { home.join(".config/remote-access") };
    Paths {
        config: directory.join("config.json"),
        ssh_config: directory.join("mac-ssh.conf"),
        agents: home.join("Library/LaunchAgents"),
        directory,
    }
}

pub struct App {
    pub local_port: u16,
    pub remote_port: u16,
}

pub struct MacLogin {
    pub user: String,
    pub address: String,
}

pub struct Windows {
    pub host: String,
    pub port: u16,
}

/// host: the WSL machine's Tailscale name (or an SSH alias for it).
/// windows: optional Windows OpenSSH on the same machine, the way in when WSL is down.
pub struct Config {
    pub host: String,
    pub app: Option<App>,
    pub mac_login: Option<MacLogin>,
    pub windows: Option<Windows>,
}

// Hostnames and usernames reach ssh and remote shells, so they never start with "-"
// and contain no shell or option syntax.
pub fn is_hostname(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || ".:_-".contains(c))
}

pub fn is_username(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn truthy(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64() != Some(0.0),
        _ => true,
    })
}

fn port(value: Option<&Value>, minimum: u16, name: &str) -> Res<u16> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.fract() == 0.0 && *number >= f64::from(minimum) && *number <= 65535.0)
        .map(|number| number as u16)
        .ok_or_else(|| format!("{name} must be an integer from {minimum} to 65535."))
}

fn text(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

pub fn validate(input: &Value) -> Res<Config> {
    let host = text(input.get("host"));
    if input.get("version").and_then(Value::as_f64) != Some(1.0) || !is_hostname(host) {
        return Err("Use version 1 and host set to the WSL Tailscale name.".into());
    }
    let services = input.get("services");
    let app = match truthy(services.and_then(|s| s.get("app"))) {
        Some(app) => Some(App {
            local_port: port(app.get("localPort"), 1024, "app.localPort")?,
            remote_port: port(app.get("remotePort"), 1024, "app.remotePort")?,
        }),
        None => None,
    };
    // WSL reaches the Mac's own sshd directly over Tailscale; no forward needed.
    let mac_login = match truthy(services.and_then(|s| s.get("macLogin"))) {
        Some(login) => {
            let (user, address) = (text(login.get("user")), text(login.get("address")));
            if !is_username(user) || !is_hostname(address) {
                return Err("macLogin needs user (Mac username) and address (Mac Tailscale name).".into());
            }
            Some(MacLogin { user: user.into(), address: address.into() })
        }
        None => None,
    };
    if app.is_none() && mac_login.is_none() {
        return Err("Enable app, macLogin or both.".into());
    }
    let windows = match truthy(input.get("windows")) {
        Some(windows) => {
            let host = match windows.get("host") {
                None | Some(Value::Null) => host,
                Some(value) => text(Some(value)),
            };
            let port = match windows.get("port") {
                None | Some(Value::Null) => 2222,
                value => port(value, 1, "windows.port")?,
            };
            if !is_hostname(host) {
                return Err("windows.host must be the Windows Tailscale name or an SSH alias.".into());
            }
            // Mirrored networking shares ports with WSL, whose sshd owns 22.
            if port == 22 {
                return Err("windows.port must not be 22; WSL sshd uses it.".into());
            }
            Some(Windows { host: host.into(), port })
        }
        None => None,
    };
    Ok(Config { host: host.into(), app, mac_login, windows })
}

impl Config {
    pub fn to_json(&self) -> Value {
        let mut services = serde_json::Map::new();
        if let Some(app) = &self.app {
            services.insert("app".into(), json!({ "localPort": app.local_port, "remotePort": app.remote_port }));
        }
        if let Some(login) = &self.mac_login {
            services.insert("macLogin".into(), json!({ "user": login.user, "address": login.address }));
        }
        let mut config = json!({ "version": 1, "host": self.host, "services": services });
        if let Some(windows) = &self.windows {
            config["windows"] = json!({ "host": windows.host, "port": windows.port });
        }
        config
    }

    pub fn service_names(&self) -> Vec<&'static str> {
        [self.app.as_ref().map(|_| "app"), self.mac_login.as_ref().map(|_| "macLogin")].into_iter().flatten().collect()
    }
}

pub fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("JSON values always serialize")
}

pub fn read_config(paths: &Paths) -> Res<Config> {
    let text = std::fs::read_to_string(&paths.config).map_err(|_| {
        format!(
            "No configuration at {}. {}",
            paths.config.display(),
            if MAC { "Run init." } else { "Install on the Mac first." }
        )
    })?;
    let value: Value = serde_json::from_str(&text).map_err(|error| format!("{}: {error}", paths.config.display()))?;
    validate(&value)
}

pub fn default_config(host: &str, mac_address: Option<&str>) -> Res<Config> {
    let mut services = json!({ "app": { "localPort": 8080, "remotePort": 8080 } });
    if let Some(address) = mac_address {
        // The account this process runs as, not $USER, which agents may not set.
        let user = crate::process::run("/usr/bin/id", &["-un".into()], None, crate::process::DEFAULT_TIMEOUT)?;
        let user = user.trim();
        services["macLogin"] = json!({ "user": user, "address": address });
    }
    validate(&json!({ "version": 1, "host": host, "services": services }))
}

/// launchd restarts ssh on exit; ServerAlive and ExitOnForwardFailure make it
/// exit on a dead link or a taken port, so no supervisor process is needed.
pub fn tunnel_args(config: &Config) -> Vec<String> {
    let mut args: Vec<String> = [
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "GatewayPorts=no",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
    ]
    .map(String::from)
    .into();
    if let Some(app) = &config.app {
        args.extend(["-L".into(), format!("127.0.0.1:{}:127.0.0.1:{}", app.local_port, app.remote_port)]);
    }
    args.push(config.host.clone());
    args
}

pub fn plist(name: &str, args: &[String], log: &str) -> String {
    let args: String = args.iter().map(|arg| format!("<string>{}</string>", xml(arg))).collect();
    let log = xml(log);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{name}</string>
<key>ProgramArguments</key><array>{args}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>{log}</string>
<key>StandardErrorPath</key><string>{log}</string>
</dict></plist>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Value {
        json!({ "version": 1, "host": "laptop.ts.net", "services": { "app": { "localPort": 8080, "remotePort": 8080 } } })
    }

    fn with(key: &str, value: Value) -> Value {
        let mut input = base();
        input[key] = value;
        input
    }

    #[test]
    fn windows_defaults_to_the_wsl_host_on_port_2222_and_stays_optional() {
        let windows = validate(&with("windows", json!({}))).unwrap().to_json()["windows"].clone();
        assert_eq!(windows, json!({ "host": "laptop.ts.net", "port": 2222 }));
        let custom = validate(&with("windows", json!({ "host": "laptop-win", "port": 2200 }))).unwrap();
        assert_eq!(custom.to_json()["windows"], json!({ "host": "laptop-win", "port": 2200 }));
        assert!(validate(&base()).unwrap().to_json().get("windows").is_none());
        // Opt-in, so status does not fail for anyone without Windows SSH.
        assert!(default_config("laptop.ts.net", None).unwrap().windows.is_none());
    }

    #[test]
    fn windows_rejects_port_22_which_wsl_sshd_owns_and_unsafe_hosts() {
        let error = validate(&with("windows", json!({ "port": 22 }))).err().unwrap();
        assert!(error.contains("not be 22"), "{error}");
        for host in ["-oProxyCommand=x", "a b", ""] {
            assert!(validate(&with("windows", json!({ "host": host }))).is_err(), "{host}");
        }
    }

    #[test]
    fn config_round_trips_in_a_stable_key_order() {
        let input = json!({ "version": 1, "host": "wsl", "services": {
            "app": { "localPort": 8080, "remotePort": 3000 }, "macLogin": { "user": "me", "address": "mac" } },
            "windows": { "host": "win", "port": 2222 } });
        assert_eq!(pretty(&validate(&input).unwrap().to_json()), pretty(&input));
    }

    #[test]
    fn config_rejects_unsafe_users_ports_and_empty_services() {
        for user in ["", "../other", "a;exit", "a\nb", "-x"] {
            let input = with("services", json!({ "macLogin": { "user": user, "address": "mac" } }));
            assert!(validate(&input).is_err(), "{user:?}");
        }
        for port in [json!(80), json!(70000), json!(8080.5), json!("8080")] {
            let input = with("services", json!({ "app": { "localPort": port, "remotePort": 8080 } }));
            assert!(validate(&input).is_err(), "{port}");
        }
        assert!(validate(&with("services", json!({}))).is_err());
        assert!(validate(&with("version", json!(2))).is_err());
    }

    #[test]
    fn tunnel_forwards_only_the_app_port_on_loopback() {
        let args = tunnel_args(&validate(&base()).unwrap());
        assert_eq!(args[args.len() - 3..], ["-L", "127.0.0.1:8080:127.0.0.1:8080", "laptop.ts.net"]);
        assert!(args.contains(&"ExitOnForwardFailure=yes".into()));
        assert!(plist(LABEL, &["a&<b>".into()], "/l").contains("<string>a&amp;&lt;b&gt;</string>"));
    }
}
