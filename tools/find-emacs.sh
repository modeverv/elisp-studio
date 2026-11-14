#!/usr/bin/env bash
# Print the path of a native Emacs that really starts: $EMACS, "emacs" on
# PATH, or a macOS application.  (An "emacs" on PATH that is a link into an
# app bundle does not start.)
if [ -n "${EMACS:-}" ]; then
  printf '%s\n' "${EMACS}"
  exit 0
fi
for candidate in "$(command -v emacs || true)" \
                 /Applications/Emacs.app/Contents/MacOS/Emacs \
                 /Applications/Emacs-takaxp/Emacs.app/Contents/MacOS/Emacs; do
  if [ -n "${candidate}" ] && [ -x "${candidate}" ] \
     && "${candidate}" --batch -Q --eval t >/dev/null 2>&1; then
    printf '%s\n' "${candidate}"
    exit 0
  fi
done
echo "no Emacs found; set EMACS" >&2
exit 127
