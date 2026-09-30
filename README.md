# Managed plugin enforcement evidence

## Managed plugin enforcement

Source: `microsoft/vscode-internalbacklog#8906`

Dev build `1.141.0` on macOS arm64:

1. Start with an isolated empty plugin inventory.
2. Verify policy installs `managed-hook-plugin@managed-hook-marketplace` without confirmation.
3. Attempt the organization-managed toggle and verify the managed plugin remains enabled and locked.

Artifacts:

- `managed/report.html`
- `managed/manifest.json`
- `managed/videos/annotated.mp4`
- `managed/videos/recording-1.webm`
- `managed/01-MP-01-passed.png`
- `managed/02-MP-02-passed.png`

The captioned MP4 was rendered with Homebrew `ffmpeg-full`.

## Repository plugin activation

Source: `microsoft/vscode#336858`

The scenario starts with an isolated empty plugin inventory, publishes trusted `.github/copilot/settings.json` entries with `enabledPlugins: true` and `autoUpdate: true`, and verifies the plugin installs without a trust dialog and becomes workspace-active.

Artifacts:

- `repository/report.html`
- `repository/manifest.json`
- `repository/videos/annotated.mp4`
- `repository/videos/recording-1.webm`
- `repository/01-RP-01-passed.png`
- `repository/02-RP-02-passed.png`
- `repository/03-RP-03-passed.png`

## Copilot CLI

The managed-plugin E2E test verifies that an unavailable required plugin leaves a normal prompt in the composer, keeps the agent idle, and shows the recovery command.

Artifact:

- `runtime/a_missing_required_plugin_blocks_normal_prompts_and_preserves_the_composer.png`
