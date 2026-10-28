---
name: remote-access
description: Mac ↔ WSL ↔ Windows fleet; use when a machine, SSH, WSL or a dev server port is unreachable, or after a crash or reboot.
---

Three machines on Tailscale:

- **Mac**: orchestrator; runs Aside. `remote-access` commands below run here.
- **WSL**: where agents run; `ssh <host>` (config `host`).
- **Windows**: recovery path only; `ssh <windows.host>` on port 2222, PowerShell.

Config: `~/Library/Application Support/remote-access/config.json` (Mac), `~/.config/remote-access/config.json` (WSL).

1. Start with `remote-access status --json`. `crash` has the last bugcheck, unexpected shutdowns, planned restarts, last boot and GPU drivers.
2. WSL down, Windows up: `remote-access recover`.
3. Windows unreachable too (laptop off Tailscale): needs a human at the machine; say so.
4. Dev server on WSL: `remote-access forward PORT [LOCAL_PORT]` on the Mac, then `http://127.0.0.1:LOCAL_PORT`.

Never:

- run Windows sshd on port 22 (WSL's sshd owns it under mirrored networking);
- `wsl --shutdown` or restart WSL without asking; it kills running agents.
