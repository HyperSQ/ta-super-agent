#!/bin/sh
set -eu
workspace=$1
socket=$2
model=$3
shift 3
home=/opt/ta-dsh/runtime
script="$(dirname "$0")/dsh-headless.mjs"
# Keep the host API credentials, databases and other workspaces outside this mount namespace.
exec /opt/ta-dsh/bin/ta-bwrap --unshare-all --unshare-user --disable-userns --die-with-parent --new-session --clearenv \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --proc /proc --dev /dev --tmpfs /tmp \
  --ro-bind "$home" "$home" --ro-bind "$script" /runner/entry.mjs \
  --ro-bind "$socket" /runner/bridge.sock --bind "$workspace" /work --chdir /work \
  --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /work --setenv LANG C.UTF-8 \
  /usr/local/bin/node /runner/entry.mjs run "$model" "$@"
