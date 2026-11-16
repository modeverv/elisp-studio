#!/bin/sh
# SPDX-License-Identifier: 0BSD  (yours to change; no conditions)
# Run on the host by deploy.sh: put the project that came in INCOMING (a
# directory of the home directory) in place.
#   install.sh INCOMING WEB-DIR APP-DIR PUBLIC-ORIGIN
set -eu
cd "$HOME"
incoming="$HOME/$1"; web="$HOME/$2"; app="$HOME/$3"; origin="$4"
trap 'rm -rf "$incoming"' EXIT
emacs="$(command -v emacs || true)"
[ -n "$emacs" ] || { echo "install.sh: no emacs on the host" >&2; exit 1; }
"$emacs" --batch -Q --eval '(unless (version<= "27.2" emacs-version) (kill-emacs 1))' \
  || { echo "install.sh: the host's Emacs is older than 27.2" >&2; exit 1; }
umask 022
mkdir -p "$app" "$web" "$app/data"
chmod 700 "$app" "$app/data"
# The whole project to APP-DIR (outside the web root), over what was there;
# the data directory and my.cnf stay.
( cd "$incoming" && tar -cf - . ) | ( cd "$app" && tar -xf - )
# The page's files to WEB-DIR: not the server's, and no hidden files.
( cd "$incoming" && tar -cf - --exclude './.*' --exclude ./server --exclude ./server.el --exclude ./api --exclude ./test \
    --exclude ./.github --exclude './*.sh' --exclude ./Dockerfile --exclude ./docker-compose.yml \
    --exclude ./.dockerignore --exclude ./README.txt . ) | ( cd "$web" && tar -xf - )
cp "$app/server/cgi/htaccess" "$web/.htaccess"
mysql=""; [ -f "$app/my.cnf" ] && mysql="$app/my.cnf"
cat > "$web/app.cgi" <<CGI
#!/bin/sh
# Written by server/cgi/install.sh.  Each request to /api/ starts an Emacs,
# which answers it with server.el and ends.  What it reads is outside the
# web root, in $app.
APP_DIRECTORY=$app
APP_DATA=$app/data
APP_MYSQL=$mysql
PUBLIC_ORIGIN=$origin
export APP_DIRECTORY APP_DATA APP_MYSQL PUBLIC_ORIGIN
exec $emacs --batch -Q -l "\$APP_DIRECTORY/server/serve-cgi.el" -f serve-cgi-main
CGI
chmod 755 "$web/app.cgi"
# Compiled, the server's Lisp loads in a fraction of the time: each request pays it.
( cd "$app/server" && rm -f ./*.elc && "$emacs" --batch -Q -L . --eval '(setq byte-compile-warnings nil)' \
    -f batch-byte-compile app-server.el serve-project.el serve-cgi.el >/dev/null 2>&1 )
echo "install.sh: $origin/ is $web; the server reads $app$( [ -n "$mysql" ] && echo ", data in MySQL" || true )"
