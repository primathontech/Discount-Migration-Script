import { open, readFile, unlink } from 'node:fs/promises';

// JSONL of one shopify_id per line — survives crashes via append-only writes.
export class MigrationLedger {
  constructor(filePath) {
    this.filePath = filePath;
    this.ids = new Set();
    this.handle = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const content = await readFile(this.filePath, 'utf8');
      for (const line of content.split('\n')) {
        const id = line.trim();
        if (id) this.ids.add(id);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this.handle = await open(this.filePath, 'a');
  }

  has(shopifyId) {
    return shopifyId ? this.ids.has(shopifyId) : false;
  }

  size() {
    return this.ids.size;
  }

  // Serialize writes so concurrent workers can't interleave bytes mid-line.
  async record(shopifyId) {
    if (!shopifyId || this.ids.has(shopifyId)) return;
    this.ids.add(shopifyId);
    this.writeQueue = this.writeQueue.then(() =>
      this.handle.write(`${shopifyId}\n`, null, 'utf8'),
    );
    return this.writeQueue;
  }

  async close() {
    await this.writeQueue;
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}

export async function resetLedgerFile(filePath) {
  try {
    await unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
