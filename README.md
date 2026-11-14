# elisp-studio

Write a web application in Emacs Lisp, in the browser, and watch it change without a reload.

Live: <https://modeverv.github.io/elisp-studio/> (Chrome on a desktop; the first visit downloads Emacs, about 150 MB, which the browser then keeps).

[日本語](README.ja.md)

![The studio in use: a stopwatch keeps running while its title, its code and its stylesheet are edited in Emacs](doc/images/demo.gif)

*A stopwatch written in Emacs Lisp, edited while it runs. The title is changed in Emacs and saved; a typo is marked by Flymake as it is typed; the stylesheet's colour is changed. The clock on the right never stops. (Recorded by `tools/record-demo.mjs`; try the same project at [`?example=stopwatch`](https://modeverv.github.io/elisp-studio/?example=stopwatch).)*

```text
┌──────────────────────────────┬──────────────────────────────┐
│ GNU Emacs                    │ your application             │
│ editing app.el               │ drawn by Emacs Lisp          │
│                              │                              │
│ change it, C-x C-s           │ changes at once:             │
│                              │ no reload, state kept        │
└──────────────────────────────┴──────────────────────────────┘
```

Both halves are Emacs. On the left is the real GNU Emacs 30.2, running in the page as WebAssembly ([wasmacs](https://github.com/modeverv/wasmacs)), with its own filesystem. On the right is the application: a second Emacs evaluates the project's Emacs Lisp with [elisp-react](https://github.com/modeverv/elisp-react) and draws the page. Nothing is installed and nothing is built.

## Try it

1. Open the page. Emacs starts with `app.el`; the application appears next to it.
2. Click the counter a few times.
3. In Emacs, change a text in `app.el`, for example `"Count: %d"`, and save with `C-x C-s`.
4. The application shows the new text, and the counter still has its count.

The project is `/home/user/elisp-studio/app` in Emacs's filesystem, which the browser keeps: it is still there at the next visit. A new project starts from `template/`, or, with `?example=stopwatch` or `?example=sqlite` in the address, from that directory of `examples/`; a project that exists is never replaced (remove the directory in Emacs to start over). It is the same `/home/user` that the wasmacs page itself uses, so the project is also there when you open wasmacs directly. Its files:

```text
index.html   the page: a <div id="app">, the stylesheet, <script type="text/emacs-lisp" src="app.el">
app.el       the program, with elisp-react
style.css    the stylesheet
server.el    the server side (optional): answers the page's requests to /api/...
```

Without `server.el` the project is a static web site that works on its own, anywhere.

What happens when a file is saved:

| File | Effect |
|---|---|
| a `.el` file that `index.html` loads | Compiled and evaluated in the running application. Components that are defined again render with the state they have. |
| a stylesheet that `index.html` links | Swapped in place. |
| `index.html` | The application starts again (its state is reset). |
| `server.el` | Evaluated in the running server, which keeps its data. |

In Emacs, in a file of the project:

| Key | |
|---|---|
| `C-x C-s` | Save: the change reaches the application as described above. |
| `C-M-x` | Send the definition at point to the running application (or server) without saving. |
| `C-c C-p` | Publish: commit the project with git and push it (see below). |
| `C-M-i`, `M-.`, `C-h f` | Complete, find and describe functions: Emacs's, those of elisp-react, and the project's own once the file that defines them is saved. ElDoc shows arguments while you type. |
| `M-g n`, `M-g p` | Go to the next or previous place the compiler complained about. |

![A misspelled function name is marked in the buffer, and the list of diagnostics names it, before the file is saved](doc/images/diagnostics.png)

While you type, Flymake marks what the byte compiler would complain about: the editing Emacs compiles the buffer's text a moment after each change, without saving or running it. What the application's Emacs says about a saved file comes back too: one line in the echo area, and the compiler's warnings and errors in the buffer `*elisp-studio*` (a compilation buffer: `RET` jumps to the place).

![After C-x C-s: the title on the right is the new one, the clock runs on, Emacs says "no reload, state kept"](doc/images/live-reload.png)

A mistake does not take the application down: if the new code does not load, the error is shown under the application and the old code keeps running. An endless loop does take it down, and only it: the studio starts a new application at the next save, and Emacs keeps editing. The "restart app" button starts the application again from the files.

## A server side

A project with a `server.el` has a server. The file defines one function:

```elisp
(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("GET" "/api/messages") (app-server-read "messages" '("Hello")))
    ...))
```

It returns Lisp data, which the page gets printed and reads back; an error it signals is the response. Around the three arguments:

- `(app-server-parameter "name")`: the value of `?name=...` in the request.
- `(app-server-header "name")`, `(app-server-cookie "name")`: what came with the request.
- `(app-server-set-header "Name" "value")`, `(app-server-set-cookie "name" "value" :max-age 3600)`, `(app-server-delete-cookie "name")`: what goes with the answer. A cookie is hidden from the page's scripts, `SameSite=Lax`, and `Secure` when the visitor came over HTTPS, unless told otherwise.
- `(app-server-refuse "Sign in first" 401)`: answer with that message and status.
- `(app-server-token)`: a random name nobody can guess, for a session.

Signing in is those put together:

```elisp
('("POST" "/api/login")
 (let ((session (app-server-token)))
   (sqlite-execute (app-server-database) "INSERT INTO sessions (name, visitor) VALUES (?, ?)"
                   (list session (app-check-password body)))
   (app-server-set-cookie "session" session :max-age (* 30 24 3600))
   t))
```

The server can keep data in two ways:

- `app-server-read` and `app-server-write`: Lisp values in files.
- `(app-server-database)`: an SQLite database, used with Emacs's own `sqlite-execute` and `sqlite-select`. No driver and no other program is involved: SQLite is part of Emacs.

```elisp
(let ((db (app-server-database)))
  (sqlite-execute db "CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")
  (sqlite-execute db "INSERT INTO books (title) VALUES (?)" (list title))     ; a parameter, not SQL text
  (sqlite-select db "SELECT id, title FROM books WHERE title LIKE ?" (list (concat "%" search "%"))))
```

[`examples/sqlite`](examples/sqlite) is a reading list kept that way ([try it](https://modeverv.github.io/elisp-studio/?example=sqlite)). In the studio the database is a file in the memory of the server's Emacs, which the studio keeps in the browser (IndexedDB) between visits; under a native Emacs it is the file `.data/app.db`, which the `sqlite3` command line tool can open too.

About bundling SQLite: it is in the [public domain](https://www.sqlite.org/copyright.html), so there are no conditions on shipping it. The Emacs that runs in the browser has it linked in by wasmacs (see "Bundled software and licences" there); a native Emacs has it if it was built with SQLite, which the usual packages are (`(sqlite-available-p)` tells). Nothing of SQLite is in this repository or in a downloaded project.

In the studio the server is a third Emacs in the browser tab. The application's requests to `/api/...` never leave the tab: the studio hands them to that Emacs. Saving `server.el` changes the running server.

The same project runs for real under a native Emacs, which then is the web server. The download (next section) brings the script for it:

```sh
./run.sh            # then open http://127.0.0.1:8018/
```

It serves the project's files and answers `/api/...` with the same `server.el`; what the server keeps goes to `.data/` in the project. The page's Emacs Lisp still runs in the visitor's browser.

### Answering later

A handler that has to wait for something need not make every other request wait with it. It returns `app-server-defer`; the request stays open, the server goes on, and the answer is sent when `respond` is called:

```elisp
('("GET" "/api/rates")
 (app-server-defer
  (lambda (respond fail)
    (app-server-fetch "https://example.com/rates.json"
                      :then (lambda (response)
                              (if (plist-get response :ok)
                                  (funcall respond (plist-get response :text))
                                (funcall fail "The rates are not available")))))))
```

There are three things to wait for, none of which blocks:

- `(app-server-fetch URL :method :headers :body :then :catch)`: an HTTP request to another server.
- `(app-server-after SECONDS FUNCTION)`: a moment.
- `(app-server-run '("program" "argument") :input STRING :then FUNCTION)`: a program, a second Emacs for long computations for instance. The function gets `(:status 0 :output "...")`. No shell reads the command.

`(funcall fail MESSAGE [STATUS])` refuses the request, an error in a function that runs later does the same, and a request that is not answered within `app-server-deferred-timeout` (30 seconds) gets a 504. The same `server.el` works in the studio, where the page keeps the time and makes the requests for the server's Emacs (so the browser's rules for requests to other sites apply there); programs exist only under a native Emacs.

Computing is not waiting: Emacs Lisp that runs, and SQLite, still hold the one thread. That is what `app-server-run` is for.

### Publishing it

The server listens on 127.0.0.1 and speaks plain HTTP. To put the application on the internet, a reverse proxy on the same machine goes in front of it: Caddy or nginx does HTTPS, HTTP/2 and compression, Emacs does the rest. The server is told the address it is published under:

```sh
PUBLIC_ORIGIN=https://example.com ./run.sh
```

The download brings the configurations in `server/deploy/`: a `Caddyfile` (four lines), an `nginx.conf`, and a systemd unit that keeps `run.sh` running. What the server does for that setup:

| | |
|---|---|
| The public origin | Requests to `/api/` from pages of other sites are refused; `PUBLIC_ORIGIN` says which pages are the application's own. |
| Who the visitor is | `(app-server-header "x-forwarded-for")` and `"x-forwarded-proto"` are the proxy's word, which can be believed because only this machine reaches the server. Both shipped configurations overwrite what a visitor claims in those headers. |
| Cookies, sign-in | See above. Requests from other sites cannot use them: the origin check, and `SameSite=Lax`. |
| Kept connections | The proxy's connections stay open between requests, and requests sent ahead are answered in order. |
| Limits | A body of at most 1 MB (`serve-project-max-body`), 16 KB of headers; a body without a stated length is refused (nginx and Caddy state it). |
| Slow or silent visitors | Half a request is given 20 seconds, an idle connection 180 (longer than the proxies keep theirs). |
| Files | Sent with an `ETag`; an unchanged file is answered with `304`. `server.el`, `server/`, `.data/` and hidden files are never sent, nor anything a symbolic link leads to outside the project. |
| Log | One line per request on standard error: method, path, status, milliseconds. |

Tried with Caddy 2.11 (HTTPS with HTTP/2) and nginx 1.30 in front, with the shipped configurations: pages, sign-in, deferred answers, uploads up to the limit, compression and `304` all pass through, and a load of 20,000 requests through Caddy (22,000 per second) had no failures. Six minutes of mixed load (2.5 million requests, among them 370,000 SQLite inserts) ended without an error. In a second run the number of live Lisp objects after a collection was the same after each kind of load as at the start (no leak in Lisp), while the process grew from 59 MB to 105 MB and stayed there. That is fifteen minutes, not weeks. The systemd unit has not been run.

What is not there: more than one process (one Emacs uses one core), uploads of files, streaming answers and WebSockets, and password hashing made for the purpose (Emacs has SHA-2, no bcrypt or Argon2; to check passwords, let the proxy do it, with Caddy's `basic_auth` for instance). Nobody has attacked this server in earnest: it is a few hundred lines of Emacs Lisp behind a proxy, for applications among friends.

### How fast is that server?

It is one Emacs with one thread, working like Node.js: connections wait in the operating system, Emacs takes one request, runs the handler to its end, answers, takes the next. `server.el` and the server itself are byte-compiled when the server starts. Measured with ApacheBench on an Apple M4 Max, Emacs 31.1, 10 connections at a time (`ab -n 10000 -c 10`; with `-k` the connections are kept, as a proxy keeps them):

| Request | A new connection each | Kept connections |
|---|---|---|
| a handler that returns a small plist | 19,700 | 28,000 |
| a POST whose body is read and returned | 21,200 | 27,300 |
| a handler that computes `(fib 20)` (22,000 function calls) | 2,720 | 2,790 |
| `app-server-read` (a file is read) | 19,800 | 23,100 |
| an SQLite `SELECT` | 20,500 | 21,900 |
| an SQLite `INSERT` (written to disk) | 2,810 | 2,180 |
| a static file | 9,100 | 10,500 |
| a static file the browser has (`304`) | | 16,200 |

For comparison, Node.js 26 on the same machine: the small answer 21,200 (kept connections: 66,800), `fib(20)` 11,000. With one connection at a time Emacs does 7,300 per second, with 100 at a time 20,400. More than about a hundred connections arriving in the same instant exceed the queue the operating system keeps for the server; a proxy in front spares it that.

A handler that takes long holds up everyone behind it, as in any single-threaded event loop, unless it answers later. Handlers that need 100 ms of something else, measured the same way:

| Handler | 10 at a time | 50 | 100 |
|---|---|---|---|
| runs a program and waits for it (`call-process`) | 9 per second | 9 (half wait over 3 s) | |
| runs it with `app-server-run`, answers later | 86 | 426 | 840 |
| waits inside Emacs (`sleep-for`) | 89 | | 97% turned away (503) |
| `app-server-after`, answers later | 90 | | 869 |
| asks another server and waits (`url-retrieve-synchronously`) | 81 | | 98% turned away (503) |
| `app-server-fetch`, answers later | 91 | | 904 |

Answered later, the rate is simply connections ÷ 0.1 s: nobody waits for anybody. What the other requests see, the plain handler of the first table while 50 connections keep asking for the program:

| Meanwhile | The plain handler | Slowest request |
|---|---|---|
| the program is waited for | 184 per second | 5.4 s |
| the program is run with `app-server-run` | 9,400 per second | 6 ms |

Deferring itself costs nothing to speak of: a handler that defers and answers at once does 19,700 per second. The waits inside Emacs deserve a note: `sleep-for` and `url-retrieve-synchronously` let the next request in while they wait, which then runs *inside* the waiting one. Ten of those are fine; a hundred used to exhaust the stack and end the server, so beyond 32 it now turns requests away with a 503.

## Getting the project out

- **download .zip** in the header: the project as one archive that runs by itself wherever there are bash and GNU Emacs (29 or later):

  ```text
  index.html, app.el, style.css, server.el    the project
  run.sh              ./run.sh [PORT]: Emacs becomes the web server of this directory
  fetch-emacs.sh      optional: download the browser's Emacs into vendor/ (about 160 MB, needs curl)
  server/             what run.sh loads into Emacs (the HTTP server and app-server.el)
  README.txt
  ```

  After `./run.sh`, Emacs serves the page and answers its requests. The Emacs that runs the page's `app.el` in the browser is downloaded by the page from the wasmacs site; after `./fetch-emacs.sh` it is served from `vendor/` by the same Emacs instead, and nothing needs the internet any more.
- **`C-c C-p`** in Emacs (`M-x elisp-studio-publish`): `git add`, `git commit` and, if the repository has a remote named `origin`, `git push`, with the git that runs inside Emacs. Pushing to GitHub over HTTPS needs the [wasmacs companion extension](https://github.com/modeverv/wasmacs#network-access) and credentials for the remote (once: `M-x shell`, `cd ~/elisp-studio/app`, `git remote add origin https://github.com/YOU/REPOSITORY.git`). A project without `server.el` pushed to a repository with GitHub Pages enabled is then on the web.

## Language servers?

Emacs's LSP client, Eglot, is in this Emacs and loads. What is missing is a language server to talk to: it would have to be a program built for wasmacs's process service, and none is. For Emacs Lisp no server is needed: completion, documentation and jumping to definitions are Emacs's own, and the diagnostics come from Emacs's byte compiler.

## How it works

```text
studio page (js/studio.js)
  ├─ iframe: wasmacs, the editor            ../wasmacs/app/xterm-atomics-pdump.html?embed=1
  │     Emacs saves a file  ->  the page gets the tar image of /home/user (postMessage)
  ├─ iframe: the application                 the project's index.html, as srcdoc
  │     elisp-react's host and the wasmacs eval service (a second Emacs)
  │     changed .el  ->  app.load(name, text)  ->  redefined components render again
  └─ worker: the server                      the eval service again (a third Emacs), running server.el
        the application's fetch("/api/...")  ->  app-server-respond  ->  the response
```

The studio is only the wire between two things that exist without it: the editor reports its files whenever one changes, the studio compares them with what the application has, and hands the difference over. See [doc/design.md](doc/design.md).

## Development

The studio needs its two siblings on the same origin. With checkouts next to this one (`../wasmacs` built, `../elisp-react`):

```sh
npm run serve            # http://127.0.0.1:5190/elisp-studio/
npm run test:unit        # tar, zip, and a project served by a native Emacs
npm run test:e2e         # the studio in headless Chrome
npm run test:e2e:plain   # the same without isolation headers, as GitHub Pages serves
npm run test:e2e:sqlite  # the SQLite example: in the studio, then downloaded and run by itself
node tools/record-demo.mjs   # record the pictures of this README again (needs ffmpeg)
```

## Limits

- Chrome on a desktop. Two Emacsen run in the tab: several hundred megabytes of memory.
- One project.
- After a hot change, `:initial-state` and `:did-mount` of existing components are not run again; use "restart app" for a clean start.
- Errors that happen while the application runs have no location.
- The editing Emacs expands the project's macros when it checks a buffer. A macro that loops forever would hang the editor.
- Pushing to GitHub has been tested only against a repository inside Emacs's own filesystem; the path through the companion extension is wasmacs's and is tested there.
- The server in the tab keeps its data directory in memory and the studio copies it to IndexedDB after a request that changed it: fine for a small database, not for a large one.
- `run.sh` listens on 127.0.0.1 and is a single Emacs on one core; publishing it takes a reverse proxy in front ("Publishing it" above says what is and is not there).
- In the studio's tab, `app-server-token` has only Emacs's `random` to draw on, and cookies last until the studio is reloaded.
