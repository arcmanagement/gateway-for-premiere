# Gateway for Premiere

Gateway for Premiere is a local bridge that lets AI agents and human editors work on the same Adobe Premiere Pro project and sequence. The CLI sends requests to a fixed-token loopback broker, and an invisible Premiere UXP plugin reads and edits the active Premiere DOM.

The Premiere project remains the source of truth. XML can still be used for rough cuts and interchange, but it does not replace the native project after a human has added effects, transitions, audio edits, captions, or Dynamic Link content.

## Requirements

- macOS or Windows
- Adobe Premiere Pro 26.3 or later
- The Gateway for Premiere CCX installed through Adobe Exchange or Creative Cloud Desktop

## Supported operations

- Inspect the active project and sequence.
- Capture a stable editing snapshot by reading project items and the timeline twice and accepting only matching identities and revisions.
- Inspect project items, video, audio, and caption track identities, clip placement, mute state, markers, effects, parameters, speed, and reverse state.
- Save a project or create a non-overwriting `.prproj` backup.
- Import media with project-item revision and postcondition checks.
- Remove unused media items and empty bins.
- Insert, overwrite, trim, move, clone, remove, rename, enable, or disable clips with revision checks.
- Rename video and audio tracks.
- Add, update, move, and remove sequence markers.
- Insert a `.mogrt` file and edit public primitive component parameters.
- Add and remove video or audio effects.
- Edit static parameters and keyframes.
- Add and remove video transitions.
- Export a sequence with an explicit Premiere or Adobe Media Encoder preset.
- Serialize requests in both the broker and plugin.
- Record write outcomes in a persistent UXP request journal and fail closed after uncertain outcomes.

Gateway for Premiere does not expose arbitrary JavaScript, ExtendScript, or QE DOM. Every write command, including project save, always requires the expected project GUID, sequence GUID, and timeline revision. Confirmation behavior is controlled by the broker's approval mode.

## Architecture

```text
gateway-for-premiere CLI
        | fixed-token HTTP on 127.0.0.1
        v
local broker
        | Origin file:// + fixed-token WebSocket
        v
Premiere UXP Plugin --> Premiere DOM --> active project / sequence
```

MCP is not part of the initial entry point. If typed tool discovery, event subscriptions, or multiple clients become necessary, MCP should be added as an adapter over the same broker contract.

## Install the companion

### Windows installer (recommended on Windows)

