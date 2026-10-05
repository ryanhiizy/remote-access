# remote-access

Mac ↔ WSL over Tailscale: shared Helium, app tunnel, shell, clipboard and files.
Personal config, keys and logs stay outside this checkout.

## Agent workflow

- Use Executor `helium_mac`. Call `start_browser_session` once per chat; pass its
  `sessionId` on every call. `new_page` creates owned tabs; other sessions’ tabs
  are excluded. Normal tabs share cookies; use `isolatedContext` for separate sign-ins.
- Reuse sessions and page/snapshot IDs across client reconnects. Browser/service
  restarts require a new session. Finish with `end_browser_session`; tabs stay open.
- Upload/output paths are on the Mac, with the Mac account’s full file access.
  Transfer WSL files first. Downloads save to the Mac’s `~/Downloads`.
- Use `remote-access status --json` for diagnostics; nonzero means unavailable.
  Browser states: `ready` = approved, `available` = awaiting connection,
  `waiting-for-approval` = approval pending.

WSL commands (the configured Mac Tailscale name is also its SSH host entry):

```sh
remote-access mac -- COMMAND                  # omit COMMAND for a shell
scp -F ~/.config/remote-access/mac-ssh.conf FILE MAC_TAILSCALE_NAME:PATH
remote-access open URL_OR_PATH                # also xdg-open
printf hi | pbcopy; pbpaste
remote-access skills-sync [--prefer mac|wsl]
remote-access gcloud-login                    # login + ADC; approve on Mac
```

`open` dispatches URLs without waiting for load; files/folders are copied to
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
| browser | WSL 9223 → Mac 19222 → Helium | `helium://inspect/#remote-debugging` enabled |
| macLogin | WSL → Mac 22 over Tailscale | Mac Remote Login enabled |

```sh
# Mac
npm ci --ignore-scripts && npm link --ignore-scripts
remote-access init --host WSL.TAILNET.ts.net --mac MAC.TAILNET.ts.net
remote-access install                        # rerun after source/Node updates
# WSL
npm link --ignore-scripts
remote-access install-helpers
export BROWSER="$HOME/.local/bin/remote-access-browser"  # persist in shell profile
```

MCP stdio clients use `node ~/.config/remote-access/browser-client.mjs 9223` on WSL;
on Mac, use `node "$HOME/Library/Application Support/remote-access/runtime/browser-client.mjs" 19222`.
Keep the client persistent. Refresh Executor’s `helium_mac` catalogue on both machines after tool changes.

`install` snapshots runtime files and provisions WSL → Mac SSH with a pinned host
key and a Tailscale-only authorized key. launchd maintains the tunnel and browser
service. Forwards bind loopback; Mac SSH works independently of the tunnel.
Reinstall/restart interrupts browser sessions and can require Helium approval.

Mac lifecycle commands: `remote-access start`, `stop`, `restart`, `logs`, `uninstall`.
Uninstall leaves config and SSH authorization; remove the `remote-access-mac` entry
from `~/.ssh/authorized_keys` to revoke access.

Keep this bridge small: reuse upstream tools, minimize repeated tool output and
per-call work, and keep instructions concise. No repository test suite; use
`npm run check` and disposable checks. Verify upstream internals when updating the pinned MCP dependency.
