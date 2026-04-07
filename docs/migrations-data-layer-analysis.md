# Migrations & Data Layer Analysis

## Overview

This document maps the configuration persistence, settings management, and startup migration system. It covers how user/project/policy configuration is stored on disk, merged at runtime, and evolved across versions through one-shot migrations.

---

## Architecture Summary

The data layer has three tiers:

1. **GlobalConfig** (`~/.claude.json`) — Single file, ~600-line TypeScript interface, stores per-user state across all projects (onboarding, feature flags, migration tracking, OAuth account, model preferences, notification settings, swarm/teammate config). Written via `saveGlobalConfig(updater)` with file locking and atomic-ish writes.

2. **ProjectConfig** (embedded in `GlobalConfig.projects[path]`) — Per-directory configuration keyed by git root or cwd. Stores allowed tools, MCP servers, trust dialog acceptance, worktree sessions. Updated via `saveCurrentProjectConfig(updater)`.

3. **Settings JSON** (multi-source, priority-merged) — The richest layer. Multiple `settings.json` files at different scopes are parsed, validated against a Zod schema, and deep-merged with `lodash-es/mergeWith`. Sources range from user-level (`~/.claude/settings.json`) to policy-level (remote MDM, registry, managed files).

Migrations run synchronously at startup before the UI renders, gated by `CURRENT_MIGRATION_VERSION` in `main.tsx`.

---

## Migration System

### Orchestration

**File:** `src/main.tsx` (lines 326-348)

```
CURRENT_MIGRATION_VERSION = 11

runMigrations():
  if globalConfig.migrationVersion != CURRENT_MIGRATION_VERSION:
    run all 11 migrations
    saveGlobalConfig { migrationVersion: CURRENT_MIGRATION_VERSION }
```

Migrations are **sync** (block startup) except for `migrateChangelogFromConfig()` which is fire-and-forget. The version gate ensures migrations only run once per user — after the first run, `migrationVersion` matches and the entire block is skipped.

### Migration Catalog (11 migrations)

#### Settings Migrations (move config from legacy locations to settings.json)

| # | Migration | From | To | Trigger Condition |
|---|-----------|------|----|-------------------|
| 1 | `migrateAutoUpdatesToSettings` | `globalConfig.autoUpdates` | `userSettings.env.DISABLE_AUTOUPDATER` | `autoUpdates === false` and not protected for native |
| 2 | `migrateBypassPermissionsAcceptedToSettings` | `globalConfig.bypassPermissionsModeAccepted` | `userSettings.skipDangerousModePermissionPrompt` | Field exists in global config |
| 3 | `migrateEnableAllProjectMcpServersToSettings` | `projectConfig.{enableAllProjectMcpServers, enabledMcpjsonServers, disabledMcpjsonServers}` | `localSettings.{enableAllProjectMcpServers, enabledMcpjsonServers, disabledMcpjsonServers}` | Any field exists in project config |

#### Model Migrations (alias updates as new models release)

| # | Migration | From | To | Guard |
|---|-----------|------|----|-------|
| 4 | `migrateFennecToOpus` | `fennec-latest*`, `fennec-fast-latest`, `opus-4-5-fast` | `opus`, `opus[1m]` + `fastMode: true` | `USER_TYPE === 'ant'` (internal only) |
| 5 | `migrateLegacyOpusToCurrent` | `claude-opus-4-*` explicit strings | `opus` alias | `firstParty` provider + legacy remap enabled |
| 6 | `migrateOpusToOpus1m` | `opus` in userSettings | `opus[1m]` | `isOpus1mMergeEnabled()` (Max/Team Premium on 1P) |
| 7 | `migrateSonnet1mToSonnet45` | `sonnet[1m]` | `sonnet-4-5-20250929[1m]` | `firstParty` + `!sonnet1m45MigrationComplete` |
| 8 | `migrateSonnet45ToSonnet46` | `sonnet-4-5-*` explicit strings | `sonnet` or `sonnet[1m]` alias | `firstParty` + Pro/Max/Team Premium subscriber |

#### Dialog/UI Migrations

| # | Migration | Purpose | Guard |
|---|-----------|---------|-------|
| 9 | `resetAutoModeOptInForDefaultOffer` | Clears `skipAutoPermissionPrompt` when user accepted old 2-option dialog but doesn't have auto as default — re-surfaces new dialog with "make it my default" option | `TRANSCRIPT_CLASSIFIER` feature + `enabled` state + `!hasResetAutoModeOptInForDefaultOffer` |
| 10 | `resetProToOpusDefault` | Marks Pro 1P users as migrated to Opus 4.5 default; shows one-time notification for users on default model | `!opusProMigrationComplete` |
| 11 | `migrateReplBridgeEnabledToRemoteControlAtStartup` | Renames `replBridgeEnabled` config key to `remoteControlAtStartup` | Old key exists + new key undefined |

