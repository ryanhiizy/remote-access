use crate::Res;
use crate::config::{Paths, read_config, shell_quote};
use crate::process::wait;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const URL_ONLY: &str = "Pass one HTTP or HTTPS URL.";

fn has_line_break(value: &str) -> bool {
    value.contains(['\r', '\n', '\0'])
}

fn strip_prefix_ignore_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let head = value.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &value[prefix.len()..])
}

// WHATWG forbidden host code points, plus the delimiters already split off.
const FORBIDDEN_HOST: &str = " #%/:<>?@[\\]^|";

/// Accepts http(s) URLs without credentials, normalized like a browser's URL.href:
/// lowercase scheme and host, no default port, a path, and encoded spaces.
pub fn browser_url(value: &str) -> Res<String> {
    if value.chars().any(char::is_control) {
        return Err(URL_ONLY.into());
    }
    let (scheme, rest) = value.split_once(':').ok_or(URL_ONLY)?;
    let scheme = scheme.to_ascii_lowercase();
    if !(scheme == "http" || scheme == "https") || rest.contains('\\') {
        return Err(URL_ONLY.into());
    }
    let rest = rest.trim_start_matches('/');
    let (authority, tail) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    if authority.contains('@') {
        return Err("Only HTTP and HTTPS URLs without embedded credentials can open in Aside.".into());
    }
    let (host, port) = match authority.strip_prefix('[') {
        Some(inner) => {
            let (ip, port) = inner.split_once(']').ok_or(URL_ONLY)?;
            let valid = ip.contains(':') && ip.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
            if !valid {
                return Err(URL_ONLY.into());
            }
            (format!("[{}]", ip.to_ascii_lowercase()), port)
        }
        None => {
            let (host, port) = authority.split_at(authority.find(':').unwrap_or(authority.len()));
            if host.is_empty() || host.contains(|c| FORBIDDEN_HOST.contains(c)) {
                return Err(URL_ONLY.into());
            }
            (host.to_ascii_lowercase(), port)
        }
    };
    let port = match port {
        "" | ":" => String::new(),
        port => {
            let digits = port.strip_prefix(':').filter(|d| d.chars().all(|c| c.is_ascii_digit())).ok_or(URL_ONLY)?;
            let number: u16 = digits.parse().map_err(|_| URL_ONLY)?;
            let default = if scheme == "http" { 80 } else { 443 };
            if number == default { String::new() } else { format!(":{number}") }
        }
    };
    let tail = if tail.starts_with('/') { tail.to_owned() } else { format!("/{tail}") };
    Ok(format!("{scheme}://{host}{port}{}", tail.replace(' ', "%20")))
}

fn percent_decode(value: &str) -> Option<Vec<u8>> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(out)
}

/// file:/path, file:///path or file://localhost/path, as a normalized local path.
fn file_url_path(value: &str) -> Res<PathBuf> {
    let invalid = || "Pass a file URL for a local absolute path.".to_owned();
    let rest = strip_prefix_ignore_case(value, "file:").ok_or_else(invalid)?;
    let rest = &rest[..rest.find(['?', '#']).unwrap_or(rest.len())];
    let path = match rest.strip_prefix("//") {
        Some(rest) => {
            let (host, path) = rest.split_at(rest.find('/').ok_or_else(invalid)?);
            if !(host.is_empty() || host.eq_ignore_ascii_case("localhost")) {
                return Err(invalid());
            }
            path
        }
        None if rest.starts_with('/') => rest,
        None => return Err(invalid()),
    };
    if path.to_ascii_lowercase().contains("%2f") {
        return Err(invalid());
    }
    let bytes = percent_decode(path).filter(|bytes| !bytes.contains(&0)).ok_or_else(invalid)?;
    Ok(normalize(Path::new(&<std::ffi::OsString as std::os::unix::ffi::OsStringExt>::from_vec(bytes))))
}

/// "." and ".." resolved lexically, like URL and Node's path.resolve, so the path
/// checked is the path sent even across symlinked directories.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            _ => {}
        }
    }
    out
}

fn resolve(path: &Path) -> Res<PathBuf> {
    Ok(normalize(&std::env::current_dir().map_err(|error| error.to_string())?.join(path)))
}

