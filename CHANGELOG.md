# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-03-16

### Added

- Display mode setting for usage/remaining tokens (`zaiUsage.displayMode`) — choose between percentage, absolute numbers, or both

### Changed

- Update README with displayMode setting documentation
- Add GitHub workflow for adding project to codespaces
- Update README to reference GLM Coding Plan
- Add v0.2.0 changelog entry
- Format codebase

## [0.2.0] - 2026-03-13

### Added

- Configurable status bar priority (`zaiUsage.statusBarPriority`, default 10000) — allows positioning the z.ai Usage item adjacent to vscode-copilot-usage. Change takes effect after reloading the window.

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
