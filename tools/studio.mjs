#!/usr/bin/env node
// The studio on this machine, in a Chrome window of its own.
//
//   node tools/studio.mjs                the studio as on the web: Emacs in the
//                                        page, the application next to it
//   node tools/studio.mjs DIRECTORY      a project in DIRECTORY: edit it with
//                                        your own Emacs (or anything); the
//                                        window shows the application and
//                                        follows every save
//
//   --kiosk        the whole screen, nothing of Chrome around it
//   --port N       the port of the server (5190)
//   --no-browser   start the server only and say where it is
//   --print        say what would be started, and start nothing
//   --update       forget the copies of the sibling sites, to fetch them anew
//
// Why a window of its own: a tab of an everyday Chrome has Chrome's keys for
// tabs, windows and the address bar in Emacs's way, and brings extensions
// along.  The window started here is an application window: no tabs, no
// address bar, and a profile of its own, so nothing of your browsing is in
// it and no extension.  Which keys the system and Chrome still keep to
// themselves depends on the system (the window closes with the system's
// key for that); --kiosk leaves the least around the page.
//
// The profile and the fetched files are in ~/.cache/elisp-studio/
// (ELISP_STUDIO_CACHE names another place), not in this repository.
//
// It needs Node 24 or later and Chrome (or Chromium, Edge, Brave; CHROME_PATH
// names another).  Checkouts of wasmacs (built) and elisp-react next to this
// one are used if they are there; otherwise their published files are
// fetched once and kept (tools/serve.mjs).
//
// DIRECTORY gets the template's files if it has no index.html yet.  For
// what a save does in Emacs, see lisp/elisp-studio-local.el.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDirectory, serve } from "./serve.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const portAt = args.indexOf("--port");
const port = portAt >= 0 ? Number(args[portAt + 1]) : Number(process.env.PORT || 5190);
const directory = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--port");

/** The browser to start: CHROME_PATH, or the first of the usual places that exists. */
export function findChrome(env = process.env, exists = existsSync) {
  const candidates = [
    env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/snap/bin/chromium", "/usr/bin/microsoft-edge",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return candidates.find((candidate) => candidate && exists(candidate)) || null;
}

/** The arguments of the window: an application window on URL with its own profile. */
export function chromeArguments(url, profile, { kiosk = false } = {}) {
  return [
    kiosk ? `--kiosk` : null, `--app=${url}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
    // The page's Emacs keeps its files in the browser; a window that the
    // system puts to sleep in the background loses nothing, but stalls.
    "--disable-background-timer-throttling",
  ].filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (flag("--help") || flag("-h")) {
    console.log("usage: node tools/studio.mjs [DIRECTORY] [--kiosk] [--port N] [--no-browser] [--print] [--update]");
    process.exit(0);
  }
  if (flag("--update")) rmSync(join(cacheDirectory, "sites"), { recursive: true, force: true });
  let project = null;
  if (directory) {
    project = resolve(directory);
    if (!existsSync(join(project, "index.html"))) {
      // A new project: what the studio starts one with.
      mkdirSync(project, { recursive: true });
      cpSync(join(root, "template"), project, { recursive: true, force: false, errorOnExist: false });
      console.log(`${project}: a new project, from the template`);
    }
  }
  const chrome = findChrome();
  const profile = join(cacheDirectory, "chrome");
  // localhost, not 127.0.0.1: some embedded players (YouTube's) refuse a
  // page whose Referer is an IP address.
  const page = `http://${project ? "localhost" : "127.0.0.1"}:${port}/elisp-studio/${project ? "?project=local" : ""}`;
  if (flag("--print")) {
    console.log(JSON.stringify({ page, project, chrome, arguments: chromeArguments(page, profile, { kiosk: flag("--kiosk") }) }, null, 2));
    process.exit(0);
  }
  await serve({ port, project });
  console.log(`the studio: ${page}`);
  if (project) {
    // For an editor to find the studio that follows this directory.
    writeFileSync(join(project, ".elisp-studio.json"), `${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`);
    console.log(`the project: ${project}`);
    console.log(`in Emacs:    (load "${join(root, "lisp", "elisp-studio-local.el")}")  then open a file of the project`);
  }
  if (!flag("--no-browser")) {
    if (!chrome) {
      console.log("no Chrome found (CHROME_PATH names one): open the address above in a browser");
    } else {
      mkdirSync(profile, { recursive: true });
      const window = spawn(chrome, chromeArguments(page, profile, { kiosk: flag("--kiosk") }), { stdio: "ignore" });
      // Closing the window ends the studio; ending the studio closes the window.
      window.on("exit", () => process.exit(0));
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { window.kill(); process.exit(0); });
    }
  }
}
