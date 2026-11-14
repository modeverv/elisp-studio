#!/usr/bin/env bash
# Serve a studio project with a native Emacs: its files, and /api/ answered
# by its server.el.
#   tools/serve-project.sh DIRECTORY [PORT]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
directory="$(cd "${1:?usage: serve-project.sh DIRECTORY [PORT]}" && pwd)"
emacs_bin="$("${here}/find-emacs.sh")"
exec "${emacs_bin}" --batch -Q \
  --eval "(setq serve-project-directory \"${directory}/\" serve-project-port ${2:-8018})" \
  -l "${here}/serve-project.el" -f serve-project-run
