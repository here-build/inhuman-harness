import { fileURLToPath } from "node:url";

import {
  clearDoorRecord,
  DOOR_MISSES_TO_LEAVE,
  DOOR_PROBE_MS,
  doorLogPath,
  doorRecordPath,
  liveDoor,
  parseDoorRecord,
  pidAlive,
  readDoorRecord,
  realProbe,
  startDoorProcess,
  writeDoorRecord,
  type DoorProbe,
  type DoorRecord,
} from "@inhuman.tools/harness";

export {
  clearDoorRecord,
  DOOR_MISSES_TO_LEAVE,
  DOOR_PROBE_MS,
  doorLogPath,
  doorRecordPath,
  liveDoor,
  parseDoorRecord,
  pidAlive,
  readDoorRecord,
  realProbe,
  writeDoorRecord,
  type DoorProbe,
  type DoorRecord,
};

/** Spawn `inhuman web-door` detached and wait until it has recorded itself and answers. */
export function startDoor(kernel: string, port: number): Promise<DoorRecord> {
  const entry = fileURLToPath(new URL("../bin.js", import.meta.url));
  return startDoorProcess(entry, kernel, port);
}
