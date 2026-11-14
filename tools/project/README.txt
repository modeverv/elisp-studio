An application written in Emacs Lisp, made with elisp-studio
(https://github.com/modeverv/elisp-studio).

  index.html, app.el, style.css   the page; app.el is its program
  server.el                       the server side (if the application has one)
  run.sh                          run it: GNU Emacs is the web server
  fetch-emacs.sh                  optional: keep the browser's Emacs here too
  server/                         what run.sh loads into Emacs
  server/deploy/                  for publishing: Caddy, nginx, systemd

To run it you need bash and GNU Emacs 29 or later:

  ./run.sh            then open http://127.0.0.1:8018/
  ./run.sh 9000       another port

Emacs serves the files and answers the page's requests to /api/... with
server.el.  The data the server keeps is in .data/ (Lisp files, and
.data/app.db if server.el uses SQLite; that needs an Emacs built with
SQLite, which most are).

The page's own program, app.el, does not run in that Emacs.  It runs in
the visitor's browser, in a second GNU Emacs compiled to WebAssembly, which
the page downloads (about 160 MB the first time; the browser keeps it).
By default it comes from https://modeverv.github.io/wasmacs/.  To serve it
from here instead, so that nothing needs the internet:

  ./fetch-emacs.sh    downloads it into vendor/ (needs curl)

Without a server.el the application is a static site: index.html, app.el
and style.css on any web server are enough.

The server listens on 127.0.0.1 only.  To publish the application, put a
reverse proxy on the same machine in front of it, which does HTTPS, and
tell the server the address it is published under:

  PUBLIC_ORIGIN=https://example.com ./run.sh

server/deploy/ has what that takes: a Caddyfile, an nginx.conf, and a
systemd unit that keeps run.sh running.
