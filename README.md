# elisp-studio

Write a web application in Emacs Lisp, in the browser, and watch it change without a reload.

Live: <https://modeverv.github.io/elisp-studio/> (Chrome on a desktop; the first visit downloads Emacs, about 150 MB, which the browser then keeps).

[日本語](README.ja.md)

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

The project is `/home/user/elisp-studio/app` in Emacs's filesystem, which the browser keeps: it is still there at the next visit. It is the same `/home/user` that the wasmacs page itself uses, so the project is also there when you open wasmacs directly. It has three files, and together they are a static web site that works on its own:

```text
index.html   the page: a <div id="app">, the stylesheet, <script type="text/emacs-lisp" src="app.el">
app.el       the program, with elisp-react
style.css    the stylesheet
```

What happens when a file is saved:

| File | Effect |
|---|---|
| a `.el` file that `index.html` loads | Compiled and evaluated in the running application. Components that are defined again render with the state they have. |
| a stylesheet that `index.html` links | Swapped in place. |
| `index.html` | The application starts again (its state is reset). |

A mistake does not take the application down: if the new code does not load, the error is shown under the application and the old code keeps running. An endless loop does take it down, and only it: the studio starts a new application at the next save, and Emacs keeps editing. The "restart app" button starts the application again from the files.

## How it works

```text
studio page (js/studio.js)
  ├─ iframe: wasmacs, the editor            ../wasmacs/app/xterm-atomics-pdump.html?embed=1
  │     Emacs saves a file  ->  the page gets the tar image of /home/user (postMessage)
  └─ iframe: the application                 the project's index.html, as srcdoc
        elisp-react's host and the wasmacs eval service (a second Emacs)
        changed .el  ->  app.load(name, text)  ->  redefined components render again
```

The studio is only the wire between two things that exist without it: the editor reports its files whenever one changes, the studio compares them with what the application has, and hands the difference over. See [doc/design.md](doc/design.md).

## Development

The studio needs its two siblings on the same origin. With checkouts next to this one (`../wasmacs` built, `../elisp-react`):

```sh
npm run serve            # http://127.0.0.1:5190/elisp-studio/
npm run test:unit        # the tar reader
npm run test:e2e         # the studio in headless Chrome
npm run test:e2e:plain   # the same without isolation headers, as GitHub Pages serves
```

## Limits

- Chrome on a desktop. Two Emacsen run in the tab: several hundred megabytes of memory.
- One project. There is no way yet to publish it from the studio, though `git` works in the Emacs on the left.
- After a hot change, `:initial-state` and `:did-mount` of existing components are not run again; use "restart app" for a clean start.
- Errors are shown under the application, not in Emacs.
- There is no server side yet (a third Emacs in the tab that answers the application's requests is the plan).
