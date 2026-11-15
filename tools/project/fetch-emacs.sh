#!/usr/bin/env bash
# SPDX-License-Identifier: 0BSD  (yours to change; no conditions)
# Put the Emacs that runs in the browser into this directory (vendor/), so
# that ./run.sh serves everything itself and the page needs no internet.
#
#   ./fetch-emacs.sh          about 170 MB: Emacs with all of its Lisp
#   ./fetch-emacs.sh --core   about 45 MB: with the language's library only
#
# What lies here is not what a visitor downloads.  A visitor gets Emacs
# itself (5 MB) and, of Emacs's Lisp, the files the page reads, one by one.
# So the first is the one to take: it is the Emacs the studio has, and
# what ran there runs here.
#
# --core leaves out the editor's own libraries (Org, Calc, Gnus, the
# programming modes, source files).  A page that requires one of those
# then fails with "Cannot open load file", although it ran in the studio.
# Only for a machine that is short of disk, and after trying the page.
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
package=full
case "${1:-}" in
  ""|--full) ;;
  --core) package=core ;;
  *) echo "usage: ./fetch-emacs.sh [--core]" >&2; exit 2 ;;
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
# A compressed copy next to each large file that every visitor downloads:
# the project's server sends that one to a browser that takes gzip, which
# makes 16 MB into 5.  (The Lisp files are asked for in parts and stay as
# they are.)
if command -v gzip >/dev/null 2>&1; then
  for name in temacs.wasm bootstrap-emacs.pdmp temacs.js temacs.files.json; do
    gzip -9 -c "${vendor}/wasmacs/${emacs_dir}/${name}" > "${vendor}/wasmacs/${emacs_dir}/${name}.gz.part"
    mv "${vendor}/wasmacs/${emacs_dir}/${name}.gz.part" "${vendor}/wasmacs/${emacs_dir}/${name}.gz"
  done
else
  echo "no gzip here: the page will download Emacs uncompressed (16 MB instead of 5) unless a proxy compresses it"
fi
# The licences of what was just copied, and where its source is.
for name in $(cat "${vendor}/wasmacs/licenses/files.txt"); do
  case "${name}" in *[!A-Za-z0-9._-]*|.*) echo "fetch-emacs.sh: not a file name: ${name}" >&2; exit 1 ;; esac
  fetch "${wasmacs}" "licenses/${name}" "${vendor}/wasmacs"
done
fetch "${elisp_react}" LICENSE "${vendor}/elisp-react"
echo "done: $(du -sh "${vendor}" | cut -f1) in vendor/.  ./run.sh now serves it."
if [ "${package}" = core ]; then
  echo "--core: the editor's libraries (Org, Calc, ...) are not here.  A page that requires one fails here"
  echo "although it ran in the studio.  ./fetch-emacs.sh without --core brings them."
fi
echo "Emacs is free software under the GNU GPL: see vendor/wasmacs/licenses/NOTICE.txt"
