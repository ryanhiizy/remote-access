mod claude_login;
mod config;
mod helpers;
mod manager;
mod open;
mod process;

use config::{MAC, Paths, default_config, home, locations, pretty, read_config, shell_quote};
use std::time::Duration;

pub type Res<T> = Result<T, String>;

/// Prints a line. A reader that stopped early (closed pipe) is not an error.
pub fn say(text: impl std::fmt::Display) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout(), "{text}");
}

const HELP: &str = "Usage: remote-access <command>   (run everything from WSL; only recover needs the Mac)

status [--json]                  services + Windows crash report; nonzero when one is unavailable
mac [-- COMMAND...]              Mac shell, or one command
open URL_OR_PATH                 URL in Aside; file to ~/Downloads/WSL, opened
forward PORT [MAC_PORT]          Mac 127.0.0.1:MAC_PORT → WSL localhost:PORT until killed
start | stop | restart | logs    Mac app tunnel (launchd)
skills-sync [--prefer mac|wsl] | gcloud-login | claude-login [--email EMAIL]
Setup: install-helpers | init --host WSL_TAILSCALE_NAME [--mac MAC_TAILSCALE_NAME] | install | uninstall
Mac:   recover                   WSL down: crash report and restart over Windows SSH
";

/// Mac launchd and setup commands. From WSL they run on the Mac over Mac SSH.
const ON_MAC: [&str; 7] = ["init", "install", "start", "stop", "restart", "logs", "uninstall"];

fn only(wanted_mac: bool, command: &str) -> Res<()> {
    if MAC == wanted_mac {
        Ok(())
    } else {
        Err(format!("Run {command} on {}.", if wanted_mac { "the Mac" } else { "WSL" }))
    }
}

fn skip_separator(rest: &[String]) -> &[String] {
    if rest.first().is_some_and(|arg| arg == "--") { &rest[1..] } else { rest }
}

/// --name VALUE or --name=VALUE; anything else is an error.
fn options<'a>(args: &'a [String], names: &[&'a str]) -> Res<Vec<(&'a str, &'a str)>> {
    let mut found = Vec::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.strip_prefix("--").map(|rest| rest.split_once('=')) {
            Some(Some((name, value))) => (name, Some(value)),
            Some(None) => (&arg[2..], None),
            None => return Err(format!("Unexpected argument '{arg}'.")),
        };
        let name = *names.iter().find(|known| **known == name).ok_or_else(|| format!("Unknown option '--{name}'."))?;
        let value =
            inline.or_else(|| args.next().map(String::as_str)).ok_or_else(|| format!("--{name} needs a value."))?;
        found.push((name, value));
    }
    Ok(found)
}

