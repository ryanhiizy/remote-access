---
name: remote-access
description: Mac ↔ WSL ↔ Windows fleet; use to run something on the other machine, open a URL or file in Aside, move files or clipboard between them, reach a dev server port, or when a machine, SSH or WSL is unreachable or after a crash or reboot.
---

Three machines on Tailscale:

- **Mac**: orchestrator; runs Aside.
- **WSL**: where agents run; `ssh <host>` (config `host`).
- **Windows**: recovery path only; `ssh <windows.host>` on port 2222, PowerShell.

Config: `~/Library/Application Support/remote-access/config.json` (Mac), `~/.config/remote-access/config.json` (WSL).

| Where | Command | Does |
|---|---|---|
| both | `remote-access status [--json]` | every service + Windows crash report; nonzero if one is down |
| WSL | `remote-access mac [-- COMMAND]` | Mac shell, or one command on the Mac |
| WSL | `scp -F ~/.config/remote-access/mac-ssh.conf FILE MAC:PATH` | copy to the Mac (reverse the args to copy back) |
| WSL | `remote-access open URL_OR_PATH` | URL → Aside; file → Mac `~/Downloads/WSL`, opened |
| WSL | `pbcopy` / `pbpaste` | Mac clipboard |
| WSL | `remote-access skills-sync [--prefer mac\|wsl]` | sync `~/.agents/skills` |
| WSL | `remote-access gcloud-login` / `claude-login` | logins approved on the Mac |
| Mac | `remote-access recover` | WSL down, Windows up: crash report, restart WSL |
| Mac | `remote-access forward PORT [LOCAL_PORT]` | WSL `localhost:PORT` on Mac `127.0.0.1:LOCAL_PORT` until Ctrl-C |
| Mac | `remote-access start` / `stop` / `restart` / `logs` | app tunnel (launchd) |

If Windows is unreachable too (laptop off Tailscale), a human must go to the machine; say so.

Never:

- run Windows sshd on port 22 (WSL's sshd owns it under mirrored networking);
- `wsl --shutdown` or restart WSL without asking; it kills running agents;
- run `init`, `install`, `install-helpers` or `uninstall` unasked; they're setup.
