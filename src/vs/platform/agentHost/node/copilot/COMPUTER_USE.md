# macOS Computer Use

Local Copilot SDK sessions discover the native Computer Use plugin bundled with
the platform-specific Copilot runtime. No user MCP configuration or separate
agent loop is required. The tools become available through the existing chat
tool pipeline, with native macOS and per-application consent on first use.

The SDK's `builtinPluginDirectories` contract registers the bundle before creating
sessions. The runtime owns the MCP transport, turn notifications, user-abort
handling, and managed permission enforcement. Agent Host uses its existing
elicitation UI, image results, and scoped customization enablement.

The macOS desktop Agent Host registers this plugin automatically. Standalone
macOS hosts require an explicit host-side opt-in; connecting a viewer never
enables desktop control. Ephemeral utility sessions keep Computer Use disabled.

## Working on the native helper

The native source lives in a separately licensed repository that is not part
of this source tree.
Build its macOS plugin using the instructions in that repository. The output
must contain the MCP executable, plugin manifests, and one complete native helper
application.

For an unbuilt VS Code checkout, point the local Agent Host at the build output:

```sh
VSCODE_COMPUTER_USE_PLUGIN_PATH=/absolute/path/to/computer-use/dist/plugin/darwin-arm64 ./scripts/code.sh
```

Use `darwin-x64` on Intel Macs. The override is ignored in packaged builds.
Invalid explicit overrides fail rather than silently running a different helper.
Restart the development window after changing the override or rebuilding.

macOS Accessibility and Screen Recording permissions belong to the helper app's
signed identity. Keep its development signing identity stable across rebuilds.
Neither building the helper nor registering its MCP tools grants those
permissions. Follow the native permission prompts when using a tool; do not
modify the TCC database or bypass a denied grant.

Use chat cancellation or the helper's Escape stop control to interrupt computer
use. Existing customization controls can disable the built-in server globally,
for a workspace, or for the current session.

## Exact-window input and foreground consent

The updated native helper validates keyboard recipients against the selected
window and control, rather than assuming that process-directed input reaches
the requested window. Actions remain background-first. If no safe background
candidate dispatched, the native server can ask through the existing elicitation
UI to bring that exact window forward for **one action**, then restore the prior
window. This approval is not cached on macOS and does not override app consent,
OS permissions, target validation, cancellation, or managed policy.
Foreground prompts require an active **Interactive** turn. Autopilot declines
elicitation prompts rather than granting foreground access automatically.

Declining the prompt does not authorize a foreground retry. Rejected, blocked,
interrupted, and uncertain-delivery outcomes are not retried automatically.
`DispatchedUnverified` means an action may already have changed the UI; inspect
the current state rather than blindly repeating it. Coordinate clicks remain
background-only.

These changes require the updated native bundle; registering an older released
helper does not add the new behavior.

## Live viewing and remote hosts

The Agents Window's **View Computer Use** action opens a player bound to the
selected host, session, and chat. Selecting another session never redirects an
existing player. The player is read-only: it shows only the application's window
that the native server has already authorized for that agent.

An updated native helper supplies H.264 video through the authenticated MCP
side channel, independently of model requests and chat history. Viewing is
on-demand, without audio or recording. Pausing, hiding, or closing a viewer
stops requests; the native capture expires when no viewer is requesting frames.
**Stop Agent** is separate from playback: it stops that chat's native control
and requests normal chat cancellation. Failure to reach the host must not be
shown as a successful stop.

Fullscreen retains the host identity and Stop Agent control. On macOS desktop,
content fullscreen expands in place without creating another Space or moving
away from the controlled application. Normal window fullscreen commands still
respect the user's native-fullscreen preference. The player's
Escape handling only exits fullscreen; when viewing on the computer that runs
the native agent, physical Escape also remains the helper's emergency stop.
Use the Exit Full Screen control to leave without invoking that host shortcut.

To opt in on a standalone macOS Agent Host, set
`VSCODE_AGENT_HOST_COMPUTER_USE=1` in that host's startup environment. For a
source build, also set `VSCODE_COMPUTER_USE_PLUGIN_PATH` on that host. The host
must have an interactive macOS desktop and its own explicit native app and OS
permissions. Each remote host owns its own helper, grants, and capture; no
viewer grants access to the viewer's local desktop.

The media resource `computer-use://video/live` returns versioned, bounded
batches of H.264 AVCC packets with microsecond timestamps, stream identity,
target identity, and decoder configuration. Viewers recover from target changes
or dropped packets at a keyframe rather than displaying stale deltas. Media
payloads are redacted from AHP transport logs. Native helpers without this
resource cannot provide live video and should be upgraded.

Native live capture currently requires macOS 12.3 or newer. If host URL
restrictions are configured, browser video is unavailable: a buffered frame
could contain a tab that was briefly blocked between policy checks. Native
application windows remain eligible under their normal permission checks.

## Packaging

macOS desktop and remote-server packaging retain the complete plugin from the
pinned Copilot platform package, outside ASAR where applicable. Other operating
systems exclude it. Remote registration remains opt-in. The native bundle
retains its upstream code signatures and entitlements;
VS Code must not re-sign the helper under a different identity.

The native source is not vendored into VS Code. Changes to binary distribution
or licensing require coordination with the upstream owners.

## Validation

The focused tests cover native bundle resolution, local-host restrictions,
development overrides, packaging/signature boundaries, automatic tool
availability, scoped disablement, host/chat routing, bounded video validation,
and media-log redaction. Provider-process validation must isolate
its Copilot home and avoid desktop capture or input without user consent.
