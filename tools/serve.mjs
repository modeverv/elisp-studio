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
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
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

/** Start the server.  Resolves with { server, origin }. */
export async function serve({ port = 0, plain = false } = {}) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname));
    if (path === "/") {
      response.writeHead(302, { Location: "/elisp-studio/" }).end();
      return;
    }
    const prefix = Object.keys(mounts).find((candidate) => path.startsWith(candidate));
    let file = prefix && join(mounts[prefix], path.slice(prefix.length));
    if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file || !file.startsWith(mounts[prefix]) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      ...(plain ? {} : {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "cross-origin",
      }),
    });
    createReadStream(file).pipe(response);
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", done);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [prefix, directory] of Object.entries(mounts)) {
    if (!existsSync(directory)) console.warn(`warning: ${prefix} -> ${directory} does not exist`);
  }
  const { origin } = await serve({ port: Number(process.env.PORT || 5190), plain: process.argv.includes("--plain") });
  console.log(`${origin}/elisp-studio/`);
}
