# remote-access

Mac ↔ WSL over Tailscale: Aside access, app tunnel, shell, clipboard and files,
plus a Windows way in when WSL is down.

| Service | Route | Needs |
|---|---|---|
| app | Mac 8080 → WSL 8080 | WSL app gateway |
| macLogin | WSL → Mac 22 | Mac Remote Login |
| windows (optional) | Mac → Windows 2222 | `windows/setup.ps1` |

## Agent workflow

- Use Aside through Executor `aside_mac` and follow the shared `aside-browser` skill;
  see [agent browser guidance](docs/agent-browser.md) for the remote boundary.
- Aside runs on the Mac: copy WSL inputs over first, and artifacts back over SSH.
- Diagnose with `remote-access status --json`. `install` and `install-helpers` add the
  [`remote-access` skill](skills/remote-access/SKILL.md) to `~/.agents/skills`.

## Commands

Run everything from WSL; only `recover` needs the Mac (WSL is down when you need it).
Mac tunnel and setup commands run on the Mac over the WSL → Mac SSH. The Mac's Tailscale
name is also its SSH host entry.

| Command | Does |
|---|---|
| `remote-access status [--json]` | every service, plus Windows crash report; exits nonzero if one is down |
| `remote-access mac [-- COMMAND]` | Mac shell, or one command |
| `scp -F ~/.config/remote-access/mac-ssh.conf FILE MAC:PATH` | copy to the Mac |
| `remote-access open URL_OR_PATH` | URL → Aside; file → `~/Downloads/WSL` and opened (also `xdg-open`) |
| `aside guide` | Mac Aside CLI over SSH |
| `pbcopy` / `pbpaste` | Mac clipboard |
| `remote-access forward PORT [MAC_PORT]` | Mac `127.0.0.1:MAC_PORT` → WSL `localhost:PORT` until killed |
| `remote-access start` / `stop` / `restart` / `logs` | Mac app tunnel (launchd) |
| `remote-access skills-sync [--prefer mac\|wsl]` | Unison sync of `~/.agents/skills` |
| `remote-access gcloud-login` | gcloud login + ADC, approved on the Mac |
| `remote-access claude-login [--email EMAIL]` | Claude Code login on WSL, approved in the Mac browser |
| `remote-access uninstall` | removes the Mac tunnel; keeps config and SSH keys |

**Mac only:** `remote-access recover` reaches Windows SSH: crash report, keep-alive state,
restarts WSL. `status` and `forward` also work on the Mac.

Behaviour worth knowing:

- `open` doesn't wait for pages to load, and edits to opened files don't sync back.
- Only the app port is forwarded permanently; use `forward` for others (background it).
  OAuth callbacks need a no-browser or device login.
- The crash report comes from Windows interop on WSL and Windows SSH on the Mac. It reads the Windows System log for 7 days: last bugcheck (1001),
  unexpected shutdowns (41, 6008), restarts (1074, with process and reason), last boot
  and GPU drivers.
- `skills-sync` skips conflicts unless you pass `--prefer`. Link agent skill directories
  to `~/.agents/skills`, and use `~` in portable skill paths.

## Setup

Needs Tailscale on both machines, Rust 1.85+, and Unison 2.52+ for skills sync.

### 1. Windows (Administrator PowerShell)

1. Power: sleep **Never** when plugged in; lid close **Do nothing**. Stay signed in,
   because the keep-alive task starts at logon (step 4 covers reboots).
2. `%USERPROFILE%\.wslconfig`:
   ```ini
   [wsl2]
   memory=<RAM minus 4>GB
   swap=0                    # disk swap read errors crash the VM; zram replaces it
   networkingMode=mirrored
   ```
3. Run setup. It adds a hidden `WSL keep-alive` task (at logon and every 5 minutes)
   and Windows OpenSSH on 2222 (keys only, Tailscale only; never 22, which WSL's sshd owns):
   ```powershell
   .\windows\setup.ps1 -MacPublicKey 'ssh-ed25519 AAAA... you@mac'  # [-Distro Ubuntu] [-LockAtLogon]
   wsl --shutdown
   ```
4. Optional, auto sign-in: update restarts and crash reboots then reach the desktop, and
   start keep-alive, with nobody present. `winget install Microsoft.Sysinternals.Autologon`,
   run `Autologon`, type your username, domain and password, and click Enable. If it
   doesn't stick, turn off "only allow Windows Hello sign-in" (Settings → Accounts →
   Sign-in options). Trade-off: anyone at the laptop gets your session after a reboot, and
   the password is stored as an LSA secret that administrators can read. Rerun setup with
   `-LockAtLogon` to lock the screen after automatic sign-ins. Undo: Autologon → Disable.

### 2. WSL

1. Enable systemd (`[boot] systemd=true` in `/etc/wsl.conf`), install `openssh-server`,
   `curl` and `iproute2`, and allow key logins only.
2. Install the helpers (they also install 16 GB of zram swap, or print the sudo commands):
   ```sh
   cargo install --locked --path . --root ~/.local
   remote-access install-helpers
   export BROWSER="$HOME/.local/bin/remote-access-browser"  # add to your shell profile
   ```

### 3. Mac

1. Turn on Remote Login, and "Allow full disk access for remote users" in its ⓘ panel.
2. Set up key-based SSH to WSL: a key, a `~/.ssh/config` host entry, and the key in
   WSL's `~/.ssh/authorized_keys`. `ssh WSL true` must work without a prompt.
3. Install Aside and its CLI. Don't install a second native Aside CLI on WSL;
   `install-helpers` provides a proxy.
4. Install and connect:
   ```sh
   cargo install --locked --path . --root ~/.local  # needs ~/.local/bin on PATH
   remote-access init --host WSL.TAILNET.ts.net --mac MAC.TAILNET.ts.net
   remote-access install  # rerun after source updates
   ```
   `install` gives WSL → Mac SSH a pinned host key and a Tailscale-only key that may
   reverse-forward to Mac loopback only.
   launchd keeps the app tunnel up, bound to loopback.
5. Optional, for `recover`: add `"windows": {}` to the config, then accept the host
   key once with `ssh -p 2222 WSL.TAILNET.ts.net`. If your Windows username differs
   from your Mac one, set `"windows": {"host": "SSH_ALIAS"}`.

### 4. Executor (both machines)

Add a persistent stdio MCP server `aside_mac`: command is the absolute path of
`~/.local/bin/aside`, args `["mcp"]`, `spawnPerCall: false`.

Keep the vendor skill in `~/.agents/skills/aside-browser`, with Claude's entry
symlinked to it, and sync it with `skills-sync`.

## Revoking access

Run `remote-access uninstall`, then remove the `remote-access-mac` line from the
Mac's `~/.ssh/authorized_keys`.

## Development

Used by agents: keep output short and parseable, and errors actionable. Reuse upstream
tools; nothing of ours stays resident. Only dependency: `serde_json`. Run `cargo fmt`,
`cargo clippy --all-targets` and `cargo test` (CI runs them on Linux and macOS).

From the Node version: `npm rm -g mac-wsl-remote-access`, install as above, then rerun
`remote-access install-helpers` on WSL.
