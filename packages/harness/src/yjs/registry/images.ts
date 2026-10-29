/**
 * Read side of the F2 image layout `{root}/documents/{kind}/{sha256(id)}.yjs`.
 * The writer lives in storage; inventory only lists and reads.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DocumentKind } from "@/protocol/document";

const IMAGE_FILE = /^[0-9a-f]{64}\.yjs$/;

export type ImageSource = {
  readonly root: string;
  list(kind: DocumentKind): Promise<readonly string[]>;
  read(storagePath: string): Promise<Uint8Array | null>;
};

function isImageFileName(name: string): boolean {
  return IMAGE_FILE.test(name);
}

export function createFsImageSource(root: string): ImageSource {
  return {
    root,
    async list(kind) {
      const dir = join(root, "documents", kind);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (isEnoent(error)) return [];
        throw error;
      }
      return names.filter((name) => isImageFileName(name)).map((name) => join(dir, name));
    },
    async read(storagePath) {
      try {
        return await readFile(storagePath);
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },
  };
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
