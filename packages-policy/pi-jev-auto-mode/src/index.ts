/** Reads `TYPESAFE_API_KEY`, then `JEV_API_KEY` (as the sibling Jev adapters do). The secret file is not `auth.json`. */
import path from "node:path";

import { jevDecideCapability } from "@inhuman.tools/env-capability-decision-jev";
import {
  type BackendBinding,
  type PiCtx,
  type PiHost,
  register as registerGate,
  type RegisterOptions,
  type Seat,
} from "@inhuman.tools/policy-pi";

export const TYPESAFE_SECRET = "policy-pi-typesafe-api-key";

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function secretFile(agentDir: string): string {
  return path.join(agentDir, "secrets", TYPESAFE_SECRET);
}

function resolved(seat: Seat): { readonly key: string; readonly source: "env" | "file" } | undefined {
  const fromEnv = present(seat.env.TYPESAFE_API_KEY) ?? present(seat.env.JEV_API_KEY);
  if (fromEnv !== undefined) return { key: fromEnv, source: "env" };
  const fromFile = present(seat.files.read(secretFile(seat.agentDir)));
  if (fromFile !== undefined) return { key: fromFile, source: "file" };
  return undefined;
}

export function register(pi: PiHost, options?: RegisterOptions): void {
  registerGate(pi, options, {
    usage: "usage: status | login | logout | program edit|clear",
    bind(seat: Seat): BackendBinding {
      const key = resolved(seat);
      if (key === undefined) return { kind: "deny" };
      return { kind: "capability", capability: jevDecideCapability, config: { apiKey: key.key } };
    },
    status(seat) {
      const key = resolved(seat);
      return key === undefined ? "no typesafe key" : `typesafe key from ${key.source}`;
    },
    warnUnconfigured(seat) {
      return resolved(seat) === undefined;
    },
    async command(args: string, ctx: PiCtx, seat: Seat): Promise<boolean> {
      const words = args
        .trim()
        .split(/\s+/)
        .filter((word) => word !== "");
      if (words.length !== 1) {
        return false;
      }
      switch (words[0]) {
        case "login":
          if (ctx.hasUI) {
            const entered = await ctx.ui.input("TypeSafe API key");
            const key = entered?.trim();
            if (key === undefined || key === "") {
              ctx.ui.notify("no key stored", "warning");
            } else {
              seat.files.write(secretFile(seat.agentDir), `${key}\n`);
              ctx.ui.notify("typesafe key stored", "info");
            }
          }
          return true;
        case "logout":
          seat.files.remove(secretFile(seat.agentDir));
          if (ctx.hasUI) {
            ctx.ui.notify("typesafe key removed", "info");
          }
          return true;
        default:
          return false;
      }
    },
  });
}

export default register;