fn main_with(args: &[String]) -> Res<i32> {
    let (command, rest) = args.split_first().map_or(("", &[][..]), |(command, rest)| (command.as_str(), rest));
    let home = home()?;
    let paths: Paths = locations(&home, MAC);
    if !MAC && ON_MAC.contains(&command) {
        helpers::remote_access_on_mac(&home, args)?;
    }
    match command {
        "init" => {
            let found = options(rest, &["host", "mac"])?;
            let value = |name| found.iter().rev().find(|(found, _)| *found == name).map(|(_, value)| *value);
            if paths.config.exists() {
                return Err(format!("{} exists; edit it instead.", paths.config.display()));
            }
            let config = default_config(value("host").unwrap_or(""), value("mac"))?;
            manager::private_write(&paths.config, format!("{}\n", pretty(&config.to_json())), 0o600)?;
            say(format!("Saved {}. Review it, then run install.", paths.config.display()));
        }
        "install" => {
            let mut report = manager::install(&read_config(&paths)?, &home)?;
            report["skill"] = helpers::install_skill(&home)?.into();
            say(pretty(&report));
        }
        "start" => {
            manager::start(&home)?;
        }
        "stop" => {
            manager::stop()?;
        }
        "restart" => {
            manager::stop()?;
            manager::start(&home)?;
        }
        "uninstall" => {
            manager::uninstall(&home)?;
        }
        "logs" => {
            if let Ok(log) = std::fs::read_to_string(paths.directory.join("tunnel.log")) {
                let lines: Vec<&str> = log.trim_end().lines().collect();
                say(lines[lines.len().saturating_sub(30)..].join("\n"));
            }
        }
        "recover" => {
            if !MAC {
                return Err("recover is for when WSL is down; run it on the Mac.".into());
            }
            manager::recover(&read_config(&paths)?, Duration::from_secs(120))?;
        }
        "forward" => {
            let port = |text: &String| text.parse::<u16>().ok().filter(|port| *port > 0);
            let (port, local) = match rest {
                [port_text] => (port(port_text), port(port_text)),
                [port_text, local] => (port(port_text), port(local)),
                _ => (None, None),
            };
            let (Some(port), Some(local)) = (port, local) else {
                return Err("Usage: remote-access forward PORT [MAC_PORT]".into());
            };
            if !MAC {
                helpers::forward(&home, port, local)?;
            }
            let config = read_config(&paths)?;
            say(format!("http://127.0.0.1:{local} → {} localhost:{port}; Ctrl-C to stop.", config.host));
            process::exec("/usr/bin/ssh", &manager::forward_args(&config, port, local))?;
        }
        "status" => {
            let report = manager::status(&read_config(&paths)?);
            let json = rest.iter().any(|arg| arg == "--json");
            say(if json { pretty(&report.json) } else { manager::status_text(&report.json) });
            return Ok(if report.healthy { 0 } else { 1 });
        }
        "mac" => {
            only(false, command)?;
            let address = read_config(&paths)?.mac_login.map(|login| login.address);
            let address = address.ok_or("Enable macLogin and install remote-access on your Mac first.")?;
            let mut ssh = vec!["-F".to_owned(), paths.ssh_config.display().to_string(), address];
            ssh.extend(skip_separator(rest).iter().map(|arg| shell_quote(arg)));
            // exec passes the remote exit status through unchanged.
            process::exec("/usr/bin/ssh", &ssh)?;
        }
        "open" => {
            only(false, command)?;
            let [target] = skip_separator(rest) else { return Err("Usage: remote-access open URL_OR_PATH".into()) };
            open::open_on_mac(target, &paths, Duration::from_secs(15))?;
        }
        "aside" => {
            only(false, command)?;
            helpers::aside(&home, rest)?;
        }
        "install-helpers" => {
            only(false, command)?;
            let mut report = helpers::install_helpers(&home, &helpers::binary()?)?;
            report["zram"] = helpers::install_zram(&paths.directory);
            report["earlyoom"] = helpers::install_earlyoom(&paths.directory);
            say(pretty(&report));
        }
        "skills-sync" => {
            only(false, command)?;
            return helpers::skills_sync(&home, rest);
        }
        "claude-login" => {
            let found = options(rest, &["email"])?;
            let email = found.iter().rev().find(|(name, _)| *name == "email").map(|(_, value)| *value);
            return claude_login::login(&home, email);
        }
        "gcloud-login" => {
            only(false, command)?;
            helpers::gcloud_login(&home)?;
        }
        _ => say(HELP.trim_end()),
    }
    Ok(0)
}

fn main() {
    let args: Option<Vec<String>> = std::env::args_os().skip(1).map(|arg| arg.into_string().ok()).collect();
    let result = args.ok_or_else(|| "Arguments must be UTF-8.".to_owned()).and_then(|args| main_with(&args));
    std::process::exit(match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_accept_both_forms_and_reject_strays() {
        let args = process::strings(["--host", "wsl", "--mac=mac.ts.net"]);
        assert_eq!(options(&args, &["host", "mac"]).unwrap(), [("host", "wsl"), ("mac", "mac.ts.net")]);
        for bad in [&["--other", "x"][..], &["stray"], &["--host"]] {
            assert!(
                options(&bad.iter().map(|arg| arg.to_string()).collect::<Vec<_>>(), &["host", "mac"]).is_err(),
                "{bad:?}"
            );
        }
    }
}
