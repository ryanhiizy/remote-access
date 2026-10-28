use crate::Res;
use crate::config::{Paths, locations, read_config, shell_quote};
use crate::manager::private_write;
use crate::process::{DEFAULT_TIMEOUT, capture, exec, strings, uid};
use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

struct Mac {
    paths: Paths,
    host: String,
    user: String,
}

fn mac_setup(home: &Path) -> Res<Mac> {
    let paths = locations(home, false);
    let config = read_config(&paths)?;
    match config.mac_login {
        Some(login) if paths.ssh_config.exists() => Ok(Mac { paths, host: login.address, user: login.user }),
        _ => Err("Install on the Mac with macLogin enabled first.".into()),
    }
}

/// The remote command for the Mac's Aside CLI: every argument single-quoted, so code,
/// empty arguments and trailing newlines arrive intact and nothing expands.
pub fn aside_command(user: &str, args: &[String]) -> String {
    let mut command = format!("exec {}", shell_quote(&format!("/Users/{user}/.local/bin/aside")));
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    command
}

/// Aside runs only on the Mac. exec keeps nothing of ours beside the MCP stream.
pub fn aside(home: &Path, args: &[String]) -> Res<()> {
    let mac = mac_setup(home)?;
    let mut ssh = strings(["-T", "-F"]);
    ssh.push(mac.paths.ssh_config.display().to_string());
    ssh.extend(strings(["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]));
    ssh.extend([mac.host, aside_command(&mac.user, args)]);
    exec("/usr/bin/ssh", &ssh)
}

const ASIDE_MARKER: &str = "remote-access Aside proxy";

fn write_script(file: &Path, text: &str) -> Res<()> {
    private_write(file, text, 0o700)
}

pub const SKILL: &str = include_str!("../skills/remote-access/SKILL.md");

/// The agent skill, in the directory skills-sync carries to the other machine.
pub fn install_skill(home: &Path) -> Res<String> {
    private_write(&home.join(".agents/skills/remote-access/SKILL.md"), SKILL, 0o644)?;
    Ok("~/.agents/skills/remote-access".into())
}

pub fn install_helpers(home: &Path, binary: &Path) -> Res<Value> {
    let mac = mac_setup(home)?;
    let bin = home.join(".local/bin");
    let aside_shim = bin.join("aside");
    // Replace only our own proxy; anything else there is a real Aside CLI.
    match fs::read(&aside_shim) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(bytes) if bytes.windows(ASIDE_MARKER.len()).any(|window| window == ASIDE_MARKER.as_bytes()) => {}
        _ => {
            return Err(
                "An Aside CLI already exists in ~/.local/bin; leave it intact or remove it before installing the proxy."
                    .into(),
            );
        }
    }
    let binary = shell_quote(&binary.display().to_string());
    let invoke = format!("exec {binary} open -- \"$@\"");
    for name in ["remote-access-browser", "sensible-browser", "www-browser"] {
        write_script(&bin.join(name), &format!("#!/bin/sh\n{invoke}\n"))?;
    }
    // Web URLs, file URLs and existing paths open on the Mac; anything else goes to the system helper.
    write_script(
        &bin.join("xdg-open"),
        &format!(
            "#!/bin/sh\ncase \"$1\" in http://*|https://*|file://*) {invoke} ;; esac\nif [ \"$#\" -eq 1 ] && [ -e \"$1\" ]; then {invoke}; fi\nexec /usr/bin/xdg-open \"$@\"\n"
        ),
    )?;
    write_script(&aside_shim, &format!("#!/bin/sh\n# {ASIDE_MARKER}\nexec {binary} aside \"$@\"\n"))?;
    // UTF-8 so non-ASCII text survives the non-interactive SSH session.
    let ssh_config = mac.paths.ssh_config.display().to_string();
    let direct = |command: &str| {
        format!(
            "#!/bin/sh\nexec /usr/bin/ssh -T -F {} {} {}\n",
            shell_quote(&ssh_config),
            shell_quote(&mac.host),
            shell_quote(&format!("LANG=en_US.UTF-8 {command}"))
        )
    };
    write_script(&bin.join("pbcopy"), &direct("/usr/bin/pbcopy"))?;
    write_script(&bin.join("pbpaste"), &direct("/usr/bin/pbpaste"))?;
    // Earlier Node versions ran helpers from snapshots here.
    for old in ["aside-client.mjs", "open.mjs", "browser-client.mjs"] {
        let _ = fs::remove_file(mac.paths.directory.join(old));
    }
    // Unison profile for skills-sync. Skills must use ~ rather than absolute home paths.
    let home_text = home.display();
    private_write(
        &home.join(".unison/skills.prf"),
        format!(
            "root = {home_text}
root = ssh://{host}//Users/{user}
path = .agents
path = .claude/skills
path = .codex/skills
ignore = Name .DS_Store
ignore = Name __pycache__
ignore = Path .codex/skills/.system
ignore = Path .claude/skills/synced
links = true
perms = 0o111
sshargs = -F {ssh_config}
servercmd = /opt/homebrew/bin/unison
",
            host = mac.host,
            user = mac.user,
        ),
        0o600,
    )?;
    Ok(json!({
        "browser": bin.join("remote-access-browser").display().to_string(),
        "helpers": ["aside", "xdg-open", "sensible-browser", "www-browser", "pbcopy", "pbpaste"],
        "skill": install_skill(home)?,
        "unison": "~/.unison/skills.prf",
    }))
}

const ZRAM_TARGET: &str = "/etc/systemd/system/zram-swap.service";
pub const ZRAM_UNIT: &str = include_str!("../wsl/zram-swap.service");

pub fn zram_commands(unit: &str) -> Vec<String> {
    vec![
        format!("install -m 0644 {} {ZRAM_TARGET}", shell_quote(unit)),
        "systemctl daemon-reload".into(),
        "systemctl enable --now zram-swap.service".into(),
    ]
}

/// Replaces disk swap, whose read errors crashed the WSL VM. Needs root, so print the
/// commands when sudo would prompt.
pub fn install_zram(directory: &Path) -> Value {
    let current = fs::read_to_string(ZRAM_TARGET).is_ok_and(|text| text == ZRAM_UNIT);
    let active = || Command::new("systemctl").args(["is-active", "--quiet", "zram-swap.service"]).status();
    if current && active().is_ok_and(|status| status.success()) {
        return "active".into();
    }
    let unit = directory.join("zram-swap.service");
    if let Err(error) = private_write(&unit, ZRAM_UNIT, 0o644) {
        return format!("unit not written: {error}").into();
    }
    let commands = zram_commands(&unit.display().to_string());
    let mut args = vec!["/bin/sh".to_owned(), "-c".into(), commands.join(" && ")];
    let program = if uid() == 0 {
        args.remove(0)
    } else {
        args.insert(0, "-n".into());
        "sudo".into()
    };
    match capture(&program, &args, None, DEFAULT_TIMEOUT) {
        Ok(output) if output.status == Some(0) => "installed".into(),
        _ => json!({ "run": commands.iter().map(|command| format!("sudo {command}")).collect::<Vec<_>>() }),
    }
}

pub fn skills_sync(home: &Path, args: &[String]) -> Res<i32> {
    let prefer = match args {
        [] => None,
        [flag, side] if flag == "--prefer" && (side == "mac" || side == "wsl") => Some(side.as_str()),
        _ => return Err("Usage: remote-access skills-sync [--prefer mac|wsl]".into()),
    };
    let mac = mac_setup(home)?;
    let mut command = Command::new("unison");
    command.args(["skills", "-batch", "-terse"]);
    match prefer {
        Some("wsl") => command.arg("-prefer").arg(home),
        Some(_) => command.args(["-prefer".into(), format!("ssh://{}//Users/{}", mac.host, mac.user)]),
        None => &mut command,
    };
    let status = command.status().map_err(|_| "Install Unison 2.52+ on both machines (brew install unison).")?;
    // Unison exits 1 when it skipped conflicts; rerun with --prefer to resolve.
    Ok(status.code().unwrap_or(1))
}

fn after<'a>(text: &'a str, marker: &str, end: impl Fn(char) -> bool) -> Option<&'a str> {
    let start = text.find(marker)? + marker.len();
    let length = text[start..].find(end)?;
    Some(&text[start..start + length])
}

