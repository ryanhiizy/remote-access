use crate::Res;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

unsafe extern "C" {
    safe fn getuid() -> u32;
}

pub fn uid() -> u32 {
    getuid()
}

pub struct Output {
    /// None when the process was killed: by a signal, or on timeout.
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

fn drain(source: Option<impl Read + Send + 'static>) -> mpsc::Receiver<String> {
    let (send, receive) = mpsc::channel();
    if let Some(mut source) = source {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = source.read_to_end(&mut bytes);
            let _ = send.send(String::from_utf8_lossy(&bytes).into_owned());
        });
    }
    receive
}

/// Waits for exit, killing the child at the deadline.
pub fn wait(child: &mut Child, timeout: Duration) -> (Option<ExitStatus>, bool) {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return (Some(status), false),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                return (child.wait().ok(), true);
            }
        }
    }
}

/// Runs a program to completion with captured output, optional stdin text and a deadline.
pub fn capture(program: &str, args: &[String], input: Option<&str>, timeout: Duration) -> std::io::Result<Output> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
        let input = input.to_owned();
        thread::spawn(move || stdin.write_all(input.as_bytes()));
    }
    let (stdout, stderr) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let (status, timed_out) = wait(&mut child, timeout);
    // A daemonized grandchild (an SSH control master) may keep a pipe open; don't wait on it.
    let collect = |receiver: mpsc::Receiver<String>| receiver.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
    Ok(Output {
        status: status.and_then(|status| status.code()),
        stdout: collect(stdout),
        stderr: collect(stderr),
        timed_out,
    })
}

/// Like capture, but any failure becomes an error naming the program.
pub fn run(program: &str, args: &[String], input: Option<&str>, timeout: Duration) -> Res<String> {
    let name = Path::new(program).file_name().map_or(program.into(), |name| name.to_string_lossy().into_owned());
    let output = capture(program, args, input, timeout).map_err(|error| format!("{name} failed: {error}"))?;
    match output.status {
        Some(0) => Ok(output.stdout),
        _ if output.timed_out => Err(format!("{name} failed: timed out after {}s", timeout.as_secs())),
        status => {
            let detail = match output.stderr.trim() {
                "" => status.map_or("killed".into(), |code| code.to_string()),
                stderr => stderr.into(),
            };
            Err(format!("{name} failed: {detail}"))
        }
    }
}

/// Replaces this process, so nothing of ours stays resident and the exit status passes through.
pub fn exec(program: &str, args: &[String]) -> Res<()> {
    let error = Command::new(program).args(args).exec();
    Err(format!("{program}: {error}"))
}

pub fn strings<const N: usize>(values: [&str; N]) -> Vec<String> {
    values.map(String::from).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_feeds_stdin_and_reports_failures() {
        let output = capture("/bin/sh", &strings(["-c", "cat; exit 3"]), Some("héllo\n"), DEFAULT_TIMEOUT).unwrap();
        assert_eq!((output.status, output.stdout.as_str()), (Some(3), "héllo\n"));
        let error = run("/bin/sh", &strings(["-c", "echo nope >&2; exit 4"]), None, DEFAULT_TIMEOUT).unwrap_err();
        assert_eq!(error, "sh failed: nope");
    }

    #[test]
    fn capture_kills_at_the_deadline() {
        let started = Instant::now();
        let output = capture("/bin/sleep", &strings(["5"]), None, Duration::from_millis(100)).unwrap();
        assert!(output.timed_out && output.status.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
