# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-12

### Added

- Initial release
- Display z.ai token usage percentage in the VS Code status bar
- Show time remaining until quota resets (`nextResetTime`) when available
- Secure API key storage via VS Code Secret Storage
- Configurable refresh interval (`zaiUsage.refreshInterval`, default 60s)
- Toggle between z.ai icon and text prefix (`zaiUsage.useIcon`)
- Command: `z.ai Usage: Set API Key` — enter and verify your z.ai API token
- Command: `z.ai Usage: Clear API Key` — remove the stored API token
- Status bar click triggers API key setup dialog when unauthenticated
- Cache invalidation when `nextResetTime` has passed
