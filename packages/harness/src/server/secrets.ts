/**
 * Process-local connection secrets. Never a Plexus field, never config.json.
 * Owner-only file next to the kernel root.
 */
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

import fs from "fs-extra";

import { asRecord } from "./util/read-field.js";

export type ConnectionSecrets = Record<string, string>;

type SecretsFile = {
  connections: Record<string, ConnectionSecrets>;
};

export function secretsPath(root: string): string {
  return join(root, "secrets.json");
}

export function readConnectionSecrets(root: string, id: string): ConnectionSecrets {
  return readSecretsFile(root).connections[id] ?? {};
}

export function writeConnectionSecrets(root: string, id: string, secrets: ConnectionSecrets): void {
  const file = readSecretsFile(root);
  if (Object.keys(secrets).length === 0) {
    delete file.connections[id];
  } else {
    file.connections[id] = secrets;
  }
  persistSecretsFile(root, file);
}

export function deleteConnectionSecrets(root: string, id: string): void {
  const file = readSecretsFile(root);
  if (!(id in file.connections)) return;
  delete file.connections[id];
  persistSecretsFile(root, file);
}

function readSecretsFile(root: string): SecretsFile {
  const path = secretsPath(root);
  if (!existsSync(path)) return { connections: {} };
  try {
    const raw: unknown = fs.readJsonSync(path);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { connections: {} };
    const rec = asRecord(raw);
    if (rec == null) return { connections: {} };
    const listed = asRecord(rec.connections);
    if (listed == null) return { connections: {} };
    const connections: Record<string, ConnectionSecrets> = {};
    for (const [id, value] of Object.entries(listed)) {
      const fields = asRecord(value);
      if (fields == null) continue;
      const bag: ConnectionSecrets = {};
      for (const [key, field] of Object.entries(fields)) {
        if (typeof field === "string" && field.length > 0) bag[key] = field;
      }
      if (Object.keys(bag).length > 0) connections[id] = bag;
    }
    return { connections };
  } catch {
    return { connections: {} };
  }
}

function persistSecretsFile(root: string, file: SecretsFile): void {
  const path = secretsPath(root);
  if (Object.keys(file.connections).length === 0) {
    if (existsSync(path)) fs.removeSync(path);
    return;
  }
  fs.writeJsonSync(path, file, { spaces: 2 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
}
