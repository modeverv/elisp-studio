#!/usr/bin/env bash
# Put the Emacs that runs in the browser into this directory (vendor/), so
# that ./run.sh serves everything itself and the page needs no internet.
#
#   ./fetch-emacs.sh        about 160 MB, from the wasmacs and elisp-react sites
#
# Needs bash and curl.  Run it again to update.  What it fetches: GNU Emacs
# 30.2 as WebAssembly with its Lisp (GPL-3.0-or-later, built by
# https://github.com/modeverv/wasmacs, including SQLite, which is in the
# public domain) and elisp-react (https://github.com/modeverv/elisp-react).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wasmacs="${WASMACS_URL:-https://modeverv.github.io/wasmacs/}"
elisp_react="${ELISP_REACT_URL:-https://modeverv.github.io/elisp-react/}"
vendor="${here}/vendor"

fetch() {  # fetch BASE-URL PATH DIRECTORY
  mkdir -p "$(dirname "$3/$2")"
  curl -fsSL --retry 3 -o "$3/$2.part" "$1$2"
  mv "$3/$2.part" "$3/$2"
}

echo "elisp-react from ${elisp_react}"
for path in js/elisp-react.js lisp/react.el; do
  fetch "${elisp_react}" "${path}" "${vendor}/elisp-react"
done

echo "Emacs from ${wasmacs}"
emacs_dir=artifacts/emacs-browser-atomics-pdump
for path in app/eval-build-id.json \
            app/src/emacs-eval-client.js app/src/emacs-eval-worker.js \
            app/src/emacs-eval-core.js app/src/wasmacs-eval-service.el \
            "${emacs_dir}/temacs.js" "${emacs_dir}/temacs.wasm" "${emacs_dir}/bootstrap-emacs.pdmp" \
            "${emacs_dir}/temacs.data.parts/manifest.json"; do
  fetch "${wasmacs}" "${path}" "${vendor}/wasmacs"
done
# The big data file comes in parts, named in the manifest.
for part in $(grep -o '"name": *"[^"]*"' "${vendor}/wasmacs/${emacs_dir}/temacs.data.parts/manifest.json" | sed 's/.*"\([^"]*\)"$/\1/'); do
  echo "  ${part}"
  fetch "${wasmacs}" "${emacs_dir}/temacs.data.parts/${part}" "${vendor}/wasmacs"
done
echo "done: $(du -sh "${vendor}" | cut -f1) in vendor/.  ./run.sh now serves it."
