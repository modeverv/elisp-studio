#!/usr/bin/env bash
# Run this application: GNU Emacs is its web server.
#
#   ./run.sh [PORT]        then open http://127.0.0.1:PORT/  (default 8018)
#   PUBLIC_ORIGIN=https://example.com ./run.sh
#                          behind a reverse proxy that publishes it there
#                          (server/deploy/ has configurations)
#
# Needs bash and a native GNU Emacs (29 or later; with SQLite support if
# server.el uses a database).  Emacs serves the files of this directory and
# answers /api/... with server.el.  The page's own Emacs Lisp runs in the
# browser, in an Emacs that the page downloads from the internet, or, after
# ./fetch-emacs.sh, from this directory.  Stop with C-c.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

emacs_bin="${EMACS:-}"
if [ -z "${emacs_bin}" ]; then
  # An "emacs" on PATH that is a link into a macOS app bundle does not
  # start: take the first candidate that really runs.
  for candidate in "$(command -v emacs || true)" \
                   /Applications/Emacs.app/Contents/MacOS/Emacs \
                   /Applications/Emacs-takaxp/Emacs.app/Contents/MacOS/Emacs; do
    if [ -n "${candidate}" ] && [ -x "${candidate}" ] \
       && "${candidate}" --batch -Q --eval t >/dev/null 2>&1; then
      emacs_bin="${candidate}"
      break
    fi
  done
fi
[ -n "${emacs_bin}" ] || { echo "run.sh: no Emacs found; set EMACS=/path/to/emacs" >&2; exit 127; }

exec "${emacs_bin}" --batch -Q \
  --eval "(setq serve-project-directory \"${here}/\" serve-project-port ${1:-8018})" \
  -l "${here}/server/serve-project.el" -f serve-project-run
