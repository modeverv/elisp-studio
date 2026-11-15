// Development server: the studio and its two sibling sites on one origin,
// laid out as on GitHub Pages.
//
//   node tools/serve.mjs            http://127.0.0.1:5190/elisp-studio/
//   node tools/serve.mjs --plain    without isolation headers, as GitHub Pages
//                                   serves: the service workers have to add them
//
//   /elisp-studio/   this repository
//   /wasmacs/        ../wasmacs/docs   (a built wasmacs checkout)
//   /elisp-react/    ../elisp-react
//
// Without one of the two checkouts, that site's files are taken from where
// it is published (https://modeverv.github.io/) when they are first asked
// for, and kept in ~/.cache/elisp-studio/sites/: a clone of this repository
// is enough.
//
// With a project directory (tools/studio.mjs DIRECTORY) the server also
// tells the studio's page about that directory: see local-project.mjs.
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localProject } from "./local-project.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** Where this machine keeps what the studio fetched or made: not in the repository. */
export const cacheDirectory = process.env.ELISP_STUDIO_CACHE || join(homedir(), ".cache", "elisp-studio");
export const mounts = {
  "/elisp-studio/": root,
  "/wasmacs/": resolve(process.env.WASMACS_DOCS || `${root}/../wasmacs/docs`),
  "/elisp-react/": resolve(process.env.ELISP_REACT || `${root}/../elisp-react`),
};
const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".el": "text/plain; charset=utf-8",
};

// A file of a site that has no checkout here: from where the site is
// published, once, then from the cache.  Resolves with the file's name
// in the cache, or null if the site has no such file.
const fetching = new Map();
function published(sites, cache, prefix, relative) {
  if (relative === "" || relative.endsWith("/")) relative += "index.html";
  const file = join(cache, prefix, relative);
  if (!file.startsWith(join(cache, prefix))) return Promise.resolve(null);
  if (existsSync(file) && statSync(file).isFile()) return Promise.resolve(file);
  if (!fetching.has(file)) {
    fetching.set(file, (async () => {
      const response = await fetch(new URL(`${prefix.slice(1)}${relative.split("/").map(encodeURIComponent).join("/")}`, sites));
      if (!response.ok) return null;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.part`, Buffer.from(await response.arrayBuffer()));
      await rename(`${file}.part`, file);
      return file;
    })().catch(() => null).finally(() => fetching.delete(file)));
  }
  return fetching.get(file);
}

/**
 * Start the server.  Resolves with { server, origin, project }.
 *   project   a directory: the studio's page is told about its files
 *   sites     where the sibling sites are published, for those without a
 *             checkout here; cache: where their files are kept
 */
export async function serve({ port = 0, plain = false, project = null,
                              sites = process.env.PUBLIC_SITES || "https://modeverv.github.io/",
                              cache = join(cacheDirectory, "sites") } = {}) {
  const local = project ? localProject(project) : null;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = normalize(decodeURIComponent(url.pathname));
    if (path === "/") {
      response.writeHead(302, { Location: "/elisp-studio/" }).end();
      return;
    }
    if (path.startsWith("/__project/")) {
      if (local) local.handle(request, response, url);
      else response.writeHead(404).end("no project");
      return;
    }
    const prefix = Object.keys(mounts).find((candidate) => path.startsWith(candidate));
    let file = prefix && join(mounts[prefix], path.slice(prefix.length));
    if (prefix && prefix !== "/elisp-studio/" && !existsSync(mounts[prefix])) {
      file = await published(sites, cache, prefix, path.slice(prefix.length));
    } else {
      if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!file || !file.startsWith(mounts[prefix]) || !existsSync(file) || !statSync(file).isFile()) file = null;
    }
    if (!file) {
      response.writeHead(404).end("not found");
      return;
    }
    const headers = {
      "Content-Type": mimeTypes[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      ...(plain ? {} : {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "cross-origin",
      }),
    };
    // A part of a file, as GitHub Pages sends one: the application's Emacs
    // reads its Lisp files as ranges of one large file.
    const size = statSync(file).size;
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
    if (range && Number(range[1]) <= Number(range[2]) && Number(range[1]) < size) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), size - 1);
      response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", done);
  });
  // (Closing waits for the connections to end, and a page that listens
  // to the project keeps its connection.)
  const close = server.close.bind(server);
  server.close = (done) => { local?.close(); server.closeAllConnections?.(); return close(done); };
  return { server, origin: `http://127.0.0.1:${server.address().port}`, project: local };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [prefix, directory] of Object.entries(mounts)) {
    if (!existsSync(directory)) console.warn(`${prefix}: no checkout at ${directory}; its files come from where it is published`);
  }
  const { origin } = await serve({ port: Number(process.env.PORT || 5190), plain: process.argv.includes("--plain") });
  console.log(`${origin}/elisp-studio/`);
}
