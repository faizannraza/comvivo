# First-party plugins

This directory holds Comvivo's own plugins, each a workspace package in its own right. They
exist to prove the plugin SDK against real code and to ship a few genuinely useful
integrations.

Nothing lives here until **M12**, which adds `weather`, `ics` (opt-in) and `homeassistant`
(`docs/plan/14-milestones.md`, tasks `M12-T21`–`M12-T23`).

The workspace glob `packages/plugins/*` picks up anything added here automatically.
