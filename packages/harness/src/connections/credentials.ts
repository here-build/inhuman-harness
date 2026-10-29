/**
 * Process-local credentials view. Durable storage stays with the runtime
 * host; this package never keeps a second secrets table.
 */
import type { ConnectionSecretsView } from "@inhuman.tools/plexus-expectations/driver";

export type ConnectionSecrets = Readonly<Record<string, string>>;

export type CredentialsStore = {
  read(connectionId: string): ConnectionSecrets;
  write?(connectionId: string, secrets: ConnectionSecrets): void;
};

export function secretsView(store: CredentialsStore, connectionId: string): ConnectionSecretsView {
  const write = store.write;
  return {
    get: (field: string) => store.read(connectionId)[field],
    all: () => store.read(connectionId),
    replace:
      write == null
        ? undefined
        : (secrets: ConnectionSecrets) => {
            write(connectionId, { ...secrets });
          },
  };
}

export function memoryCredentialsStore(initial: Record<string, Record<string, string>> = {}): CredentialsStore {
  const bags = new Map<string, Record<string, string>>();
  for (const [id, secrets] of Object.entries(initial)) {
    bags.set(id, { ...secrets });
  }
  return {
    read(connectionId: string): ConnectionSecrets {
      return bags.get(connectionId) ?? {};
    },
    write(connectionId: string, secrets: ConnectionSecrets): void {
      const next = { ...secrets };
      if (Object.keys(next).length === 0) bags.delete(connectionId);
      else bags.set(connectionId, next);
    },
  };
}
