import {
  createScopePlane,
  pairId,
  type Cell,
  type Row,
  type RowPlane,
  type ScopePlane,
  type TableName,
} from "@inhuman.tools/scope-plane";
import { createStore, type Store } from "tinybase";
import { createFilePersister, type FilePersister } from "tinybase/persisters/persister-file";

/**
 * Hermetic local plane. One process, one plain store.
 * Another machine uses its own adapter over the same scope API.
 */
export type TinybaseScopeOptions = {
  /** JSON file. Absent keeps the store in memory only. */
  readonly file?: string;
};

export type OpenScopePlane = {
  readonly plane: ScopePlane;
  /** A successful file save is an awaited atomic rename, not an fsync guarantee. */
  flush(): Promise<FlushOutcome>;
  close(): Promise<void>;
};

export type FlushOutcome =
  | { readonly status: "memory" }
  | { readonly status: "file-saved"; readonly file: string }
  | { readonly status: "failed"; readonly error: unknown };

function copyRow(row: { readonly [cell: string]: unknown }): Row {
  const copy: Record<string, Cell> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") copy[key] = value;
  }
  return copy;
}

export function createTinybaseRowPlane(store: Store): RowPlane {
  function write(table: TableName, id: string, row: Row): void {
    store.delRow(table, id);
    store.setRow(table, id, { ...row });
  }

  return {
    async get(table, id) {
      if (!store.hasRow(table, id)) return undefined;
      return copyRow(store.getRow(table, id));
    },
    async list(table, column, equals) {
      const found: { id: string; row: Row }[] = [];
      store.forEachRow(table, (id) => {
        const row = store.getRow(table, id);
        if (row[column] === equals) found.push({ id, row: copyRow(row) });
      });
      return found;
    },
    async put(table, id, row) {
      store.transaction(() => write(table, id, row));
    },
    async remove(table, id) {
      store.delRow(table, id);
    },
    async replaceIf(table, id, column, expected, row) {
      return store.transaction(() => {
        const exists = store.hasRow(table, id);
        if (expected === undefined) {
          if (exists) return false;
          write(table, id, row);
          return true;
        }
        if (!exists || store.getCell(table, id, column) !== expected) return false;
        write(table, id, row);
        return true;
      });
    },
    async insertIfAbsent(table, id, row) {
      return store.transaction(() => {
        if (store.hasRow(table, id)) return false;
        store.setRow(table, id, { ...row });
        return true;
      });
    },
    async replaceIfMatch(table, id, expected, row) {
      return store.transaction(() => {
        if (!store.hasRow(table, id)) return false;
        const current = store.getRow(table, id);
        if (!Object.entries(expected).every(([key, value]) => current[key] === value)) return false;
        write(table, id, row);
        return true;
      });
    },
    async removeIf(table, id, expected) {
      return store.transaction(() => {
        if (!store.hasRow(table, id)) return false;
        const row = store.getRow(table, id);
        for (const [key, value] of Object.entries(expected)) {
          if (row[key] !== value) return false;
        }
        store.delRow(table, id);
        return true;
      });
    },
    watch(table, _match, onChange) {
      const listenerId = store.addTableListener(table, () => {
        onChange();
      });
      return () => {
        store.delListener(listenerId);
      };
    },
    async snapshot(read) {
      const captured = createStore().setTables(store.getTables());
      return read(createTinybaseRowPlane(captured));
    },
    async commitOwned(claim, mutation) {
      return store.transaction(() => {
        const owner = store.getRow("generations", claim.sessionId);
        if (
          claim.holder === "" ||
          owner.scopeId !== claim.scopeId ||
          owner.generation !== claim.generation ||
          owner.holder !== claim.holder
        )
          return false;
        const exists = store.hasRow(mutation.table, mutation.id);
        const current = store.getRow(mutation.table, mutation.id);
        if (exists && !Object.entries(mutation.existing).every(([key, value]) => current[key] === value)) return false;
        if (mutation.row == null) {
          if (!exists) return false;
          store.delRow(mutation.table, mutation.id);
        } else write(mutation.table, mutation.id, mutation.row);
        return true;
      });
    },
  };
}

export async function createTinybaseScopePlane(options?: TinybaseScopeOptions): Promise<OpenScopePlane> {
  const store = createStore();
  let persister: FilePersister | undefined;
  let errors: unknown[] = [];
  if (options?.file != null) {
    persister = createFilePersister(store, options.file, (error: unknown) => {
      errors.push(error);
    });
    await persister.load();
    store.transaction(() => {
      for (const [table, part] of [
        ["kv", "key"],
        ["roster", "name"],
        ["termContinue", "key"],
        ["modelUsage", "key"],
        ["lastUsedModel", "connection"],
      ] as const) {
        store.forEachRow(table, (id) => {
          const scope = store.getCell(table, id, "scopeId");
          const key = store.getCell(table, id, part);
          if (typeof scope !== "string" || typeof key !== "string" || id !== `${scope}\0${key}`) return;
          const next = pairId(scope, key);
          if (!store.hasRow(table, next)) store.setRow(table, next, store.getRow(table, id));
          store.delRow(table, id);
        });
      }
    });
    await persister.startAutoSave();
  }
  let flushTail: Promise<FlushOutcome> = Promise.resolve({ status: "memory" });
  const flush = (): Promise<FlushOutcome> => {
    flushTail = flushTail.then(async () => {
      if (persister == null || options?.file == null) return { status: "memory" };
      errors = [];
      try {
        await persister.save();
        if (errors.length > 0) return { status: "failed", error: errors[0] };
        return { status: "file-saved", file: options.file };
      } catch (error) {
        return { status: "failed", error };
      }
    });
    return flushTail;
  };
  return {
    plane: createScopePlane(createTinybaseRowPlane(store)),
    flush,
    async close() {
      const outcome = await flush();
      await persister?.destroy();
      if (outcome.status === "failed") throw outcome.error;
    },
  };
}
