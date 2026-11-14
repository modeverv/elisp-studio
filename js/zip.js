// Write a ZIP archive (stored, not compressed): enough to hand a small
// project to the user as one file.

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP archive of FILES, a Map (or array of pairs) from path to its
 * content: a string, a Uint8Array, or { content, executable: true } for a
 * file that is to be unpacked as a program.  DATE stamps every entry.
 * Returns a Uint8Array.
 */
export function createZip(files, date = new Date()) {
  const encoder = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [path, entryContent] of files) {
    const described = entryContent !== null && typeof entryContent === "object" && !(entryContent instanceof Uint8Array);
    const content = described ? entryContent.content : entryContent;
    const mode = described && entryContent.executable ? 0o755 : 0o644;
    const name = encoder.encode(path);
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(data);
    // Fields shared by the local header and the central directory entry.
    const common = new DataView(new ArrayBuffer(26));
    common.setUint16(0, 20, true);            // version needed
    common.setUint16(2, 0x0800, true);        // names are UTF-8
    common.setUint16(4, 0, true);             // stored
    common.setUint16(6, dosTime, true);
    common.setUint16(8, dosDate, true);
    common.setUint32(10, crc, true);
    common.setUint32(14, data.length, true);  // compressed size
    common.setUint32(18, data.length, true);  // size
    common.setUint16(22, name.length, true);
    common.setUint16(24, 0, true);            // no extra field
    const local = new Uint8Array(30 + name.length);
    new DataView(local.buffer).setUint32(0, 0x04034b50, true);
    local.set(new Uint8Array(common.buffer), 4);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const view = new DataView(entry.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, (3 << 8) | 20, true);   // made by: Unix, so that the mode below counts
    entry.set(new Uint8Array(common.buffer), 6);
    view.setUint32(38, ((0o100000 | mode) << 16) >>> 0, true);   // a regular file with its permissions
    view.setUint32(42, offset, true);         // where its local header is
    entry.set(name, 46);
    chunks.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((size, entry) => size + entry.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, central.length, true);
  view.setUint16(10, central.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  const parts = [...chunks, ...central, end];
  const zip = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let position = 0;
  for (const part of parts) {
    zip.set(part, position);
    position += part.length;
  }
  return zip;
}
