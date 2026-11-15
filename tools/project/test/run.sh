#!/usr/bin/env bash
# SPDX-License-Identifier: 0BSD  (yours to change; no conditions)
# Check this application with a native GNU Emacs (29 or later):
#
#   test/run.sh            every .el file of the project compiles without a
#                          warning, then the tests in test/*-test.el pass
#   test/run.sh --update   fetch react.el and app-server.el anew first
#
# The warnings are the lint: a function or variable that is not known, a
# call with the wrong number of arguments.  The tests are ERT, and
# react-testing renders the application without a browser (see
# test/app-test.el of the template).  The libraries come from vendor/ and
# server/ when the project has them (./fetch-emacs.sh, the download), else
# from the web, once, into .cache/.  .github/workflows/test.yml runs this
# at every push.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

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
[ -n "${emacs_bin}" ] || { echo "test/run.sh: no Emacs found; set EMACS=/path/to/emacs" >&2; exit 127; }

lib=.cache/lisp
mkdir -p "${lib}"
if [ "${1:-}" = "--update" ]; then rm -f "${lib}"/*.el; fi
react="${ELISP_REACT_URL:-https://modeverv.github.io/elisp-react/}"
studio="${ELISP_STUDIO_URL:-https://modeverv.github.io/elisp-studio/}"
library() {   # NAME COPY-IN-THE-PROJECT URL
  if [ -f "$2" ]; then
    cp "$2" "${lib}/$1"
  elif [ ! -f "${lib}/$1" ]; then
    curl -fsSL "$3" -o "${lib}/$1.part" && mv "${lib}/$1.part" "${lib}/$1"
  fi
}
library react.el vendor/elisp-react/lisp/react.el "${react}lisp/react.el"
library react-testing.el vendor/elisp-react/lisp/react-testing.el "${react}lisp/react-testing.el"
library app-server.el server/app-server.el "${studio}lisp/app-server.el"

# The project's Lisp: not what the tools bring (vendor/wasmacs,
# vendor/elisp-react, server/) or keep (.cache/, .data/).  Third-party
# Lisp of the project's own (lib/, vendor/NAME/) is on load-path, and
# only the project's own files are checked.
files=()
directories=()
while IFS= read -r file; do
  directories+=("-L" "$(dirname "${file}")")
  case "${file}" in ./vendor/*) ;; *) files+=("${file}") ;; esac
done < <(find . \( -path ./.git -o -path ./.cache -o -path ./.data -o -path ./server -o -path ./node_modules \
                   -o -path ./vendor/wasmacs -o -path ./vendor/elisp-react \) -prune -o -name '*.el' -print | sort)
[ "${#files[@]}" -gt 0 ] || { echo "test/run.sh: no .el files"; exit 0; }

compiled="$(mktemp -d)"
trap 'rm -rf "${compiled}"' EXIT
echo "lint: ${files[*]}"
"${emacs_bin}" --batch -Q -L "${lib}" "${directories[@]}" -l react -l app-server \
  --eval "(setq byte-compile-error-on-warn t
                byte-compile-dest-file-function
                (lambda (file) (expand-file-name (concat (file-name-nondirectory file) \"c\") \"${compiled}\")))" \
  -f batch-byte-compile "${files[@]}"

tests=()
for file in test/*-test.el; do [ -f "${file}" ] && tests+=("-l" "${file}"); done
if [ "${#tests[@]}" -gt 0 ]; then
  "${emacs_bin}" --batch -Q -L "${lib}" "${directories[@]}" -l ert -l react-testing -l app-server \
    "${tests[@]}" -f ert-run-tests-batch-and-exit
fi