pub enum Target {
    Url(String),
    File(PathBuf),
}

/// A web URL opens in Aside; anything else must name an existing local path.
pub fn open_target(value: &str) -> Res<Target> {
    if has_line_break(value) {
        return Err("Pass one URL or path.".into());
    }
    if strip_prefix_ignore_case(value, "http:").is_some() || strip_prefix_ignore_case(value, "https:").is_some() {
        return browser_url(value).map(Target::Url);
    }
    let file = if strip_prefix_ignore_case(value, "file:").is_some() {
        file_url_path(value)?
    } else {
        resolve(Path::new(value))?
    };
    if std::fs::symlink_metadata(&file).is_err() || file.file_name().is_none() {
        return Err("Pass an HTTP(S) URL or an existing file or directory.".into());
    }
    Ok(Target::File(file))
}

/// Native URL opening leaves the tab owned by the user, independent of an
/// ephemeral MCP client's lifecycle. Do not print callback URLs or tokens.
pub fn mac_open_script(url: &str) -> String {
    format!("set -eu\n/usr/bin/pgrep -x Aside >/dev/null || exit 3\n/usr/bin/open -a Aside {}\n", shell_quote(url))
}

/// Files are copied (not shared) into ~/Downloads/WSL and opened with their
/// default Mac app. Existing copies are kept; a new name is chosen instead.
pub fn mac_file_script(name: &str) -> String {
    format!(
        r#"set -eu
dest="$HOME/Downloads/WSL"
mkdir -p "$dest"
incoming=$(mktemp -d "$dest/.incoming.XXXXXX")
trap 'rm -rf "$incoming"' EXIT
tar -xf - -C "$incoming"
name={}
case "$name" in ?*.*) stem=${{name%.*}}; ext=.${{name##*.}} ;; *) stem=$name; ext= ;; esac
target="$dest/$name"; n=2
while [ -e "$target" ] || [ -L "$target" ]; do target="$dest/$stem ($n)$ext"; n=$((n + 1)); done
mv "$incoming/$name" "$target"
/usr/bin/open "$target"
printf '%s\n' "$target"
"#,
        shell_quote(name)
    )
}

const UNREACHABLE: &str = "Unable to reach your Mac. Check remote-access status.";

pub fn open_on_mac(value: &str, paths: &Paths, timeout: Duration) -> Res<()> {
    let target = open_target(value)?;
    let config = read_config(paths)?;
    let address = match &config.mac_login {
        Some(login) if paths.ssh_config.exists() => login.address.clone(),
        _ => {
            return Err("Mac Remote Login is required for opening on the Mac. Enable macLogin and install remote-access on your Mac.".into());
        }
    };
    let mut ssh = Command::new("/usr/bin/ssh");
    ssh.arg("-T").arg("-F").arg(&paths.ssh_config).arg(&address).stderr(Stdio::null());
    match target {
        Target::Url(url) => {
            let mut child =
                ssh.arg("/bin/sh -s").stdin(Stdio::piped()).stdout(Stdio::null()).spawn().map_err(|_| UNREACHABLE)?;
            // Write from a thread so a stalled connection cannot hold off the deadline.
            let script = mac_open_script(&url);
            let sent =
                child.stdin.take().map(|mut stdin| std::thread::spawn(move || stdin.write_all(script.as_bytes())));
            let (status, timed_out) = wait(&mut child, timeout);
            if timed_out {
                return Err("Mac browser request timed out. Check remote-access status before retrying; the URL is not replayed automatically.".into());
            }
            match status.and_then(|status| status.code()) {
                Some(0) => Ok(()),
                Some(3) => Err("Aside is not running on your Mac. Start Aside, then retry.".into()),
                _ if sent.is_some_and(|sent| !matches!(sent.join(), Ok(Ok(())))) => {
                    Err("Mac connection closed before confirming.".into())
                }
                _ => Err("Mac URL opening failed. Check remote-access status and Mac Remote Login.".into()),
            }
        }
        // File transfers take as long as they take; only URL dispatch is bounded.
        Target::File(file) => {
            let (directory, name) = (file.parent().unwrap_or(Path::new("/")), file.file_name().unwrap_or_default());
            let mut archive = Command::new("tar")
                .arg("-ch")
                .args(["-f", "-", "-C"])
                .arg(directory)
                .arg(name)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "Unable to read the file for transfer.")?;
            let script = mac_file_script(&name.to_string_lossy());
            let stdout = Stdio::from(archive.stdout.take().expect("piped"));
            let child =
                ssh.arg(format!("/bin/sh -c {}", shell_quote(&script))).stdin(stdout).stdout(Stdio::piped()).spawn();
            // Close our copy of the pipe so tar sees EPIPE, not a hang, if ssh exits early.
            drop(ssh);
            let mut child = child.map_err(|_| {
                let _ = archive.kill();
                UNREACHABLE
            })?;
            let mut output = String::new();
            let _ = child.stdout.take().map(|mut out| out.read_to_string(&mut output));
            let status = child.wait().map_err(|error| error.to_string())?;
            let archived = archive.wait().is_ok_and(|status| status.success());
            if !status.success() || !archived {
                return Err(
                    "Copying or opening the file on the Mac failed. Check remote-access status and Mac Remote Login."
                        .into(),
                );
            }
            crate::say(format!("Opened on Mac: {}", output.trim()));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_urls_are_http_without_credentials() {
        for (input, expected) in [
            ("HTTPS://Example.com", "https://example.com/"),
            ("http://localhost:8080/a b?q=1#x", "http://localhost:8080/a%20b?q=1#x"),
            ("https://x.dev?q", "https://x.dev/?q"),
            ("https:x.dev", "https://x.dev/"),
            ("http:localhost:8080", "http://localhost:8080/"),
            ("https://x.dev:443/p", "https://x.dev/p"),
            ("http://[::1]:3000/", "http://[::1]:3000/"),
            ("https://x.dev:/", "https://x.dev/"),
        ] {
            assert_eq!(browser_url(input).unwrap(), expected, "{input}");
        }
        let error = browser_url("https://user:pw@x.dev/").unwrap_err();
        assert!(error.contains("credentials"), "{error}");
        for bad in [
            "https://evil.dev\\@good.dev/",
            "ftp://x.dev/",
            "https:///",
            "https://x.dev/\nGET",
            "javascript:alert(1)",
            "https://:80/",
            "https://x.dev:65536/",
            "https://x.dev:abc/",
            "https://[::1/",
            "https://[x]/",
            "https://a%62.dev/",
            "https://a b/",
        ] {
            assert!(browser_url(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn open_targets_split_urls_from_existing_paths() {
        assert!(matches!(open_target("https://x.dev").unwrap(), Target::Url(url) if url == "https://x.dev/"));
        let here = std::env::current_dir().unwrap();
        assert!(
            matches!(open_target("src/../Cargo.toml").unwrap(), Target::File(file) if file == here.join("Cargo.toml"))
        );
        assert!(matches!(open_target(".").unwrap(), Target::File(file) if file == here));
        let url = format!("file://localhost{}", here.join("Cargo.toml").display().to_string().replace('o', "%6F"));
        assert!(matches!(open_target(&url).unwrap(), Target::File(file) if file == here.join("Cargo.toml")));
        assert!(
            matches!(open_target("file:/etc/hosts").unwrap(), Target::File(file) if file == Path::new("/etc/hosts"))
        );
        // Dot segments resolve before the filesystem sees the path, as in a browser.
        let dotted = format!("file://{}/src/../Cargo.toml", here.display());
        assert!(matches!(open_target(&dotted).unwrap(), Target::File(file) if file == here.join("Cargo.toml")));
        for bad in ["/no/such/file", "/", "file://host/etc/hosts", "file:///etc%2Fhosts", "file:etc/hosts", "a\nb"] {
            assert!(open_target(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn mac_scripts_quote_their_inputs() {
        assert!(mac_open_script("https://x.dev/'$(id)'").contains("'https://x.dev/'\\''$(id)'\\'''"));
        let script = mac_file_script("it's $(id).tar.gz");
        assert!(script.contains("name='it'\\''s $(id).tar.gz'"));
        assert!(std::process::Command::new("/bin/sh").args(["-n", "-c", &script]).status().unwrap().success());
    }
}
