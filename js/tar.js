// Read a tar archive (ustar, as wasmacs writes its user image).

const decoder = new TextDecoder();

function field(block, offset, length) {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/**
 * The regular files of the archive BYTES (a Uint8Array):
 * a Map from path (without a leading slash) to Uint8Array.
 */
export function readTar(bytes) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const start = offset + 512;
    if (type === "0" && !name.endsWith("/")) {
      files.set(prefix ? `${prefix}/${name}` : name, bytes.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

const strict = new TextDecoder("utf-8", { fatal: true });

/**
 * The files below DIRECTORY (like "home/user/project") in the archive: a
 * Map from the path relative to it to the text, or to the bytes (a
 * Uint8Array) of a file that is not UTF-8 text (an image).  Editor
 * leftovers (backups, auto-saves, lock files) and hidden files (.git) are
 * left out.
 */
export function projectFiles(bytes, directory) {
  const root = `${directory.replace(/^\/+|\/+$/g, "")}/`;
  const files = new Map();
  for (const [path, content] of readTar(bytes)) {
    if (!path.startsWith(root)) continue;
    const relative = path.slice(root.length);
    const base = relative.slice(relative.lastIndexOf("/") + 1);
    if (base.endsWith("~") || base.startsWith("#") || base.endsWith(".elc")) continue;
    // Hidden files and directories (.git, lock files) are not the project's content.
    if (relative.split("/").some((part) => part.startsWith("."))) continue;
    let text;
    try { text = strict.decode(content); } catch (_) { text = content.slice(); }
    files.set(relative, text);
  }
  return files;
}
