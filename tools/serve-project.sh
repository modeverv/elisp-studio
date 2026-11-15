#!/usr/bin/env bash
# Serve a studio project with a native Emacs: its files, and /api/ answered
# by its server.el.
#   tools/serve-project.sh DIRECTORY [PORT]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
directory="$(cd "${1:?usage: serve-project.sh DIRECTORY [PORT]}" && pwd)"
emacs_bin="$("${here}/find-emacs.sh")"
port="${2:-8018}"
workers="${WORKERS:-1}"
# A visitor who hangs up in the middle of a file must not end the server.
# Writing to a connection that the other side has closed raises SIGPIPE,
# and Emacs in batch mode leaves that signal as it finds it: by default,
# the end of the process.  Ignored here, it stays ignored in Emacs, which
# then gets an ordinary error for that one connection.
trap '' PIPE
export SERVE_PROJECT_SIGPIPE=ignored
serve() {
  exec "${emacs_bin}" --batch -Q \
    --eval "(setq serve-project-directory \"${directory}/\" serve-project-port $1)" \
    -l "${here}/serve-project.el" -f serve-project-run
}
if [ "${workers}" -le 1 ]; then
  serve "${port}"
else
  # One Emacs uses one core.  WORKERS of them, on PORT, PORT+1, ...; the
  # reverse proxy in front spreads the requests over them.
  pids=""
  trap 'kill ${pids} 2>/dev/null' EXIT
  trap 'exit 0' INT TERM
  worker=0
  while [ "${worker}" -lt "${workers}" ]; do
    serve "$((port + worker))" &
    pids="${pids} $!"
    worker=$((worker + 1))
  done
  # If one of them ends, all end: whatever keeps this script running
  # (systemd) then starts them again together.
  while :; do
    for pid in ${pids}; do
      kill -0 "${pid}" 2>/dev/null || exit 1
    done
    sleep 1
  done
fi
