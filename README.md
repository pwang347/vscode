# Managed plugin enforcement evidence

## VS Code

Source: `microsoft/vscode-internalbacklog#8906`

Dev build `1.141.0` on macOS arm64:

1. Start with an isolated plugin inventory and verify policy installs `managed-hook-plugin@managed-hook-marketplace` without confirmation.
2. Publish trusted repository settings for `repository-demo@repository-marketplace`.
3. Verify the repository plugin installs and becomes workspace-active without a marketplace confirmation.
4. Attempt the organization-managed toggle and verify the managed plugin remains enabled and locked.

Artifacts:

- `vscode/report.html`
- `vscode/manifest.json`
- `vscode/videos/annotated.mp4`
- `vscode/videos/recording-1.webm`
- `vscode/01-MP-01-passed.png`
- `vscode/02-MP-02-passed.png`
- `vscode/03-MP-03-passed.png`

The captioned MP4 was rendered with Homebrew `ffmpeg-full`.

## Copilot CLI

The managed-plugin E2E test verifies that an unavailable required plugin leaves a normal prompt in the composer, keeps the agent idle, and shows the recovery command.

Artifact:

- `runtime/a_missing_required_plugin_blocks_normal_prompts_and_preserves_the_composer.png`
