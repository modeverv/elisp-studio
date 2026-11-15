#!/usr/bin/env bash
# SPDX-License-Identifier: 0BSD  (yours to change; no conditions)
# Put the Emacs that runs in the browser into this directory (vendor/), so
# that ./run.sh serves everything itself and the page needs no internet.
#
#   ./fetch-emacs.sh          about 40 MB: Emacs with the Lisp a program uses
#   ./fetch-emacs.sh --full   about 165 MB: with all of Emacs's Lisp
#
# The first is Emacs Lisp and its library (cl-lib, seq, json, url, the
# calendar, the charsets), without the editor's own libraries: no Org, Calc,
# Gnus, programming modes or source files.  A program that requires one of
# those says "Cannot open load file"; take --full then.  Either way a visitor
# downloads Emacs itself (5 MB) and only the Lisp files the program reads.
#
# Needs bash and curl.  Run it again to update.  What it fetches: GNU Emacs
# 30.2 as WebAssembly with its Lisp (GPL-3.0-or-later, built by
# https://github.com/modeverv/wasmacs, including SQLite, which is in the
# public domain) and elisp-react (MIT, https://github.com/modeverv/elisp-react).
#
# A site that serves vendor/ distributes that Emacs, under the GPL.  What
# the GPL asks for comes along: vendor/wasmacs/licenses/ has the licence
# texts, and its NOTICE.txt says where the source of the build is.  Keep
# that directory with the copy.
set -euo pipefail
package=core
case "${1:-}" in
  "") ;;
  --full) package=full ;;
  *) echo "usage: ./fetch-emacs.sh [--full]" >&2; exit 2 ;;
esac
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
            licenses/files.txt; do
  fetch "${wasmacs}" "${path}" "${vendor}/wasmacs"
done
# Emacs's Lisp.  temacs.files.json says which files there are and where
# they are; the page reads them from there one by one.
if [ "${package}" = full ]; then
  fetch "${wasmacs}" "${emacs_dir}/temacs.files.json" "${vendor}/wasmacs"
  fetch "${wasmacs}" "${emacs_dir}/temacs.data.parts/manifest.json" "${vendor}/wasmacs"
  # The package comes in parts, named in the manifest.
  for part in $(grep -o '"name": *"[^"]*"' "${vendor}/wasmacs/${emacs_dir}/temacs.data.parts/manifest.json" | sed 's/.*"\([^"]*\)"$/\1/'); do
    echo "  ${part}"
    fetch "${wasmacs}" "${emacs_dir}/temacs.data.parts/${part}" "${vendor}/wasmacs"
  done
  rm -f "${vendor}/wasmacs/${emacs_dir}/temacs.core.data"
else
  fetch "${wasmacs}" "${emacs_dir}/temacs.core.data" "${vendor}/wasmacs"
  fetch "${wasmacs}" "${emacs_dir}/temacs.core.files.json" "${vendor}/wasmacs"
  mv "${vendor}/wasmacs/${emacs_dir}/temacs.core.files.json" "${vendor}/wasmacs/${emacs_dir}/temacs.files.json"
  rm -rf "${vendor}/wasmacs/${emacs_dir}/temacs.data.parts"
  # A browser keeps what it downloaded under this id.  The smaller package
  # is another set of files than the whole one of the same build.
  sed -i.bak 's/\("id": *"[^"]*\)"/\1-core"/' "${vendor}/wasmacs/app/eval-build-id.json"
  rm -f "${vendor}/wasmacs/app/eval-build-id.json.bak"
fi
# The licences of what was just copied, and where its source is.
for name in $(cat "${vendor}/wasmacs/licenses/files.txt"); do
  case "${name}" in *[!A-Za-z0-9._-]*|.*) echo "fetch-emacs.sh: not a file name: ${name}" >&2; exit 1 ;; esac
  fetch "${wasmacs}" "licenses/${name}" "${vendor}/wasmacs"
done
fetch "${elisp_react}" LICENSE "${vendor}/elisp-react"
echo "done: $(du -sh "${vendor}" | cut -f1) in vendor/.  ./run.sh now serves it."
if [ "${package}" = core ]; then
  echo "This is Emacs Lisp and its library.  For all of Emacs's Lisp (Org, Calc, ...): ./fetch-emacs.sh --full"
fi
echo "Emacs is free software under the GNU GPL: see vendor/wasmacs/licenses/NOTICE.txt"
