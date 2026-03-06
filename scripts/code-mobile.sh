#!/usr/bin/env bash

# VS Code Mobile Development Script
#
# Builds the mobile web bundle in dev mode and syncs to Capacitor.
# Optionally opens in Android Studio or Xcode.
#
# Usage:
#   ./scripts/code-mobile.sh              # Build web bundle only
#   ./scripts/code-mobile.sh --android    # Build and open in Android Studio
#   ./scripts/code-mobile.sh --ios        # Build and open in Xcode
#   ./scripts/code-mobile.sh --livereload # Build with live reload on connected device

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== VS Code Mobile Development ==="
echo ""

# Step 1: Build web bundle
echo "Building mobile web bundle..."
cd "$ROOT"
npx gulp vscode-mobile-web-dev

# Step 2: Sync to Capacitor
echo "Syncing Capacitor..."
cd "$ROOT/mobile"
npx cap sync

# Step 3: Platform-specific
case "$1" in
	--android)
		echo "Opening in Android Studio..."
		npx cap open android
		;;
	--ios)
		echo "Opening in Xcode..."
		npx cap open ios
		;;
	--livereload)
		if [[ "$(uname)" == "Darwin" ]]; then
			echo "Running with live reload on iOS..."
			npx cap run ios --livereload
		else
			echo "Running with live reload on Android..."
			npx cap run android --livereload
		fi
		;;
	*)
		echo ""
		echo "Web bundle ready at: $ROOT/out-vscode-mobile/"
		echo ""
		echo "Next steps:"
		echo "  ./scripts/code-mobile.sh --android    # Open in Android Studio"
		echo "  ./scripts/code-mobile.sh --ios        # Open in Xcode"
		echo "  ./scripts/code-mobile.sh --livereload # Run with live reload"
		;;
esac

echo ""
echo "Done."
