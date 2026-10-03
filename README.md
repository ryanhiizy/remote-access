# Remote access between a Mac and WSL

One Mac login service maintains an SSH connection to a Windows PC's WSL
environment. It carries app traffic to WSL and browser control and optional
file/terminal access back to the Mac. It starts at login and reconnects after
network changes. Both machines must be awake and reachable.

This repository owns the connection tooling. Personal hostnames, usernames,
keys, generated services, logs and backups stay outside the checkout. App
repositories keep their app routing and authentication behaviour.

## Requirements

- Mac: Node.js 22.12 or newer, an SSH alias that reaches your WSL SSH server, and
  unattended SSH key authentication. Resolve host-key trust using ordinary SSH
  before installing. Encrypted keys need an available agent or macOS Keychain.
- WSL: an SSH server, Python 3.9 or newer, `curl`, `ss`, `timeout` and OpenSSH
  clients. Your Windows/network configuration must already make SSH reachable.
  The installer does not change Windows firewall rules or router forwarding.
- Browser control: your existing Helium profile, with remote debugging enabled
  in `helium://inspect/#remote-debugging`. This tool attaches to that browser;
  it does not launch browsers or copy profile contents.
- Mac file/terminal access: enable **System Settings → General → Sharing →
  Remote Login**, restrict access to your account, and enable **Allow full disk
  access for remote users** if you need protected folders. Account and admin
  permissions still apply. See [Apple's Remote Login instructions](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac).

## Install on the Mac

```sh
git clone https://github.com/ryanhiizy/remote-access.git
cd remote-access
npm ci --ignore-scripts
npm link --ignore-scripts
remote-access init --host YOUR_WSL_ALIAS --mac-login
remote-access inspect
```

`init` writes `~/Library/Application Support/remote-access/config.json`; it
refuses to overwrite existing settings. Review that file before installing.
Use [config.example.json](config.example.json) as a reference. Omit a service
or set it to `false` to disable it. Remove `macLogin` if you do not want Mac
file/terminal access. Change `browser.profile` for a custom existing profile.

```sh
remote-access plan
remote-access install
remote-access status
```

The installer checks SSH authentication and Mac Remote Login before replacing
any service. With Mac login enabled, it creates a dedicated SSH key **on WSL**,
adds only its public key to the Mac's `authorized_keys`, and pins the Mac SSH
host key. It never transfers the private key or changes your general SSH config.
The authorized key is limited to connections arriving through Mac loopback and
cannot forward agents, additional ports or X11 sessions.

## Migrate the existing Ender tunnels

Run `inspect` first. Keep Executor's own `sh.executor.daemon` service. To migrate
the two existing tunnel jobs, initialize with their exact labels:

```sh
remote-access init --host YOUR_WSL_ALIAS --mac-login \
  --replace ai.ender.remote-tunnel \
  --replace au.ender.codex-helium-tunnel
remote-access install
remote-access status
```

If you already ran `init`, add those labels to `replaceAgents` in your local
configuration instead. No other LaunchAgents are selected automatically.
The installer saves private backups, stops the selected jobs, loads the new
service and verifies its local and reverse loopback listeners. Only after it
verifies the new connection are the replaced plist files removed. Failures
restore previous files and loaded services. Saved `replaceAgents` is cleared
after a successful migration, so subsequent reinstalls do not migrate twice.

With `browser.shared: true`, one browser manager in the installed Mac service
holds the approved Helium connection. Mac and WSL MCP clients get independent
tab selections while sharing that connection. Client exits and SSH reconnections
do not close it. The first browser tool call requests approval; closing/restarting
Helium, restarting this service, or losing the browser connection requires a new
approval on the next tool call. The service never clicks the approval dialog.
A tool call racing a client/tunnel disconnect may fail once; retry after the
connection recovers. Browser operations are not replayed automatically.

Existing configurations without `browser.shared` retain the legacy raw browser
relay and metadata mirror. To upgrade, run `npm ci --ignore-scripts`, set
`browser.shared` to `true` in your personal config, reinstall, then switch both
browser integrations to the client commands below. The new service port speaks
MCP JSON messages, so legacy `--autoConnect` clients cannot use that port.
The actual Helium profile and browser debugging port remain unchanged.

## Connections and ports

| Service | Direction | Default ports | What must already be running |
|---|---|---|---|
| `app` | Mac → WSL | Mac 8080 → WSL 8080 | Your app gateway |
| `browser` | WSL → Mac | WSL 9223 → Mac shared browser service 19222 → Helium | Existing Helium with debugging enabled |
| `macLogin` | WSL → Mac | WSL 2222 → Mac 22 | Mac Remote Login |
| `executor` (optional) | Mac → WSL | Configure e.g. Mac 14789 → WSL 4789 | WSL Executor daemon |

Executor forwarding is disabled by default: Mac and WSL may each already run
their own Executor daemon. In particular, avoid binding Mac port 4789 if your
local Executor uses it. A forwarded WSL daemon is selected explicitly through
your Executor client's connection settings; this installer does not replace
your local daemon or change stored tool credentials.

Every tunnel and relay listener is loopback-only. If the WSL SSH server forces
reverse listeners onto all interfaces (`GatewayPorts yes`), installation rolls
back. Use `GatewayPorts no` or `clientspecified` on that SSH server.

## Use from WSL

Clone this repo on WSL and run `npm link --ignore-scripts` there too. WSL clients
do not need the Mac-only browser dependency. The Mac
installer writes WSL settings to `~/.config/remote-access/`.

```sh
remote-access status
remote-access mac -- pwd
remote-access mac -- ls /Users/YOUR_MAC_USER/Documents
remote-access mac -- sh -lc 'printf "Command running on %s\n" "$(hostname)"'
# Interactive shell:
remote-access mac
```

For file transfer, standard SSH tools use the generated connection config:

```sh
sftp -F ~/.config/remote-access/mac-ssh.conf mac-remote
scp -F ~/.config/remote-access/mac-ssh.conf ./example.txt mac-remote:Downloads/
```

SSH access does not automatically mount Mac folders in WSL or grant desktop
automation permissions. Assistants running on WSL can use this SSH connection
through their terminal tools; installing it does not add a shell tool to Executor.

For Executor, retain the `helium_mac` integration slug and its `org/default`
connection. Configure a stdio MCP server using `node` with these arguments:

- Mac: `"/Users/YOUR_MAC_USER/Library/Application Support/remote-access/runtime/browser-client.mjs", "19222"`
- WSL: `"/home/YOUR_WSL_USER/.config/remote-access/browser-client.mjs", "9223"`

Use the configured browser local/remote ports if you changed the defaults.
The Mac installer copies `src/browser-client.mjs` to the WSL path; the client
has no dependencies.
Use an absolute Node executable available to Executor on each machine.
Keep this client persistent (`spawnPerCall: false`). If Executor requires
removing/re-registering an existing integration, first save its configuration
and restore the same slug and connection name. Other integrations are unchanged.
The installer does not change Executor settings automatically. It creates a
private `browser-token` beside each installed client; MCP clients must present
that token to use the shared service. Keep it outside Git. Reinstalls retain the
token, and passive status queries never authenticate a browser-control session.

Browser tools and screenshots now run on the Mac. File-writing tools use the
Mac filesystem and negotiated MCP roots, not WSL paths. Transfer needed files
with the Mac SSH connection.

### Open web links from remote Linux

Browser control and opening web links are separate entry points. To open a URL
in your existing Mac Helium session from WSL (requires `macLogin`):

```sh
remote-access open 'https://example.com/'
remote-access browser-install
export BROWSER="$HOME/.local/bin/remote-access-browser"
```

`browser-install` snapshots the dependency-free opener into the WSL application
data directory and installs per-user `xdg-open`, `sensible-browser` and
`www-browser` helpers. Keep `~/.local/bin` before system directories on PATH;
persist `BROWSER` in your shell environment and service environment for clients
that use it. The helpers use Mac SSH to ask the running Helium app to open the
URL. These are ordinary user-owned tabs, independent of an MCP client exiting.
Browser automation keeps using the approved shared browser manager. The opener
does not launch a browser if Helium is closed. Installation saves files in private
backups. Non-web `xdg-open` arguments continue to the system helper.

The opener confirms the Mac URL-open command before returning success. This
confirms dispatch, not page loading or authentication. A missing tunnel, closed
Helium or failed Mac command returns a nonzero exit status.
It does not print URLs, which can contain login codes, and does not replay an
uncertain navigation automatically. It accepts HTTP/HTTPS URLs only.

Addresses are resolved by the Mac browser. The configured app tunnel makes
WSL port 8080 reachable at Mac `http://localhost:8080`; other WSL localhost
ports need their own forwarding. An OAuth callback to a temporary WSL
localhost port is not made reachable merely by opening its login page on the
Mac. Use that provider's remote login/code flow in an interactive terminal,
keep its process alive until credentials are saved, and verify authentication
on WSL afterward. Do not run interactive login processes from session hooks
with disconnected input.

## Status, upgrades and removal

```sh
remote-access status --json  # Nonzero when an enabled service is unavailable
remote-access logs
remote-access stop
remote-access start
remote-access restart
remote-access uninstall
```

`status` checks the managed process and enabled services. Browser checks are
passive: they read the shared service's connection state without connecting to
Helium. `ready` means an approved connection is still open; `available` means
debugging metadata is present but control has not been approved; it is not proof
of usable browser control. `waiting-for-approval` and `unavailable` return a
nonzero status. Legacy browser checks report only TCP reachability as
`available`, never upgrade to WebSocket, and do not prove approval. Shared
browser JSON status includes a connection ID/count so reuse can be verified.
Missing apps and disabled Remote Login are reported independently.
The connection does not start Docker, WSL, apps or
Executor. Reboot/sleep recovery also requires those services to resume.

The installed runtime is copied into the Mac application-data directory, so
moving or deleting this checkout does not break autostart. If you move or
reclone it, run `npm link --ignore-scripts` from the new checkout to restore
the CLI link; the saved configuration and installed connection stay in place.
After a code update, run `npm ci --ignore-scripts` and
`remote-access install` again. Reinstall after a Node installation-path change too. The SSH
alias is resolved at install time without inherited port forwards; reinstall
after changing its destination or authentication settings.

Uninstall removes only the new LaunchAgent. It retains private configuration,
logs, migration backups and Mac SSH authorization. To revoke Mac access,
remove the key line ending in `remote-access-mac` from the Mac's
`~/.ssh/authorized_keys` and remove the WSL `mac_ed25519` key pair and
`mac-ssh.conf`. Turning off Mac Remote Login is a separate macOS setting.

To manually restore a migrated agent, stop this service, copy its backed-up
plist from `~/Library/Application Support/remote-access/backups/` into
`~/Library/LaunchAgents/`, then bootstrap that plist with `launchctl`. Restore
any archived helper to the path in the plist before bootstrapping it. For the
original Helium helper, copy `helium-tunnel-agent.py` from the backup's
`legacy-helpers/` directory to `~/.local/share/codex-browser/` if it was archived
there. Keep the helper or its backup until you no longer need to restore the
old agent.

For Ender, enable `pnpm remote:access enable` on WSL and start/restart the
worktree with `pnpm dev`. Its existing `.localhost:8080` URLs and shared OAuth
callbacks are unchanged. Other apps can use the `app` forward with their own
gateway or fixed service port.

## Development

The shared service uses the pinned `chrome-devtools-mcp` package and its bundled
MCP/Puppeteer runtime. The installer copies that package into private runtime
storage; moving the checkout does not break autostart. Updating this dependency
requires checking its BrowserManager/McpServer library interface.
Run `npm run check` for JavaScript syntax checks. Verify connection reuse,
client isolation, and passive status on a live Mac/WSL setup.