### Migration Patterns

**Idempotency strategy:** Each migration reads from the specific source it would write (usually `userSettings`), so re-running on an already-migrated user is a no-op. No migration uses a separate "completed" flag — the absence of the old value is the completion signal. Exceptions:
- `migrateSonnet1mToSonnet45` uses `sonnet1m45MigrationComplete` flag
- `resetProToOpusDefault` uses `opusProMigrationComplete` flag
- `resetAutoModeOptInForDefaultOffer` uses `hasResetAutoModeOptInForDefaultOffer` flag
- All migrations write to `migrationVersion` as a bulk skip gate

**Safety pattern:** Migrations catch errors and log via `logError` + analytics events rather than throwing — a failed migration must not break startup.

**Analytics:** Every migration emits a `tengu_*` analytics event for tracking adoption and failure rates.

---

## Configuration Storage

### GlobalConfig (`~/.claude.json`)

**File:** `src/utils/config.ts`

Single JSON file at `~/.claude.json` (path from `getGlobalClaudeFile()`). Contains:

- **Identity:** `userID`, `oauthAccount` (AccountInfo with email, org, billing type)
- **Preferences:** `theme`, `editorMode`, `diffTool`, `verbose`, `autoCompactEnabled`, `showTurnDuration`, `copyFullResponse`, `flickerFreeMode`
- **Model/Provider:** `teammateMode` ('auto'|'tmux'|'in-process'), `teammateDefaultModel`, `providerProfiles`, `activeProviderProfileId`
- **Feature flags:** `todoFeatureEnabled`, `speculationEnabled`, `permissionExplainerEnabled`
- **Migration tracking:** `migrationVersion`, `legacyOpusMigrationTimestamp`, `sonnet1m45MigrationComplete`, `sonnet45To46MigrationTimestamp`, `opusProMigrationComplete`, `hasResetAutoModeOptInForDefaultOffer`
- **Caches:** `cachedStatsigGates`, `cachedGrowthBookFeatures`, `groveConfigCache`, `s1mAccessCache`, `clientDataCache`, `additionalModelOptionsCache`
- **Notifications:** `preferredNotifChannel`, `taskCompleteNotifEnabled`, `inputNeededNotifEnabled`, `agentPushNotifEnabled`
- **IDE/terminal:** `autoConnectIde`, `iterm2SetupInProgress`, `appleTerminalSetupInProgress`, `deepLinkTerminal`
- **Swarm/teams:** `teammateMode`, `tungstenPanelVisible`

**Write path:** `saveGlobalConfig(updater)` — reads current config, applies updater function, acquires `proper-lockfile` lock, writes with `0o600` permissions, updates write-through cache. Has auth-loss prevention guard (`wouldLoseAuthState`) that refuses to write a config missing `oauthAccount` or `hasCompletedOnboarding` when the in-memory cache still has them.

**Read path:** `getGlobalConfig()` — session-level cache with `fs.watchFile` freshness polling (1s interval). First read is sync I/O (acceptable — runs before UI render).

**Backup strategy:** Before every write, timestamps backup stored in `~/.claude/backups/` (max 5, min 60s between creations). On corruption, defaults returned with stderr warning pointing to backup restoration command.

### ProjectConfig

Embedded in `GlobalConfig.projects[path]` where `path` = git root or normalized cwd. Stores per-project tool allowances, MCP server configs, trust dialog state, worktree session info. Updated via `saveCurrentProjectConfig(updater)` which locks the same `~/.claude.json` file.

---

## Settings System (Multi-Source Merge)

**File:** `src/utils/settings/settings.ts`

### Setting Sources (low to high priority)

```
userSettings  →  projectSettings  →  localSettings  →  flagSettings  →  policySettings
~/.claude/       .claude/           .claude/          CLI --flags      MDM/remote
settings.json    settings.json      settings.local.json                 managed-settings.json
```

### Merge Strategy

Uses `lodash-es/mergeWith` with a custom `settingsMergeCustomizer`:
- **Arrays:** concatenated and deduplicated (`uniq([...target, ...source])`)
- **Objects:** deep-merged recursively
- **Scalars:** source replaces target
- **`undefined` values:** treated as deletion (key removed from result)

### Validation

