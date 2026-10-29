/**
 * The web door: a detached `harness web-door` process that serves the built client on loopback and
 * proxies rooms to the daemon socket. `harness open` starts one when none is live and leaves it running.
 * The door records itself in `<kernel>/web.json`, logs to `<kernel>/web.log`, and leaves when the
 * daemon has been gone for a few probes, so nothing is left behind after `harness daemon stop`.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type DoorRecord = { readonly pid: number; readonly port: number; readonly url: string };

export const DOOR_PROBE_MS = 2000;
export const DOOR_MISSES_TO_LEAVE = 3;

export function doorRecordPath(kernel: string): string {
  return join(kernel, "web.json");
}

export function doorLogPath(kernel: string): string {
  return join(kernel, "web.log");
}

export function parseDoorRecord(text: string): DoorRecord | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const { pid, port, url } = value as Record<string, unknown>;
    if (typeof pid !== "number" || typeof port !== "number" || typeof url !== "string") return undefined;
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return { pid, port, url };
  } catch {
    return undefined;
  }
}

export async function readDoorRecord(kernel: string): Promise<DoorRecord | undefined> {
  try {
    return parseDoorRecord(await readFile(doorRecordPath(kernel), "utf8"));
  } catch {
    return undefined;
  }
}

export async function writeDoorRecord(kernel: string, record: DoorRecord): Promise<void> {
  await writeFile(doorRecordPath(kernel), `${JSON.stringify(record)}\n`);
}

/** Remove the record only if it is still ours: a newer door may have replaced it. */
export async function clearDoorRecord(kernel: string, pid: number): Promise<void> {
  const current = await readDoorRecord(kernel);
  if (current?.pid === pid) await rm(doorRecordPath(kernel), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type DoorProbe = {
  readonly alive: (pid: number) => boolean;
  readonly answers: (url: string) => Promise<boolean>;
};

export const realProbe: DoorProbe = {
  alive: pidAlive,
  answers: async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  },
};

/** The recorded door when its process is alive and its URL answers; otherwise undefined. */
export async function liveDoor(kernel: string, probe: DoorProbe = realProbe): Promise<DoorRecord | undefined> {
  const record = await readDoorRecord(kernel);
  if (record === undefined || !probe.alive(record.pid)) return undefined;
  return (await probe.answers(record.url)) ? record : undefined;
}

const START_TIMEOUT_MS = 15_000;

/** Spawn `harness web-door` detached and wait until it has recorded itself and answers. */
export async function startDoor(kernel: string, port: number): Promise<DoorRecord> {
  const entry = fileURLToPath(new URL("../bin.js", import.meta.url));
  const log = openSync(doorLogPath(kernel), "a");
  let exited: number | null = null;
  let child;
  try {
    child = spawn(process.execPath, [entry, "web-door", "--kernel", kernel, "--port", String(port)], {
      detached: true,
      stdio: ["ignore", log, log],
    });
  } finally {
    closeSync(log);
  }
  child.once("exit", (code) => {
    exited = code ?? 1;
  });
  child.once("error", () => {
    exited = 1;
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`web door exited ${exited} before it listened (see ${doorLogPath(kernel)})`);
    const record = await readDoorRecord(kernel);
    if (record !== undefined && record.pid === child.pid && (await realProbe.answers(record.url))) return record;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`web door did not come up in time (see ${doorLogPath(kernel)})`);
}
