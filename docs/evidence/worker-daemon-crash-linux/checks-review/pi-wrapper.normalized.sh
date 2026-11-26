#!/bin/sh
export TMPDIR='<USER_HOME>/f124chk-FMJ7CQ/p'
printf '%s\n' "$TMPDIR" >> '<USER_HOME>/f124chk-FMJ7CQ/wrapper-invocations.log'
exec '<USER_HOME>/.local/share/pi-node/node-v22.23.2-linux-x64/bin/node' '<CHECKOUT>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js' "$@"
