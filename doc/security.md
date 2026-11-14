# Security check of the project server

What was examined, how, what was found, what was changed, and what is left. Done on 2026-11-14 and 15, on the code as of commit `848e74d` plus the fixes described here.

The subject is the server side of a project: `tools/serve-project.el` (the HTTP server in a native Emacs), `lisp/app-server.el` (what a project's `server.el` runs on), the scripts and proxy configurations that ship in a download, and the sample server in elisp-react (`examples/server`). The studio page itself (`js/studio.js`, the browser side) was read, not attacked.

## The situation that was assumed

The server listens on 127.0.0.1 and speaks plain HTTP. Either a developer runs it on their own machine and opens it in a browser there, or Caddy or nginx on the same machine publishes it (`PUBLIC_ORIGIN`, perhaps `WORKERS`). Who might attack:

1. a visitor without an account, who can send any bytes through the proxy;
2. a page of another site, open in the browser of someone who runs the server locally or is signed in to the published application;
3. a signed-in user of an application built on it;
4. another user of the machine the server runs on.

## How it was checked

| Method | What it did |
|---|---|
| OWASP ZAP 2.17 (Docker image `zaproxy/zap-stable`) | `zap-api-scan.py` (active: injection, traversal, command execution and so on) against an application with accounts, notes and uploads, described to it by an OpenAPI file, signed in; `zap-baseline.py` (passive) against its pages. Before and after the fixes. |
| Probes written for this server | About a hundred raw requests: some thirty ways to ask for files that must not be served, Host and Origin variants, 20 ambiguous or malformed framings, hostile bodies for the Lisp reader, cookies, plus floods of connections and of symbols. Before and after the fixes. |
| An independent reading of the code | A second reviewer who was given the code and the situation above, not the suspicions, and who verified what it found against a running server. |
| The shipped proxies | The fixed server behind Caddy 2.11 and nginx 1.30 with the shipped configurations. |

The two serious findings came from the probes. The independent reading reported neither; it looked at the first and set it aside as unreachable. A reading of the code, however careful, was not enough here.

## Findings

Severity is for the situation above. "Fixed" means: reproduced before, not reproducible after, and a test in `test/serve-project.test.mjs` ("what the security check found stays fixed") that fails if it comes back.

| # | Severity | Finding | Before | Now |
|---|---|---|---|---|
| 1 | High | **A request could make the server connect to another machine.** Emacs reads names like `/ssh:host:/file` as files on other machines. `GET //ssh:user@host%2322:/x` reached the file functions before the name was checked. | The server started `ssh` to the named host and port (the listener there received the SSH greeting) and answered nobody else for 35 seconds. Any page of any site could send that request to a developer's local server. | The name is judged before the disk is asked anything, and the server's file lookups use no remote, compressed or encrypted file handlers. 404 in under a millisecond, nothing is contacted. |
| 2 | High | **A visitor could fill the server's memory.** `(read-from-string body)`, as the template had it, makes a symbol of every name it has not seen, and Emacs keeps symbols for good. | 80 requests of 500 KB without signing in: 84 MB to 586 MB, never given back. | `(app-server-data body)` reads into a table of its own and lets through only plain data whose symbols this Emacs already knows. The same 80 requests: 85 MB to 113 MB. The template, the examples and the documentation use it. A `server.el` that calls `read` on a body itself is exposed as before. |
| 3 | Medium | **Silent connections shut everyone out.** An Emacs has about a thousand file descriptors; idle connections were kept for 180 seconds. | With 1,075 silent connections open, a request failed (connection reset). | At most 512 connections; one more closes a connection that never asked for anything, then one that rests. A connection that says nothing is closed after 20 seconds. With 3,000 attempted connections a request is answered. |
| 4 | Medium | **The server answered under any name** (DNS rebinding). A page can point its own domain at 127.0.0.1 and then read what a local server answers. | `GET /api/me` with `Host: evil.example` got the data. | A request whose `Host` is not this server's address or the published one gets 421. |
| 5 | Medium | **Requests whose end could be read two ways** (request smuggling, should a proxy read them differently): two `Content-Length`, a space before the colon, a continuation line, control characters in a header. | Accepted; with `Content-Length: 0` and `Content-Length: 5` the body was taken for a second request. | All refused with 400 and the connection closed. (`Transfer-Encoding` was refused with 411 before.) Caddy and nginx refuse most of these themselves. |
| 6 | Low | **Requests from pages of other sites without an Origin** (a picture, a link) reached `/api/`. Harmless for reading, not for a `GET` that changes something. | 200. | Refused (403) when the browser says `Sec-Fetch-Site: cross-site`. |
| 7 | Low | **Nothing said "do not show this in a frame"** (clickjacking). Found by ZAP and by the independent reading. | No header. | `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'; form-action 'self'; base-uri 'self'; object-src 'none'` on every answer, `Referrer-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` on `/api/`. The shipped proxy configurations add `Strict-Transport-Security`. |
| 8 | Low | **`X-Forwarded-For` was believed without a proxy.** Run directly, a visitor could name any address and so get around the limit on sign-in attempts per address. Found by the independent reading. | Believed. | `X-Forwarded-*` reach `server.el` only when `PUBLIC_ORIGIN` says there is a proxy. (The limit per account never depended on it.) |
| 9 | Low | **What went wrong inside was told to the visitor**: a missing file's whole path, a database's message. | In the response. | Under a native Emacs only what `server.el` says on purpose (`error`, `app-server-refuse`) is answered; the rest goes to the log. In the studio, where one writes the application, the full text stays. |
| 10 | Low | **A stored password hash could name its own cost**, so one that said "a hundred million rounds" would keep a core busy. Needs write access to the stored hashes. | Computed. | Hashes outside sane bounds are not checked. |
| 11 | Info | A NUL in a path gave 500. The scripts (`run.sh`, `backup.sh`) could be downloaded. Uploads that a stopped server left half done stayed on disk. Several workers without SQLite keep sessions apart, silently. | | 404; `*.sh` is not served; cleaned at start; a warning in the log. |

The sample server of elisp-react (`examples/server/server.el`) had findings 1, 2, 4 and 6 in the same form and was fixed the same way.

## What held, before any change

- **Files.** `server.el`, `server/`, `.data/` (databases, sessions, kept files), hidden files and anything outside the project: some thirty variants (`..`, encoded dots and slashes, doubled slashes, upper case on a case-insensitive disk, trailing dots and spaces, overlong UTF-8), and symbolic links that lead out. None got through.
- **Injection.** ZAP's active scan (120 rules passed, none failed): SQL injection, path traversal, remote file inclusion, OS command injection, server-side code and template injection, XXE, and the rest of its list. SQL in queries and bodies ends up as text in a parameter. Uploaded names such as `../../server.el` and ZAP's payloads became plain names inside `.data/files/`.
- **The Lisp reader.** 600 KB of open parentheses, 100,000 levels of nesting, circular structures, byte-code objects, `#.` and backquote forms: read as data or refused, never evaluated, no crash. (The cost in memory is finding 2.)
- **Sessions.** A forged or malformed session name is nobody; signing in while sending a session name of one's own choice gives a new one (no fixation); the database holds only hashes of session names; signing out and signing out everywhere work across workers.
- **Other sites.** A POST with a foreign `Origin` (also `null`, look-alike and wrong-case origins) is refused; there are no CORS headers, so no page of another site can read an answer.
- **Header injection.** A line break in a header value, a cookie or a download's file name does not reach the response.

## What is left, knowingly

- **The page's scripts are not restricted.** The policy above says nothing about where scripts may come from (ZAP reports this as medium), and the page loads elisp-react and Emacs from `modeverv.github.io` without integrity checks, unless `./fetch-emacs.sh` made a local copy. Whoever controls that site controls the pages. An application that wants more adds its own `Content-Security-Policy` with `app-server-set-header`, or at the proxy.
- **A POST without an Origin is accepted**, for programs that are not browsers. Browsers send one with every POST to another site, and those are refused. There is no CSRF token.
- **Other users of the server's machine** can connect to the port directly, past the proxy, and say anything in `X-Forwarded-For` or in a header a proxy would set to name the signed-in user. A machine with untrusted local users is not the place for this server.
- **What `server.el` does is its author's business**: `read` on a body (finding 2), a visitor's text as the URL for `app-server-fetch` (requests to wherever the server can reach), an uploaded file sent back as `text/html` (a page under the application's name; the default type and `:name` avoid it), a `GET` that changes things.
- **One thread.** A handler that computes for long holds up everyone; handlers that wait inside Emacs are turned away beyond 32 deep (503).
- **Not examined:** the studio page and the wasm Emacs in the browser beyond reading; elisp-react's rendering (text is set as text, not as HTML, but that was not attacked); runs longer than a quarter of an hour; Emacs versions other than 31.1 here and 29 in CI; Windows.
- This was a check by the people who wrote the code, with tools. It is not a penetration test by someone paid to break in, and "nothing more was found" is not "nothing more is there".

## Doing it again

The regression tests run with `npm run test:unit`. For ZAP: describe the application's `/api/` in an OpenAPI file with `servers: [{url: "http://host.docker.internal:PORT"}]`, start the server with `PUBLIC_ORIGIN=http://host.docker.internal:PORT`, and

```sh
docker run --rm -v "$PWD:/zap/wrk:rw" zaproxy/zap-stable zap-api-scan.py -t openapi.yaml -f openapi -r report.html \
  -z "-config replacer.full_list(0).description=auth -config replacer.full_list(0).enabled=true \
      -config replacer.full_list(0).matchtype=REQ_HEADER -config replacer.full_list(0).matchstr=Cookie \
      -config replacer.full_list(0).regex=false -config replacer.full_list(0).replacement=session=NAME-OF-A-SESSION"
docker run --rm -v "$PWD:/zap/wrk:rw" zaproxy/zap-stable zap-baseline.py -t http://host.docker.internal:PORT/ -r baseline.html
```
