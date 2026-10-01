# Agent instructions

- Keep this repository about Mac/WSL connectivity. App gateways and OAuth
  routing belong in their application repositories.
- Personal settings, credentials, keys, generated agents and browser profiles
  stay outside Git. Do not commit live machine configuration.
- Preserve existing signed-in browser profiles. Do not launch a replacement
  browser or modify unrelated LaunchAgents/Executor integrations.
- Keep all new listeners on loopback. Pin Mac host keys for reverse SSH access.
- Back up selected old jobs and restore them when migration fails. Retire only
  explicitly selected jobs after verifying the replacement.
- Run `npm run check` after executable changes and report live checks separately
  from simulated launchd tests. Use Conventional Commits.
