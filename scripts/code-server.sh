#!/usr/bin/env bash

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname $(dirname $(realpath "$0")))
else
	ROOT=$(dirname $(dirname $(readlink -f $0)))
fi

function code() {
	pushd $ROOT

	# Get electron, compile, built-in extensions
	if [[ -z "${VSCODE_SKIP_PRELAUNCH}" ]]; then
		node build/lib/preLaunch.ts
	fi

	NODE=$(node build/lib/node.ts)
	if [ ! -e $NODE ];then
		# Load remote node
		npm run gulp node
	fi

	popd

	# When running the bundled server, don't set VSCODE_DEV so
	# the server resolves resources from the bundle output directory.
	if [[ " $@ " == *" --bundle "* ]]; then
		NODE_ENV=development \
		$NODE $ROOT/scripts/code-server.js "$@"
	else
		NODE_ENV=development \
		VSCODE_DEV=1 \
		$NODE $ROOT/scripts/code-server.js "$@"
	fi
}

code "$@"
