import { DurableObject } from "cloudflare:workers";

export interface MachineRow {
  machineId: string;
  name: string;
  lastSeen: number;
  online: boolean;
}

/** Per-user registry: allowlist verdict and known machines. Tiny, so SQLite storage is fine. */
export class UserDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL, allowed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS machines (
        machine_id TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen INTEGER NOT NULL, online INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  getProfile(): { email: string; allowed: boolean } | null {
    const row = this.ctx.storage.sql
      .exec<{ email: string; allowed: number }>("SELECT email, allowed FROM profile")
      .toArray()[0] as { email: string; allowed: number } | undefined;
    return row ? { email: row.email, allowed: row.allowed === 1 } : null;
  }

  setProfile(email: string, allowed: boolean): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO profile (id, email, allowed) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email, allowed = excluded.allowed",
      email,
      allowed ? 1 : 0,
    );
  }

  /** Daemon control connect: creates the machine or refreshes its name and last seen. */
  registerMachine(machineId: string, name: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO machines (machine_id, name, last_seen) VALUES (?, ?, ?) ON CONFLICT (machine_id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen",
      machineId,
      name,
      Date.now(),
    );
  }

  /** Reported by MachineDO as the control socket comes and goes. */
  setOnline(machineId: string, online: boolean): void {
    this.ctx.storage.sql.exec(
      "UPDATE machines SET online = ?, last_seen = ? WHERE machine_id = ?",
      online ? 1 : 0,
      Date.now(),
      machineId,
    );
  }

  hasMachine(machineId: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM machines WHERE machine_id = ?", machineId).toArray().length > 0;
  }

  listMachines(): MachineRow[] {
    return this.ctx.storage.sql
      .exec<{ machine_id: string; name: string; last_seen: number; online: number }>(
        "SELECT machine_id, name, last_seen, online FROM machines ORDER BY last_seen DESC",
      )
      .toArray()
      .map((r) => ({ machineId: r.machine_id, name: r.name, lastSeen: r.last_seen, online: r.online === 1 }));
  }
}
