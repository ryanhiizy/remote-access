# Using Aside through Executor

Use the vendor `aside-browser` skill and `aside guide` for current browser APIs.
The Mac CLI is authoritative; WSL's `aside` forwards its arguments and streams
through the existing pinned SSH connection. File paths, downloads, delegated
shell commands and `aside skills install --path` therefore refer to the Mac.
Sync skills and transfer files through remote-access instead of installing a
second Aside runtime on WSL.

Executor `aside_mac` exposes native `repl`, `exec` and `memory_search`. Use `repl`
for exact UI assertions and evidence; `exec` delegates a task to Aside's own
agent and uses that agent's configured model/provider. Delegation can reduce
this chat's context but does not eliminate the delegated model's usage.
The CLI additionally exposes model/effort choices and session steering/queueing.

Keep explicit task-specific page handles and fresh variable names: the native
REPL persists bindings, while `page` changes when a tab is attached or opened.
Use snapshot diffs after actions; forward image content through Executor `emit`
when visual inspection is needed. Discover relevant site skills on demand with
`aside skills list` / `aside skills show`, rather than loading every skill.

Asidewright is Playwright-style, not a complete Playwright implementation.
Do not infer support for context tracing, network events or viewport setters
from Playwright documentation. Its installed browser objects provide
`page.console.logs()` and [video recording](recording.md). Undocumented internal
methods are version-dependent and should not become bridge dependencies.