Open the [latest GitHub release](https://github.com/arcmanagement/gateway-for-premiere/releases/latest), download `Gateway-for-Premiere-<version>-Windows.exe`, and run it. The per-user installer includes x64 and Arm64 Node.js runtimes, adds the `gateway-for-premiere` command to the user PATH, and starts the loopback broker automatically. Administrator access, Homebrew, npm, login, API key, and pairing are not required.

Open a new PowerShell window after installation, then run:

```powershell
gateway-for-premiere doctor
```

The public installer should be Authenticode-signed. An unsigned build is suitable for isolated functional testing, but Windows SmartScreen may warn before installation.

### macOS installer (recommended)

Open the [latest GitHub release](https://github.com/arcmanagement/gateway-for-premiere/releases/latest), download `Gateway-for-Premiere-<version>-macOS-universal.pkg`, and double-click it. The installer:

- supports both Apple Silicon and Intel Macs;
- includes its own Node.js runtime;
- installs the `gateway-for-premiere` command; and
- installs and starts the per-user local broker automatically.

No Homebrew, npm, account, API key, or pairing step is required. After installation, open a writable Premiere Pro project with an active sequence and run:

```bash
gateway-for-premiere doctor
```

The release installer must be signed with a Developer ID Installer certificate and notarized by Apple. Do not distribute an unsigned development build to reviewers.

If Gateway for Premiere is already installed with Homebrew or npm, remove that installation before using the package installer. The package refuses to overwrite a command managed by another installer.

### Homebrew

Register this repository as the Homebrew tap, then install the CLI:

```bash
brew tap arcmanagement/gateway-for-premiere https://github.com/arcmanagement/gateway-for-premiere
brew install gateway-for-premiere
gateway-for-premiere daemon install
gateway-for-premiere doctor
```

Homebrew installs the required Node.js runtime automatically. This route is intended for users who already use Homebrew; Adobe reviewers can use the package installer above.

If you installed from the former dedicated tap, point the existing tap at this repository before upgrading:

```bash
brew untap arcmanagement/gateway-for-premiere
brew tap arcmanagement/gateway-for-premiere https://github.com/arcmanagement/gateway-for-premiere
brew upgrade gateway-for-premiere
```

Alternatively, install Node.js 22 or later and the immutable package attached to the release tag:

```bash
npm install --global https://github.com/arcmanagement/gateway-for-premiere/releases/download/v0.1.4/arcmanagement-gateway-for-premiere-0.1.4.tgz
gateway-for-premiere daemon install
gateway-for-premiere doctor
```

The CCX is installed through Adobe Exchange or Creative Cloud Desktop. The companion runs the loopback broker on the same computer. No PAT, Keychain entry, pairing step, third-party account, or cloud service is required.

`plugin build` is intended for source checkouts that create a CCX. Normal Marketplace users install the CCX and do not need the plugin compiler.

### If the plugin keeps reconnecting

Run these checks from Terminal or PowerShell:

```bash
gateway-for-premiere daemon status
gateway-for-premiere doctor
```

`daemon status` must report `installed: true`, `loaded: true`, and `state: running`. `doctor` must report a connected plugin session after Premiere Pro opens the installed CCX. If the daemon is not running, reinstall it and inspect the local log:

```bash
gateway-for-premiere daemon install
tail -n 100 "$HOME/Library/Logs/gateway-for-premiere.log"
```

On Windows, the log is `%LOCALAPPDATA%\Gateway for Premiere\gateway-for-premiere.log`.

The broker listens only on `127.0.0.1`; do not change it to a public interface. Restart Premiere Pro after installing or updating the CCX, then run `gateway-for-premiere doctor` again.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run verify:dist
npm link
```

`plugin/dist/` and `plugin/marketplace-dist/` are generated. The root `dist/` is committed as a release artifact so the CLI package can be installed without a compiler. CI rebuilds it and verifies that it matches `src/`.

## Local development plugin

```bash
npm run build:server
node dist/cli/index.js plugin build
node dist/cli/index.js daemon install
```

Add `plugin/dist/manifest.json` to Adobe UXP Developer Tool, then open `Window > UXP Plugins > Gateway for Premiere` in Premiere Pro.

The development panel reconnects to the broker after it has been opened once. The CLI does not bring Premiere or a panel to the foreground for each command. Use `status` to check the connection.

## Marketplace plugin package

Use UXP Developer Tool's `Package...` action to create the CCX, then verify the package:

```bash
node dist/cli/index.js plugin build --mode invisible --distribution marketplace
npm run verify:ccx
```

The Adobe Developer Distribution plugin ID is `ac804039`. Marketplace builds always use this fixed ID and are separated from development builds.

`verify:ccx` checks the Marketplace ID, host, invisible launch mode, package files, source manifest semantics, exact `index.html` and `index.js` bytes, fixed protocol token, absence of obsolete secrets, and the 50 MB limit.

The fixed public protocol token is `gateway-for-premiere`. It is not used as a credential. HTTP requires it in a custom header to prevent accidental browser access to the loopback API. Plugin WebSocket connections accept only the measured Premiere UXP origin `file://` and reject HTTP(S) browser origins.

The invisible application-launch mode does not add a visible panel to Premiere's menu. Use the CLI `status` or `doctor` command to verify the session.

## Build the macOS installer

The release package embeds the official Node.js arm64 and x64 runtimes and verifies them against Node.js's published SHA-256 checksums:

```bash
npm run build:installer
npm run verify:installer
```

Unsigned packages are for local package inspection only. For a public GitHub release, set the external-distribution installer identity and a configured notarytool Keychain profile:

```bash
MACOS_INSTALLER_SIGNING_IDENTITY="Developer ID Installer: ArcManagement Inc (TEAM_ID)" \
MACOS_NOTARY_PROFILE="gateway-for-premiere" \
npm run build:installer
npm run verify:installer
```

The build writes the `.pkg` and its SHA-256 file to `release/`. Never publish the package unless `verify:installer` reports `signed` and `xcrun stapler validate` succeeds.

## Build the Windows installer

The Windows release embeds the official Node.js x64 and Arm64 runtimes, verifies their published SHA-256 checksums, and uses Inno Setup 6:

```powershell
npm run build:installer:windows
npm run verify:installer:windows
```

The build writes the `.exe` and its SHA-256 file to `release/`. For public distribution, sign the installer with an Authenticode code-signing certificate and require `npm run verify:installer:windows:release` to pass before publishing.

## Managed daemon

The broker is installed as a macOS LaunchAgent or a per-user Windows Scheduled Task and starts at login:

```bash
gateway-for-premiere daemon status
gateway-for-premiere daemon stop
gateway-for-premiere daemon start
gateway-for-premiere daemon restart
gateway-for-premiere daemon uninstall --confirm
```

The broker owns the approval mode, so an individual CLI call cannot grant itself broader access. The default is `ask`:

```bash
# Ask for every mutation (default)
gateway-for-premiere daemon approval-mode ask

# Automatically approve the low-risk, undoable allowlist
gateway-for-premiere daemon approval-mode auto

# Do not require --confirm for any allowlisted Gateway mutation
gateway-for-premiere daemon approval-mode bypass
```

`ask` requires `--confirm` on every mutation. `auto` omits confirmation only for track renames and non-destructive marker additions or changes, all through Premiere Actions. `bypass` omits confirmation for every implemented mutation, including destructive operations and exports. All three modes still enforce the typed operation allowlist, loopback and UXP-origin gates, active project and sequence identity, expected revisions, serialized execution, and the request journal. Bypass mode never enables arbitrary JavaScript, ExtendScript, QE DOM, raw network requests, or raw filesystem primitives; file-capable operations remain separately typed and allowlisted.

## Inspect the active edit

```bash
gateway-for-premiere doctor
gateway-for-premiere status
gateway-for-premiere snapshot --depth 4
gateway-for-premiere project
gateway-for-premiere project recovery
gateway-for-premiere project items --depth 4
gateway-for-premiere sequence
gateway-for-premiere capabilities
gateway-for-premiere journal --limit 20
```

`doctor` reports the fixed protocol access mode, managed daemon, broker connection, Premiere version, plugin session, request journal, active project, and active sequence. It refreshes the current project and sequence from every connected session before reporting readiness; `ok` is true only when a supported Plugin session has a ready journal, an active project, and an active sequence. A live session proves that the plugin is connected, but the wire protocol cannot determine whether it was loaded by UXP Developer Tool or by an installed CCX. Verify a cold start by closing UXP Developer Tool, restarting Premiere, and observing the automatic session.

`snapshot` reads the full project-item tree once per observation, projects the requested depth from the same in-memory tree, and observes project items and the timeline twice in one plugin request. It returns only when the project identity, sequence identity, project-item revision, timeline revision, and embedded identities match in both observations. If a human edits during the read, it retries up to three times and then stops without producing a diff.

## Revision-checked edits

Use the GUIDs and revision returned by `sequence` or `snapshot`:

```bash
gateway-for-premiere timeline trim \
  --item-ref video:0:0 \
  --expect-revision REVISION \
  --expect-project PROJECT_GUID \
  --expect-sequence SEQUENCE_GUID \
  --end-seconds 8.5 \
  --confirm
```

If the active project, sequence, or timeline changed after the snapshot, the mutation fails. Capture a new snapshot and recalculate the intended diff.

Requests for one Premiere session are serialized by both the broker and the plugin. The broker passes an execution-start deadline to the plugin, and the plugin checks it before a transaction or export. Once a write has been dispatched, the broker waits for the plugin's success or failure response instead of timing out independently.

Every mutation receives a request ID. Reusing the same ID does not replay the operation when the UXP journal already contains it. Supply an explicit ID with `--request-id REQUEST_ID` when reconciling an uncertain call.

The journal is stored as `request-journal-v1.json` in the plugin-specific UXP data folder. It stores operation names, project and sequence GUIDs, revisions, status, timestamps, and digests. It does not store raw payloads, media paths, or result bodies. Terminal entries are retained for seven days and up to 500 records. Unresolved `unknown_outcome` entries are never pruned automatically.

If Premiere or the plugin exits while a request is running, the entry becomes `unknown_outcome` on the next launch. It is never replayed automatically. Reconcile it against `journal` and the current `sequence`.

List every supported command with:

```bash
gateway-for-premiere --help
```

### Insert or overwrite a clip

```bash
gateway-for-premiere timeline insert \
  --project-item PROJECT_ITEM_ID \
  --time-seconds 5 \
  --video-track 0 \
  --audio-track 0 \
  --mode overwrite \
  --expect-project PROJECT_GUID \
  --expect-sequence SEQUENCE_GUID \
  --expect-revision REVISION \
  --confirm
```

### Rename a track

```bash
gateway-for-premiere timeline track rename \
  --media-type audio \
  --track 0 \
  --name Dialogue \
  --expect-project PROJECT_GUID \
  --expect-sequence SEQUENCE_GUID \
  --expect-revision REVISION \
  --confirm
```

### Back up a project

```bash
gateway-for-premiere project backup \
  --output /absolute/path/project.gateway-backup.prproj \
  --expect-project PROJECT_GUID \
  --confirm
```

Existing backup files are never overwritten. `project recovery` reports the active project identity and Premiere's Auto Save location. It preserves symbolic values such as `SameAsProject` or `MyDocuments`. Premiere's public UXP API does not expose whether Auto Save is enabled, its interval, or its retention count, so those fields are reported as location-only rather than inferred.

### Export a sequence

```bash
gateway-for-premiere sequence export \
  --output /absolute/path/output.mov \
  --preset /absolute/path/preset.epr \
  --expect-project PROJECT_GUID \
  --expect-sequence SEQUENCE_GUID \
  --expect-revision REVISION \
  --confirm
```

Exports never overwrite an existing file. The output extension must match the selected Premiere or Adobe Media Encoder preset.

## Initial release boundaries

- Backups are explicit. Automatic backup before every mutation is not implemented.
- Media import does not have an undoable Adobe Action. It is guarded by project, sequence, timeline, and project-item revisions, the request journal, and a new-item postcondition.
- Caption track identity, name, mute state, media type, and item count are visible. Premiere 26.3 does not expose a public caption-item read/write contract, so native caption-item editing is unsupported. A sequence with caption items is marked `opaque-captions` and normal mutations stop unless `--allow-incomplete-revision true` is explicitly supplied after visual review.
- Dynamic Link editing is unsupported.
- MOGRT insertion is supported. Public primitive parameters can be edited. Source text represented by an unavailable `TextDocument` value is not edited and causes incomplete revision protection.
- Static parameter edits reject existing time-varying parameters. Keyframe commands include time, value, and interpolation in the revision.
- Clip speed and reverse state are readable but not writable because Premiere Pro 26.3 does not expose public Actions for them.
- Premiere Pro 26.3.2 can expose some transitions as opaque `null` slots. Such a snapshot is marked `opaque-transitions`, and mutations stop unless `--allow-opaque-transitions true` is explicitly supplied after visual review.
- Missing component chains produce `incomplete-components` or `multiple-incomplete` reliability. Mutations stop unless `--allow-incomplete-revision true` is explicitly supplied after visual review.
- UXP Developer Tool's `Load & Watch` does not survive a Premiere restart. Marketplace builds use Adobe's invisible application-launch mode and must be cold-start tested from an installed CCX.
- The plugin manifest allows only `ws://localhost:1966`, while the broker listens only on `127.0.0.1`. Premiere Pro 26.3.2 rejects an IP-literal manifest entry, so the manifest uses `localhost`.

## References

- [Premiere UXP API](https://developer.adobe.com/premiere-pro/uxp/)
- [Premiere DOM API](https://developer.adobe.com/premiere-pro/uxp/ppro_reference/)
- [UXP Network Operations](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/network/)
- [Adobe Premiere UXP samples](https://github.com/AdobeDocs/uxp-premiere-pro-samples)
- [Package a UXP plugin](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/package/)
- [Install a UXP plugin](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/install/)
- [UXP Panels and Commands](https://developer.adobe.com/premiere-pro/uxp/plugins/concepts/panels-and-commands/)
- [Building your first UXP plugin: Invisible plugins](https://developer.adobe.com/premiere-pro/uxp/plugins/)
- [video-skills Issue #1](https://github.com/arcmanagement/video-skills/issues/1)
