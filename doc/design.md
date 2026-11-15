# Design

## Three projects

| Project | What it is | What the studio uses |
|---|---|---|
| [wasmacs](https://github.com/modeverv/wasmacs) | GNU Emacs in the browser | the editor page in embed mode; the eval service (Emacs as a Lisp engine) |
| [elisp-react](https://github.com/modeverv/elisp-react) | React in Emacs Lisp | its host inside the application's frame; redefinition of components; `load` |
| elisp-studio | this | the page that puts them side by side and connects them |

The studio has no Emacs Lisp of its own and changes nothing in the other two at run time. It loads them from sibling paths of its own origin, `../wasmacs/` and `../elisp-react/`: on GitHub Pages the three project sites share the origin `modeverv.github.io`, and `tools/serve.mjs` lays local checkouts out the same way.

## Two Emacsen

The editor and the application are separate Emacs instances in separate workers, on purpose.

- The editor is the wasmacs product: it runs Emacs's command loop and never returns to its worker's event loop. It cannot also be an engine that answers requests.
- The application's Emacs is the eval service: it runs only while it evaluates a request. An endless loop in the application's program blocks that worker for good, and the only cure is to throw it away. With two instances that costs nothing but the application's state: the editor, its buffers and the files are untouched, and a new application starts in a fraction of a second from the browser's cache.

## From a save to the page

1. Emacs writes a file. At its next idle wait the wasmacs worker notices that `/home/user` differs from what it last reported and posts the tar image of the whole directory to its page (it does this anyway, to keep the files in IndexedDB).
2. In embed mode the editor page forwards the image to the page that embeds it: a `wasmacs:user-image` message.
3. `js/studio.js` reads the tar (`js/tar.js`), takes the files below the project directory and compares each with the text the application was last given.
4. For a changed file:
   - `.el` that `index.html` loads: `app.load(name, text)` in the application's frame. elisp-react's host byte-compiles the source in the application's Emacs, loads it and applies the DOM operations of the flush. A `react-define-component` for a component that is on the page gives its instances the new definition and renders them with their state.
   - stylesheet that `index.html` links: the text of its `<style>` element is replaced.
   - `index.html`: a new application.
5. The status line says what was applied; an error from step 4 is shown below the application and nothing else changes.

The whole image is sent for every change. A project is small, so this is simple rather than slow; a large `/home/user` would call for sending only what changed.

## The application's frame

The project's `index.html` is a complete page for a static host: it links `style.css`, names `app.el` in a `<script type="text/emacs-lisp">` and loads elisp-react's host from its public URL. Inside the studio the files exist only in the editor's filesystem, so the studio builds the frame's document itself (`buildDocument`):

- linked stylesheets that are project files become `<style>` elements;
- the Emacs Lisp scripts are taken out and become the `sources` handed to the host's `start`;
- the host's own `<script>` is replaced by one that imports the host from `../elisp-react/` and hands `start` to the studio, which calls it inside the frame.

The frame is an `srcdoc` iframe: same origin as the studio (it can reach `contentDocument` and `contentWindow`), and it inherits the studio's cross-origin isolation. Its address is `about:srcdoc` and its base URL the studio's, so `pushState` throws there and a hash link would load the studio into the frame. elisp-react therefore keeps the application's address in memory in such a frame and follows hash links itself; the studio's address bar follows it (`elisp-react:location`) and moves it (`app.location.navigate`, `go`).

Relative URLs resolve against the studio's page there, which used to hand the application the studio's own files (`package.json`, `index.html`). The application's `fetch` (the studio's `applicationFetch`) answers a relative URL from the project's files instead; on one's own machine the built document also gets a `<base>` at `/__project/files/`, which the server answers from the directory (with the project server's filters), so the browser's own requests (`<img>`, fonts) find the files. The page's studio has no such server; its file image keeps files that are not UTF-8 as bytes.

## Starting the editor

The editor's URL carries two `extra-eval` forms, which wasmacs passes to Emacs as `--eval`: one creates the project from `template/` if `app.el` does not exist, the other visits `app.el`. The files then live in Emacs's persistent user image like everything else in `/home/user`.

## Cross-origin isolation

The editor needs `SharedArrayBuffer`, so the studio's page must be cross-origin isolated, and so must every document in it. GitHub Pages sends no such headers; `coi-serviceworker.js` (the same file wasmacs uses) adds them from a service worker. Two scopes are involved: the studio's own, and the editor's (`/wasmacs/`). A document without the headers cannot be loaded into an isolated page at all, so the editor's page could never register its own service worker from inside the iframe; the studio registers it (`ensureEditorServiceWorker`) before it sets the iframe's `src`. `npm run test:e2e:plain` runs the whole test against a server without the headers.

## Talking with the editor

Two more channels connect the page and the editing Emacs, both through the terminal, because that is the only pipe a blocked Emacs has.

- **Emacs to the page.** `elisp-studio--send` writes a JSON object in an OSC 7777 escape sequence to the terminal. wasmacs's terminal hands the text to its page, which forwards it to the studio (`wasmacs:message`). Used for `C-M-x` (the definition's text) and to announce a save.
- **The page to Emacs.** `tellEditor` types `ESC [ 7777 ~`, the base64 of a JSON object, `ESC [ 7778 ~` into the terminal (`wasmacs:input`). In Emacs the start sequence is bound in `input-decode-map` to a function that reads up to the end sequence, the way xterm's bracketed paste is read, and returns one event that carries the message. Used for the result of every change.

`lisp/elisp-studio.el` is the editor's side. The studio passes it, the project template and the libraries as `--eval` forms; the editor's page asks for them by message (`wasmacs:options-request`), since whole files do not fit into a URL.

### Results and diagnostics

elisp-react's host byte-compiles each saved file in the application's Emacs and returns what the compiler printed. The studio replaces the file's name inside that Emacs by the project file's name in the editor and sends the text along with the one-line result. In the editor it is shown in `*elisp-studio*` in `compilation-mode`.

Diagnostics while typing do not wait for that round trip. Emacs's own Flymake backends for Emacs Lisp start a second Emacs process, which is not possible here, so `elisp-studio-flymake` compiles in the editing Emacs itself: the buffer's text goes to a scratch file, `byte-compile-file` reads it, and `byte-compile-log-warning-function` collects the messages with their positions instead of logging them. Compiling does not run the program. It does expand macros, the project's own included.

### What the editor knows

For completion, ElDoc, `C-h f` and `M-.`, and for the compiler not to call every function unknown, the editing Emacs has to have the functions the project uses, without being the application.

- The libraries, `react.el` and `app-server.el`, are simply loaded (from files, so that `M-.` has a place to go). They do nothing there.
- The project's own files are not loaded: their top level is the program (`react-mount`, requests, timers). `elisp-studio-learn-file` reads a file form by form and takes only definitions: functions, macros, structures and errors are evaluated (their bodies are not called by anything in the editor), variables are declared and given their documentation but not their values, and everything else is skipped. Each definition is entered in `load-history` under the file's name, which is what `M-.` looks up. This happens for the whole project when the editor starts and for a file whenever it is saved.

### C-M-x

The definition at point goes to the application as text and is evaluated there (not compiled). The application now differs from the files. The studio remembers the file as "unsaved"; when Emacs announces a save of it, the next file image is applied even if its text is what the application was given before.

## The server

`lisp/app-server.el` defines the contract of a project's `server.el`: `app-server-handle (method path body)` returns Lisp data or signals an error, and `app-server-respond` turns that into a status and a printed body. The same two files run in two hosts:

- In the studio, a third eval service worker. The studio gives the application a `fetch` (elisp-react's `start({ fetch })`) that hands requests for `/api/...` to `app-server-respond` and builds the `Response`; everything else goes to the network. The server's data directory is in that Emacs's memory. After each request the studio asks for a signature of its files (names, sizes, times); when it changed, it takes the files (`app-server--dump`, base64) and puts them into IndexedDB; a new server gets them back before `server.el` is loaded (`app-server--restore`). A request that does not return within eight seconds ends that Emacs and starts another.
- `tools/serve-project.el`, a small HTTP server in Emacs Lisp for a native Emacs: files from the project directory, `/api/...` through `app-server-respond`, data in `.data/`.

### Answering later

`app-server-handle` may return the value of `app-server-defer`. `app-server-respond` then calls the deferred function with `respond` and `fail`, returns nil instead of `[STATUS TEXT]`, and delivers the answer to the function its caller passed (`later`) when one of the two is called; the first call counts. `app-server--guard` wraps every function that runs later so that an error fails the request it belongs to.

What can be waited for is behind three variables, because the hosts differ:

- `tools/serve-project.el` keeps the connection open and sends the response from `later`. Timers (`run-at-time`), url.el (`url-retrieve`) and `make-process` do the waiting; a timer answers 504 after `app-server-deferred-timeout`.
- The Emacs in the tab runs only while it answers a call of the page, so it has no timers and no network. `app-server-use-tab-host` makes `app-server-after` and `app-server-fetch` queue commands instead. The studio calls `app-server-tab-request`, which returns the answer or a pending id, along with the commands; the page runs them (`setTimeout`, `fetch`), reports each result with `app-server-tab-report`, and every such call returns the deferred answers that are complete by then. `app-server-run` fails there.

Emacs's own waits (`sleep-for`, `accept-process-output`, `url-retrieve-synchronously`) run other process filters while they wait, so a handler that uses them is re-entered by the next request. `serve-project.el` counts that nesting and answers 503 beyond 32, because a hundred nested handlers exhausted the stack and ended the server.

### Behind a reverse proxy

`serve-project.el` stays on 127.0.0.1 and plain HTTP/1.1; what faces the internet is Caddy or nginx on the same machine (configurations in `tools/project/deploy/`, shipped in the download as `server/deploy/`, which is not served). The pieces that exist for that setup:

- The origin check takes `PUBLIC_ORIGIN` (`serve-project-origins`) besides the server's own address.
- A connection is a small state machine in the process's plist: `:input` (bytes not yet consumed), `:busy` (a request is being answered, perhaps later), `:keep`, `:head`, `:since`. `serve-project--next` takes one complete request off `:input`; `serve-project--respond` sends, and either closes or clears `:busy` and schedules `--next` for what is already buffered. So requests on one connection are answered in order, also when an answer is deferred.
- One timer (`serve-project--sweep`) closes connections that wait too long, rather than a timer per connection: 408 for half a request, a silent close for an idle one. The idle time is longer than the proxies' so that they, not the server, close idle connections (the other order loses requests).
- Request and response headers travel in `app-server--request`, a struct that is dynamically bound while the handler runs and captured by `app-server--guard` for what runs later. `app-server-respond` returns `[STATUS TEXT HEADERS]`. Header values are checked for control characters before they are sent.
- In the tab there is no browser cookie handling between the application and the server (the request never reaches the network stack), so `js/studio.js` keeps a jar: `Set-Cookie` of an answer goes in, a `cookie` header goes out with the next request.
- Speed: the server's own functions are loaded as source and then byte-compiled in memory (`serve-project--compile`), `gc-cons-threshold` is 16 MB in `serve-project-run`, and a file's true name is asked for only when a symbolic link is on its path. Together: 14,400 to 19,700 requests per second for a small answer, 2,750 to 9,100 for a file, and the 9 ms tail (a collection every hundred requests or so) is gone.

### Files, passwords, workers

- **Uploads.** `serve-project--next` asks `app-server-upload-accept` once per request, when the headers are complete. If server.el's `app-server-upload-p` says yes, the connection goes into an upload state (`:upload`, `:upload-left`): the filter appends each chunk to a temporary file in `.data/uploads/` (`serve-project--take`) instead of collecting it in `:input`, so memory does not grow with the file. When the last byte is there the request is answered like any other, with the upload in `app-server--request`. The temporary file is deleted with the answer (`serve-project--forget-upload`, also from the sentinel when the visitor leaves). An upload has no total time limit, only the 20 seconds between chunks.
- **Sending files.** `app-server-send-file` makes the answer's body `(:file ...)` instead of text; `serve-project--respond` then sends the file in 1 MB pieces. `process-send-string` to a slow reader waits inside Emacs's process loop, which keeps serving other connections, so a slow download does not stop the server (measured). Static files over 1 MB go the same way.
- **In the tab** a non-text body is base64 in the JSON call (`app-server-tab-request`'s UPLOAD) and a file answer is base64 back; kept files are part of the data dump (`files/NAME`). A click on a link to `/api/` in the application's frame is turned into a request to the server and a download by the studio.
- **Passwords.** The `-later` functions own the stored format (`ALGORITHM$COST$SALT$DIGEST`), the salt and the comparison; the arithmetic is behind one more host variable, `app-server-kdf-function` (ALGORITHM COST PASSWORD SALT THEN), like timers and requests. Under a native Emacs it is `app-server--kdf-process`: a queue that runs at most `app-server-password-jobs` processes, each either `python3 -c` with a fifteen-line script (found and asked once what its `hashlib` can do) or, without Python and for PBKDF2 only, `emacs --batch -l app-server.el --eval (app-server--password-child)`. The request goes in on standard input, so the password is not on a command line. In the tab it is a `kdf` command to the page, which uses `crypto.subtle.deriveBits`. THEN gets nil for an algorithm the host does not have, and the request fails; nothing falls back to a weaker algorithm. `app-server--pbkdf2`, RFC 8018 on `secure-hash`, is the fallback and the synchronous variant; it compiles itself when the file is loaded as source (interpreted it is four times slower). The three implementations are tested against one another and against Node.js.
- **Workers.** `WORKERS=N` makes the launch script start N Emacs processes on consecutive ports and end all of them when one ends. Nothing is shared in memory. On disk: SQLite gets `busy_timeout` always and `journal_mode = WAL` when `app-server-shared`; `app-server-write` writes a temporary file and renames it. Without the busy timeout, 95% of concurrent inserts from four workers failed with "database is locked"; with both, none of 15,000.
- **Sessions and attempts.** `app-server-session-start` draws 32 random bytes (`app-server-token`), gives them to the browser in hex as the cookie, and stores their SHA-256 with the printed VISITOR and the expiry in `.data/server.db` (tables `sessions` and `attempts`; a failure is stored under the SHA-256 of the lower-cased name or address). Rows that ran out are deleted when a session starts or an attempt fails. Without SQLite a hash table in memory takes the database's place.
- **Random bytes** come from `/dev/urandom`, read with `insert-file-contents-literally` without a start position: Emacs 30 refuses a start position for a device, and Emacs 29 does not read part of a device at all, so there `head -c` does it. In the tab the same read works, because the wasm runtime's `/dev/urandom` is the browser's `crypto.getRandomValues`. Until 2026-11-15 the read was tried with a start position, failed in the tab's Emacs 30.2, and the tab fell back to Emacs's `random`. There is no fallback any more: a system without random bytes signals an error.
- **Tokens (JWT) are not there.** A token the application signs itself (HS256) needs nothing new; the README says what was tried ("Tokens"). Checking a token of someone else (RS256, ES256) would be one more host function next to `app-server-kdf-function`: a child process (`openssl`) under a native Emacs, `crypto.subtle.verify` in the tab. It is not built; signing in through a provider is left to the proxy.

### What the security check changed

[security.md](security.md) has the findings. In the code:

- `serve-project--file` decides from the name alone (no control characters, inside the root, not hidden, not `server*`, not `*.sh`) before it asks the disk anything, and binds `file-name-handler-alist` to nil: a name from a request is never a TRAMP, compressed or encrypted file.
- `app-server-data` reads a body with `obarray` bound to a fresh one, then rebuilds the value from strings, numbers, conses and vectors, mapping each symbol to the one of that name in the real obarray (`intern-soft`) or refusing. The temporary obarray is garbage afterwards, so nothing a visitor sent stays. Size and depth are bounded while rebuilding, which also ends circular structures.
- `serve-project--next` accepts a header line only if it is `token: value` without control characters, and at most one `Content-Length`; the method is upper-case letters.
- `serve-project--handle` refuses a `Host` that is not the server's (421) and, for `/api/`, requests that are foreign by `Origin` or by `Sec-Fetch-Site: cross-site`. `X-Forwarded-*` headers are removed before `server.el` sees them unless `PUBLIC_ORIGIN` declares a proxy.
- `serve-project--accepted` (the server's `:log` function, which Emacs calls for each accepted connection) keeps the number of connections at `serve-project-max-connections` by closing an idle one; the sweep gives connections that never sent anything the request timeout rather than the idle timeout.
- `app-server-explain-errors` is nil under `serve-project.el`: conditions other than `error`, `user-error` and `app-server-refusal` are logged and answered with a fixed text.

### SQLite

`app-server-database` opens `NAME.db` in the data directory with Emacs's `sqlite-open` and keeps the connection. That is all there is to it on both hosts: natively the file is on disk; in the tab it is in the in-memory filesystem and is persisted as described above (a 12 KB database is 16 KB of base64 per changing request, so this is for small data). wasmacs links SQLite into the browser's Emacs without the write-ahead log, so a database is one file plus a transient `-journal`, which the dump leaves out.

### A project that runs itself

The download adds to the project's own files what `tools/project/` holds: `run.sh` starts the first native Emacs that works with `server/serve-project.el`, and `fetch-emacs.sh` copies the files the page needs from the wasmacs and elisp-react sites into `vendor/` (the eval service's four scripts, the build id, `temacs.js`, `temacs.wasm`, the pdmp and Emacs's Lisp; `react.el` and the host). Emacs's Lisp is all 146 MB of it by default, because that is what the studio has and a project must not run there and fail on its own site; `--core` takes wasmacs's core package instead (`temacs.core.data`, 21.6 MB: the language and its library, compiled). What lies in `vendor/` is not what a visitor downloads. Either package comes with an index, `temacs.files.json`, from which the page's Emacs knows where each file is; it asks for a file when it reads it, with a range request, which `serve-project.el` answers from the one large file without reading the rest. The index of the core package is stored under the name the page asks for, and the build id gets `-core` appended, so that a browser which had the whole package from the same site does not mix the two. Emacs itself (`temacs.wasm`, the pdmp, `temacs.js`, the index) is what every visitor downloads, 16.6 MB as it is; the script keeps a gzip copy next to each, and `serve-project.el` sends the copy of a file to a browser that takes gzip (4.7 MB). It compresses nothing itself, and the proxies in front do not compress the pdmp (`application/octet-stream`), which is why the copies exist. When `vendor/` is there, `serve-project.el` sends `index.html` with its link to the elisp-react site rewritten to `/vendor/elisp-react/` and a `<meta name="elisp-react:wasmacs" content="/vendor/wasmacs/">`, which is the switch elisp-react's host has for exactly this. The project's own `index.html` stays the one that works on a static host.

`test/e2e-sqlite.mjs` follows the whole path: the example in the studio, the ZIP out of the page, `fetch-emacs.sh` against the local server, that server switched off, `run.sh`, and Chrome on the result, which may load from one origin only.

Requests and responses are printed Lisp on both. Nothing a page sends is evaluated: a body is `read` as data by the project's handler.

## Publishing

The studio already has the project's files (it reads them from the editor's image), so the ZIP is built in the page (`js/zip.js`). The git path lives entirely in Emacs: `elisp-studio-publish` runs `git` with `process-file` in wasmacs's process service. Hidden files, `.git` among them, are not part of what the studio treats as the project.

## A project in a directory

On one's own machine the editor does not have to be the Emacs in the page. `tools/studio.mjs DIRECTORY` starts the development server with that directory and a window on `?project=local`. The page then starts no editor frame; `tools/local-project.mjs` looks at the directory every 150 ms and, when its text files have changed and stopped changing, sends all of them to the page (server-sent events). The page gives them to the same `applyProject` that gets the files of the editor's image, so everything after that is the path of a save in the studio: the server first, then the changed files, state kept. It is the directory that is watched, not an editor, so any program that writes files will do, and what editors leave beside a file (backups, lock files, compiled files) is not part of the project, as in the editor's image.

The way back is `report`: where the studio would type its answer into the page's Emacs, it posts it to the server, which keeps the latest with a number. `lisp/elisp-studio-local.el`, in a native Emacs, asks for that number before a save and for the next report after it afterwards, with a request that waits; the compiler's messages name the files of the directory, because the page calls the project by the directory's name. `C-M-x` posts the definition to the server, which passes it to the page as an event, and waits for the report in the same way. A file `.elisp-studio.json` in the directory tells Emacs which files belong to a project and where its studio is.

These requests (`/__project/...`) can read the directory's text files and evaluate Lisp in the application, so the server answers them only under its own name and not to a page of another site (the `Origin` and `Sec-Fetch-Site` of a browser, the `Host` against a domain pointed at 127.0.0.1). An editor is not a browser and sends neither.

The window is Chrome with `--app` and a profile of its own. Sibling sites without a checkout are fetched from where they are published and kept, whole files only: a part of `temacs.data` that the page's Emacs asks a range of is fetched whole once.

## What is not there yet

- More than one project, and a way to start a new one from the page.
- For a project in a directory: `server.el` in a native Emacs next to the window (it runs in the tab), and the page's Emacs and the directory kept in step with each other.
- Locations for errors that happen while the application runs.
- A language server for anything but Emacs Lisp: Eglot is there, a server program for wasmacs's process service is not.
- A button for the whole way to a public URL (create the repository, push, enable Pages).
