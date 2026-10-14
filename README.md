# remote-access

Mac ↔ WSL over Tailscale: Aside access, app tunnel, shell, clipboard and files.

## Agent workflow

- Use Aside through Executor `aside_mac`; follow the shared `aside-browser` skill.
  Read [agent browser guidance](docs/agent-browser.md) for the remote boundary.
- Aside runs on the Mac. Transfer WSL inputs first and copy artifacts back over SSH.
- `remote-access status --json` diagnoses SSH and the app tunnel.

WSL commands (the configured Mac Tailscale name is also its SSH host entry):

```sh
aside guide                                   # Mac CLI over SSH
remote-access mac -- COMMAND                  # omit COMMAND for a shell
scp -F ~/.config/remote-access/mac-ssh.conf FILE MAC_TAILSCALE_NAME:PATH
remote-access open URL_OR_PATH                # also xdg-open
printf hi | pbcopy; pbpaste
remote-access skills-sync [--prefer mac|wsl]
remote-access gcloud-login                    # login + ADC; approve on Mac
```

`open` dispatches URLs to Aside without waiting for load; files/folders are copied to
`~/Downloads/WSL` and opened. Edits do not sync back. Only the app port is forwarded;
other OAuth callback ports need no-browser/device login. Skills sync uses Unison;
conflicts are skipped unless `--prefer` is supplied. Shared skills belong in
`~/.agents/skills`, linked from agent directories; use `~` in portable skill paths.

## Setup

Requires Tailscale on both machines, WSL mirrored networking, Node 22.12+,
unattended Mac → WSL SSH, WSL `curl`/`ss`, and Unison 2.52+ for skills sync.

| Service | Route | Requirement |
|---|---|---|
| app | Mac 8080 → WSL 8080 | WSL app gateway |
| macLogin | WSL → Mac 22 over Tailscale | Mac Remote Login enabled |

```sh
# Mac
npm ci --ignore-scripts && npm link --ignore-scripts
remote-access init --host WSL.TAILNET.ts.net --mac MAC.TAILNET.ts.net
remote-access install  # rerun after source/Node updates
# WSL
npm link --ignore-scripts
remote-access install-helpers
export BROWSER="$HOME/.local/bin/remote-access-browser"  # persist in shell profile
```

Install Aside and its CLI on the Mac. `install-helpers` provides a WSL `aside`
proxy; do not install a second native Aside CLI on WSL. Keep the vendor skill in
`~/.agents/skills/aside-browser`, with Claude's entry symlinked there, and sync it
using the existing skills workflow.

Register a persistent stdio MCP server named `aside_mac` in each machine's
Executor: command `~/.local/bin/aside` (expanded absolute path), args `["mcp"]`,
`spawnPerCall: false`. The WSL command uses the pinned SSH connection.

`install` provisions WSL → Mac SSH with a pinned host key and a Tailscale-only
authorized key. launchd maintains the app tunnel, which binds loopback; Mac SSH
works independently of the tunnel.

Mac lifecycle commands: `remote-access start`, `stop`, `restart`, `logs`, `uninstall`.
Uninstall leaves config and SSH authorization; remove the `remote-access-mac` entry
from `~/.ssh/authorized_keys` to revoke access.

Keep this bridge small: reuse upstream tools, minimize repeated tool output and
per-call work, and keep instructions concise. Use `npm run check` and `npm test`.
