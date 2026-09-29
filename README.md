# Managed plugin enforcement evidence

## VS Code

Source: `microsoft/vscode-internalbacklog#8906`

Dev build `1.140.0` on macOS arm64:

1. Open Agent Customizations and trust the disposable local marketplace.
2. Verify policy automatically installs `managed-hook-plugin@managed-hook-marketplace`.
3. Verify the installed plugin is enabled and its organization-managed toggle is disabled.

Artifacts:

- `vscode/report.html`
- `vscode/manifest.json`
- `vscode/videos/recording-1.webm`
- `vscode/01-MP-01-passed.png`
- `vscode/02-MP-02-passed.png`
- `vscode/03-MP-03-passed.png`

The raw recording is complete. The local ffmpeg build lacked the `drawtext` filter, so the scenario runner could not render its optional caption band.

## Copilot CLI

The managed-plugin E2E test verifies that an unavailable required plugin leaves a normal prompt in the composer, keeps the agent idle, and shows the recovery command.

Artifact:

- `runtime/a_missing_required_plugin_blocks_normal_prompts_and_preserves_the_composer.png`
