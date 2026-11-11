import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  packContent,
  packedContentSchema,
  unpackContent,
  parseContentText,
} from "@inhuman.tools/harness-contract/schema";

import { encodeLogEntry, isEmptyUpdate, readUpdateLog } from "./update-log.js";

const hashText = (text: string): string => createHash("sha256").update(JSON.stringify(text)).digest("hex");
type ContentAccess = { readers: number; maintenance: Promise<void> | null; known: Set<string> };
const roots = new Map<string, ContentAccess>();

function physicalRoot(root: string): string {
  const missing: string[] = [];
  let existing = resolve(root);
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`No existing ancestor for content root: ${root}`);
    existing = parent;
  }
  return join(realpathSync(existing), ...missing);
}

export class DocumentContentStore {
  readonly #access: ContentAccess;
  readonly #root: string;
  readonly #documents: string;

  constructor(root: string) {
    root = physicalRoot(root);
    this.#root = join(root, "documents", "content");
    this.#documents = join(root, "documents");
    const existing = roots.get(this.#root);
    this.#access = existing ?? { readers: 0, maintenance: null, known: new Set() };
    roots.set(this.#root, this.#access);
  }

  async withImageAccess<T>(read: () => Promise<T>): Promise<T> {
    while (this.#access.maintenance !== null) await this.#access.maintenance;
    this.#access.readers++;
    try {
      return await read();
    } finally {
      this.#access.readers--;
    }
  }

  async encode(update: Uint8Array): Promise<Uint8Array> {
    if (isEmptyUpdate(update)) return update;
    const { packed, texts } = packContent(new TextDecoder().decode(update), hashText);
    for (const [hash, text] of texts) await this.#put(hash, text);
    return new TextEncoder().encode(JSON.stringify(packed));
  }

  encodedSize(update: Uint8Array): number {
    if (isEmptyUpdate(update)) return update.byteLength;
    return Buffer.byteLength(JSON.stringify(packContent(new TextDecoder().decode(update), hashText).packed));
  }

  /** Offline maintenance: live daemons and in-flight readers must release the root first. */
  async collectGarbage(): Promise<number> {
    if (this.#access.readers !== 0 || this.#access.maintenance !== null)
      throw new Error("Content collection requires an idle root");
    const release = Promise.withResolvers<void>();
    this.#access.maintenance = release.promise;
    try {
      for (const name of ["daemon.sock", "private-peer.sock", "root.sock"]) {
        const exists = await access(join(dirname(this.#documents), name)).then(
          () => true,
          (error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (exists) throw new Error("Stop the daemon before collecting document content");
      }
      return await this.#collectGarbage();
    } finally {
      this.#access.maintenance = null;
      release.resolve();
    }
  }

  async #collectGarbage(): Promise<number> {
    const live = new Set<string>();
    for (const kind of ["kernel", "projects", "sessions"]) {
      let names: string[];
      try {
        names = await readdir(join(this.#documents, kind));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      for (const imageName of names.filter((name) => /^[0-9a-f]{64}\.yjs$/.test(name))) {
        const updates = readUpdateLog(await readFile(join(this.#documents, kind, imageName)));
        if (updates === null) throw new Error(`Cannot collect content while image is unreadable: ${kind}/${imageName}`);
        for (const update of updates) {
          if (isEmptyUpdate(update)) continue;
          const raw: unknown = JSON.parse(new TextDecoder().decode(update));
          if (raw !== null && typeof raw === "object" && "format" in raw && raw.format === "content-v1") {
            for (const { hash } of packedContentSchema.parse(raw).texts) live.add(hash);
          }
        }
      }
    }
    let removed = 0;
    const fans = await readdir(this.#root).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    for (const fan of fans.filter((name) => /^[0-9a-f]{2}$/.test(name))) {
      for (const hash of await readdir(join(this.#root, fan))) {
        if (/^[0-9a-f]{64}$/.test(hash) && !live.has(hash)) {
          await unlink(this.#path(hash));
          removed++;
        }
      }
    }
    this.#access.known.clear();
    return removed;
  }

  async decode(update: Uint8Array): Promise<Uint8Array> {
    if (isEmptyUpdate(update)) return update;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(update));
    if (parsed === null || typeof parsed !== "object" || !("format" in parsed) || parsed.format !== "content-v1")
      return update;
    const packed = packedContentSchema.parse(parsed);
    const texts = new Map<string, string>();
    for (const { hash } of packed.texts) {
      if (texts.has(hash)) continue;
      const text = parseContentText(await readFile(this.#path(hash), "utf8"));
      if (hashText(text) !== hash) throw new Error(`Content hash mismatch: ${hash}`);
      texts.set(hash, text);
      this.#access.known.add(hash);
    }
    return new TextEncoder().encode(
      unpackContent(packed, (hash) => {
        const text = texts.get(hash);
        if (text === undefined) throw new Error(`Missing content: ${hash}`);
        return text;
      }),
    );
  }

  async decodeImage(bytes: Uint8Array): Promise<Uint8Array> {
    const updates = readUpdateLog(bytes);
    if (updates === null) return bytes;
    const entries: Uint8Array[] = [];
    for (const update of updates) entries.push(encodeLogEntry(await this.decode(update)));
    return Buffer.concat(entries);
  }

  #path(hash: string): string {
    return join(this.#root, hash.slice(0, 2), hash);
  }

  async #put(hash: string, text: string): Promise<void> {
    if (this.#access.known.has(hash)) return;
    const path = this.#path(hash);
    try {
      const existing = parseContentText(await readFile(path, "utf8"));
      if (hashText(existing) === hash) {
        this.#access.known.add(hash);
        return;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(text));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
      for (const directory of [dirname(path), this.#root, dirname(this.#root)]) {
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
      this.#access.known.add(hash);
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
}
