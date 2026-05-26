import { mkdir, writeFile, readFile, rename, unlink, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Store } from "./store.js";

// Local-filesystem Store. The atomic-write pattern (write a sibling temp file,
// then rename over the target) lives here and nowhere else — the rename is
// atomic on a single filesystem, so a crash mid-write cannot leave a partial
// object. Not safe for concurrent writers to the same key.
export class DiskStore implements Store {
  constructor(private readonly baseDir: string) {}

  private path(key: string): string {
    return join(this.baseDir, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const finalPath = this.path(key);
    await mkdir(dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    await writeFile(tmpPath, data);
    await rename(tmpPath, finalPath);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const entries = await readdir(this.baseDir);
      return entries.filter((name) => name.startsWith(prefix));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}