/// Refreshes gcloud's login and ADC together. Google's --no-browser flow runs on WSL;
/// its bootstrap step runs on the Mac, which opens the consent page in the user's
/// browser. Never prints the URLs: they carry OAuth state and codes.
pub fn gcloud_login(home: &Path) -> Res<()> {
    let mac = mac_setup(home)?;
    let mut local = Command::new("gcloud")
        .args(["auth", "login", "--update-adc", "--no-browser"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "gcloud is not installed on WSL.")?;
    let (send, receive) = mpsc::channel::<Option<String>>();
    for stream in [
        local.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        local.stderr.take().map(|s| Box::new(s) as _),
    ] {
        let (send, mut stream) = (send.clone(), stream.expect("piped"));
        thread::spawn(move || {
            let mut buffer = [0; 4096];
            // Keep draining after the match so gcloud never blocks on a full pipe.
            while let Ok(read @ 1..) = stream.read(&mut buffer) {
                let _ = send.send(Some(String::from_utf8_lossy(&buffer[..read]).into_owned()));
            }
            let _ = send.send(None);
        });
    }
    drop(send);
    let (mut output, mut open) = (String::new(), 2);
    let bootstrap = loop {
        match receive.recv() {
            Ok(Some(chunk)) => output.push_str(&chunk),
            Ok(None) => open -= 1,
            Err(_) => open = 0,
        }
        if let Some(bootstrap) = after(&output, "--remote-bootstrap=\"", |c| c == '"') {
            break bootstrap.to_owned();
        }
        if open == 0 {
            let code =
                local.wait().ok().and_then(|status| status.code()).map_or("signal".into(), |code| code.to_string());
            return Err(format!("gcloud exited ({code}) before offering a remote login."));
        }
    };
    crate::say("Approve the Google sign-in that opened on your Mac (waiting up to 5 minutes)...");
    // gcloud asks to confirm the bootstrap came from a trusted machine; it did (our WSL
    // process above). Clear SSH variables so it opens the Mac's browser.
    let command = format!(
        "printf 'y\\n' | env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY gcloud auth login --remote-bootstrap={}",
        shell_quote(&bootstrap)
    );
    let mut ssh = strings(["-T", "-F"]);
    ssh.extend([mac.paths.ssh_config.display().to_string(), mac.host, format!("zsh -lc {}", shell_quote(&command))]);
    let reply = capture("/usr/bin/ssh", &ssh, None, Duration::from_secs(300)).ok().and_then(|mac| {
        let text = format!("{}{} ", mac.stdout, mac.stderr);
        ["http://localhost", "https://localhost"].iter().find_map(|prefix| {
            after(&text, prefix, char::is_whitespace)
                .filter(|rest| !rest.is_empty())
                .map(|rest| format!("{prefix}{rest}"))
        })
    });
    let Some(reply) = reply else {
        let _ = local.kill();
        return Err("The Mac sign-in did not complete. Check gcloud is installed on the Mac, then retry.".into());
    };
    if let Some(mut stdin) = local.stdin.take() {
        let _ = writeln!(stdin, "{reply}");
    }
    if !local.wait().is_ok_and(|status| status.success()) {
        return Err("gcloud rejected the sign-in result; retry remote-access gcloud-login.".into());
    }
    let adc = Command::new("gcloud")
        .args(["auth", "application-default", "print-access-token"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !adc {
        return Err("gcloud login refreshed, but ADC still fails; run gcloud auth application-default login.".into());
    }
    crate::say("gcloud login and ADC refreshed.");
    Ok(())
}

pub fn binary() -> Res<PathBuf> {
    std::env::current_exe().and_then(fs::canonicalize).map_err(|error| format!("Cannot locate this binary: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the remote command in a local shell, with the Mac's aside swapped for a
    /// program that prints its arguments one per NUL-terminated field.
    fn remote(args: &[String]) -> Vec<String> {
        let command =
            aside_command("test", args).replace(&shell_quote("/Users/test/.local/bin/aside"), "printf '%s\\0'");
        let output = Command::new("/bin/sh").args(["-c", &command]).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let text = String::from_utf8(output.stdout).unwrap();
        text.split_terminator('\0').map(String::from).collect()
    }

    #[test]
    fn aside_preserves_code_quotes_empty_arguments_unicode_and_trailing_newlines() {
        let args = strings([
            "repl",
            "",
            "console.log('quoted')",
            "''",
            "'",
            "$(exit 71)",
            "`exit 72`",
            "\"$HOME\"",
            "héllo\n\n",
        ]);
        assert_eq!(remote(&args), args);
        assert!(aside_command("test", &[]).ends_with("/aside'"));
    }

    #[test]
    fn shims_hand_their_arguments_to_the_binary_and_guard_a_real_aside() {
        let home = std::env::temp_dir().join(format!("remote-access-shims-{}", std::process::id()));
        let directory = home.join(".config/remote-access");
        fs::create_dir_all(&directory).unwrap();
        let config = r#"{"version":1,"host":"wsl","services":{"macLogin":{"user":"me","address":"mac"}}}"#;
        fs::write(directory.join("config.json"), config).unwrap();
        fs::write(directory.join("mac-ssh.conf"), "").unwrap();
        fs::write(directory.join("open.mjs"), "old").unwrap();
        // Stands in for the binary: prints the arguments it was given.
        let binary = home.join("fake bin's");
        private_write(&binary, "#!/bin/sh\nprintf '%s|' \"$@\"\n", 0o700).unwrap();
        install_helpers(&home, &binary).unwrap();
        let run = |name: &str, args: &[&str]| {
            let output = Command::new(home.join(".local/bin").join(name)).args(args).output().unwrap();
            String::from_utf8(output.stdout).unwrap()
        };
        assert_eq!(run("aside", &["repl", "", "it's"]), "aside|repl||it's|");
        assert_eq!(run("remote-access-browser", &["https://x.dev"]), "open|--|https://x.dev|");
        assert_eq!(run("xdg-open", &["file:///tmp"]), "open|--|file:///tmp|");
        assert_eq!(run("xdg-open", &["/"]), "open|--|/|");
        assert!(!directory.join("open.mjs").exists());
        assert_eq!(fs::read_to_string(home.join(".agents/skills/remote-access/SKILL.md")).unwrap(), SKILL);
        // A native Aside CLI is never replaced.
        fs::write(home.join(".local/bin/aside"), b"\x7fELF\xff\xfe").unwrap();
        assert!(install_helpers(&home, &binary).unwrap_err().contains("already exists"));
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn zram_unit_and_install_commands() {
        for line in [
            "ExecStart=zramctl --size 16G --algorithm lzo-rle /dev/zram0",
            "ExecStart=swapon --priority 100 /dev/zram0",
            "ExecStop=zramctl --reset /dev/zram0",
            "WantedBy=multi-user.target",
        ] {
            assert!(ZRAM_UNIT.contains(line), "{line}");
        }
        assert_eq!(
            zram_commands("/home/o'neil/zram-swap.service"),
            [
                "install -m 0644 '/home/o'\\''neil/zram-swap.service' /etc/systemd/system/zram-swap.service",
                "systemctl daemon-reload",
                "systemctl enable --now zram-swap.service",
            ]
        );
    }

    #[test]
    fn after_extracts_bounded_values() {
        let text = "run: gcloud auth login --remote-bootstrap=\"https://x/?a=1\" now";
        assert_eq!(after(text, "--remote-bootstrap=\"", |c| c == '"'), Some("https://x/?a=1"));
        assert_eq!(after("no marker", "--remote-bootstrap=\"", |c| c == '"'), None);
    }
}