All settings files parsed through `SettingsSchema()` (Zod v4). Invalid files return `{ settings: null, errors: [...] }`. Permission rules are filtered individually before schema validation so one bad rule doesn't reject the entire file.

### Policy Settings ("First Source Wins")

Unlike other sources that merge, `policySettings` uses "first source wins" with this priority:
1. Remote managed settings (from API sync cache)
2. Admin MDM (HKLM on Windows, plist on macOS)
3. File-based managed settings (`managed-settings.json` + `managed-settings.d/*.json` drop-ins)
4. HKCU settings (user-writable registry on Windows)

### Managed File Settings (Drop-in Pattern)

Follows systemd/sudoers drop-in convention:
- Base file: `managed-settings.json` (lowest precedence)
- Drop-ins: `managed-settings.d/*.json` sorted alphabetically, later files win
- Enables independent policy fragments without coordinating edits to a single file

### Cache Strategy

- **Per-source cache:** `getCachedSettingsForSource(source)` — invalidated by `resetSettingsCache()` on writes
- **Session cache:** `getSessionSettingsCache()` — single cached result of full merge, invalidated on file changes
- **Parsed file cache:** `getCachedParsedFile(path)` — per-file parse result with validation errors

---

## Locking Strategy

| Resource | Mechanism | Location |
|----------|-----------|----------|
| `~/.claude.json` | `proper-lockfile` (sync) | `saveConfigWithLock()` |
| Team `config.json` | `proper-lockfile` (async, 10 retries, 5-100ms) | `src/utils/swarm/teamHelpers.ts` |
| Mailbox files | `proper-lockfile` | Mailbox read/write |
| Settings files | None (single-writer assumption via `updateSettingsForSource`) | `src/utils/settings/settings.ts` |
| Team memory | None | `src/utils/teamMemoryOps.ts` |

---

## Data Flow Diagram

```
Startup:
  runMigrations()
    └─ reads globalConfig.migrationVersion
    ├─ if mismatched: runs all 11 migrations
    └─ writes migrationVersion = 11

  enableConfigs()
    └─ getConfig() with throwOnInvalid
        └─ reads ~/.claude.json (sync, once)
            └─ sets up fs.watchFile freshness watcher

  getInitialSettings()
    └─ loadSettingsFromDisk()
        ├─ plugin settings (base)
        ├─ userSettings (~/.claude/settings.json)
        ├─ projectSettings (.claude/settings.json)
        ├─ localSettings (.claude/settings.local.json)
        ├─ policySettings (first source wins: remote > MDM > file > HKCU)
        └─ flagSettings (file + inline SDK)
            └─ mergeWith(customizer) → mergedSettings

Runtime:
  saveGlobalConfig(updater)
    └─ lock ~/.claude.json
        ├─ re-read current config (stale write detection)
        ├─ auth-loss guard (wouldLoseAuthState)
        ├─ apply updater
        ├─ backup existing config (timestamped, max 5)
        ├─ filter defaults (pickBy)
        ├─ write with 0o600 permissions
        └─ write-through cache update

  updateSettingsForSource(source, settings)
    └─ read existing settings for source
        ├─ mergeWith(existing, settings, customizer)
        ├─ markInternalWrite(filePath)
        ├─ write file
        └─ resetSettingsCache()
```

---

## Key Observations

1. **Single-writer assumption for settings files:** `updateSettingsForSource` has no file locking — it assumes only one process writes to a given settings file at a time. This is safe for local CLI usage but could race if two Claude instances modify the same file concurrently.

2. **Auth-loss prevention is critical:** The `wouldLoseAuthState` guard in `saveGlobalConfig` and `saveConfigWithLock` prevents a known bug (GH #3117) where concurrent writes could corrupt `~/.claude.json` mid-parse, causing the fallback-to-defaults path to wipe OAuth credentials.

3. **Migration version gate is a performance optimization:** Without it, 11 migrations each calling `getGlobalConfig` + `saveGlobalConfig` would run on every startup, acquiring/releasing the config lock 11 times unnecessarily.

4. **Settings validation is permissive:** When a file fails Zod validation but parses as valid JSON, the raw data is used as-is for `updateSettingsForSource` merges. This means invalid settings can accumulate but won't block writes.

5. **Policy "first source wins" vs regular "merge all":** The asymmetry between policy settings (first source wins) and regular settings (full merge) is intentional — policy sources represent mutually exclusive administrative channels, while user/project/local settings are complementary layers of preference.

---

*Report generated 2026-04-07 — Migrations & Data Layer analysis*
