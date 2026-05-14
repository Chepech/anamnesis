import zlib from "zlib";
import fs from "fs";
import path from "path";

/**
 * Decompresses and extracts a .tar.gz buffer into destDir.
 * Handles ustar (POSIX) format — the format used by all npm tarballs.
 * npm packages wrap all entries under a "package/" prefix which is stripped.
 */
export async function extractTarGz(data: Buffer, destDir: string): Promise<void> {
  const tar = await gunzip(data);
  parseTar(tar, destDir);
}

function gunzip(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gunzip(data, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function parseTar(data: Buffer, destDir: string): void {
  let pos = 0;

  while (pos + 512 <= data.length) {
    const header = data.subarray(pos, pos + 512);
    pos += 512;

    // Two consecutive zero-filled blocks = end of archive
    if (header[0] === 0) break;

    const name = readStr(header, 0, 100);
    const prefix = readStr(header, 345, 155); // ustar long-path prefix
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(readStr(header, 124, 12).trim() || "0", 8);
    const typeFlag = String.fromCharCode(header[156]);

    const dataEnd = pos + size;

    if ((typeFlag === "0" || typeFlag === "\0") && fullName) {
      // Strip npm's "package/" wrapper prefix, reject path traversal
      const rel = fullName.replace(/^package\//, "");
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        const dest = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data.subarray(pos, dataEnd));
      }
    }

    // Advance to next 512-byte boundary
    pos += Math.ceil(size / 512) * 512;
  }
}

function readStr(buf: Buffer, offset: number, length: number): string {
  return buf
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0+$/, "");
}
