# remote-access

Connects a Mac to a WSL machine so agents on WSL can use the Mac's app
tunnel, Helium browser, shell, clipboard and files. Personal hosts, keys and
logs stay outside this checkout.

| Service | Direction | Ports | Needs |
|---|---|---|---|
| `app` | Mac → WSL | Mac 8080 → WSL 8080 | App gateway on WSL |
| `browser` | WSL → Mac | WSL 9223 → Mac 19222 → Helium | Helium with `helium://inspect/#remote-debugging` on |
| `macLogin` | WSL → Mac | WSL 2222 → Mac 22 | Remote Login (System Settings → General → Sharing) |

Every listener is loopback-only. launchd keeps two Mac jobs alive: plain `ssh`
with the forwards (`ServerAliveInterval`, `ExitOnForwardFailure`), and the
shared browser service.

## Setup

Requirements: Node 22.12+ on both machines, an SSH alias from the Mac to WSL
with unattended key auth, `curl` and `ss` on WSL, and Unison 2.52+ on both
(`brew install unison`) for `skills-sync`.

```sh
# Mac
npm ci --ignore-scripts && npm link --ignore-scripts
remote-access init --host WSL_ALIAS --mac-login   # writes ~/Library/Application Support/remote-access/config.json
remote-access install                             # rerun after updating this checkout or Node
# WSL
npm link --ignore-scripts
remote-access install-helpers
export BROWSER="$HOME/.local/bin/remote-access-browser"   # persist in your shell profile
```

`install` snapshots its runtime into application data, so moving the checkout
does not break autostart. With `macLogin` it creates a key on WSL, authorizes
only that key on the Mac (loopback-only, no forwarding) and pins the Mac host
key. Reinstalling restarts the browser service, so the next browser tool call
asks for approval in Helium again.

## Use from WSL

```sh
remote-access status [--json]          # nonzero when something is unavailable
remote-access mac -- COMMAND           # or no command for a shell
scp -F ~/.config/remote-access/mac-ssh.conf FILE mac-remote:PATH
remote-access open URL_OR_PATH         # same as xdg-open
printf hi | pbcopy; pbpaste            # Mac clipboard
remote-access skills-sync [--prefer mac|wsl]
```

- **Browser control:** MCP clients run `node ~/.config/remote-access/browser-client.mjs 9223`
  on WSL, or `.../runtime/browser-client.mjs 19222` on the Mac, as a persistent
  stdio server (Executor integration `helium_mac`). Clients share one approved
  Helium connection but keep separate tab selections. Paths written by browser
  tools are on the Mac. `status` reports `ready` (approved and open),
  `available` (debugging on, not yet approved) or `waiting-for-approval`.
- **Opening:** URLs open as normal tabs in the running Helium; success means
  dispatched, not loaded. Files and folders are copied to the Mac's
  `~/Downloads/WSL` and opened there; edits do not flow back.
- **Ports:** only the `app` port reaches the Mac browser. OAuth callbacks to
  other WSL ports fail; use the provider's no-browser or device-code login.
- **Skills:** shared skills live in `~/.agents/skills`, linked into
  `~/.claude/skills` and `~/.codex/skills`, which keep only agent-specific
  skills. `skills-sync` runs Unison with `~/.unison/skills.prf`; skills must
  use `~` rather than absolute home paths. Conflicts are skipped until you
  rerun with `--prefer`.

## Mac maintenance

```sh
remote-access status | logs | start | stop | restart | uninstall
```

`uninstall` removes the LaunchAgents but keeps the config and Mac SSH
authorization. To revoke WSL access, remove the `remote-access-mac` line from
`~/.ssh/authorized_keys`.

Development: `npm run check`. `browser-service.mjs` uses chrome-devtools-mcp
internals (`BrowserManager`, `McpServer`), so check them when bumping its pinned
version.
