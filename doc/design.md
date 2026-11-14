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

The frame is an `srcdoc` iframe: same origin as the studio (it can reach `contentDocument` and `contentWindow`), and it inherits the studio's cross-origin isolation.

## Starting the editor

The editor's URL carries two `extra-eval` forms, which wasmacs passes to Emacs as `--eval`: one creates the project from `template/` if `app.el` does not exist, the other visits `app.el`. The files then live in Emacs's persistent user image like everything else in `/home/user`.

## Cross-origin isolation

The editor needs `SharedArrayBuffer`, so the studio's page must be cross-origin isolated, and so must every document in it. GitHub Pages sends no such headers; `coi-serviceworker.js` (the same file wasmacs uses) adds them from a service worker. Two scopes are involved: the studio's own, and the editor's (`/wasmacs/`). A document without the headers cannot be loaded into an isolated page at all, so the editor's page could never register its own service worker from inside the iframe; the studio registers it (`ensureEditorServiceWorker`) before it sets the iframe's `src`. `npm run test:e2e:plain` runs the whole test against a server without the headers.

## What is not there yet

- A server side: a third Emacs in the tab that answers the application's `fetch("/api/...")`, running the same code that a native Emacs would run as a real server (see `examples/server` in elisp-react).
- Publishing: the project is a static site; `git` works in the editor, and a button could do the rest.
- Errors in Emacs: compile and run-time errors should show up as a buffer with locations, not only below the application.
- Evaluating one form: `C-M-x` in the editor could send a single definition instead of waiting for a save.
- More than one project.
