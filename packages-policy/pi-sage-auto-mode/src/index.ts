/** `JEV_API_KEY` is not a Pi provider env. The secret file is not `auth.json`. */
import path from "node:path";

import { sageDecideCapability } from "@inhuman.tools/env-capability-decision-sage";
import {
  type BackendBinding,
  type PiCtx,
  type PiHost,
  register as registerGate,
  type RegisterOptions,
  type Seat,
} from "@inhuman.tools/policy-pi";

export const SAGE_SECRET = "policy-pi-sage-api-key";

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function secretFile(agentDir: string): string {
  return path.join(agentDir, "secrets", SAGE_SECRET);
}

function resolved(seat: Seat): { readonly key: string; readonly source: "env" | "file" } | undefined {
  const fromEnv = present(seat.env.SAGE_API_KEY);
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
      return { kind: "capability", capability: sageDecideCapability, config: { apiKey: key.key } };
    },
    status(seat) {
      const key = resolved(seat);
      return key === undefined ? "no sage key" : `sage key from ${key.source}`;
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
            const entered = await ctx.ui.input("Sage API key");
            const key = entered?.trim();
            if (key === undefined || key === "") {
              ctx.ui.notify("no key stored", "warning");
            } else {
              seat.files.write(secretFile(seat.agentDir), `${key}\n`);
              ctx.ui.notify("sage key stored", "info");
            }
          }
          return true;
        case "logout":
          seat.files.remove(secretFile(seat.agentDir));
          if (ctx.hasUI) {
            ctx.ui.notify("sage key removed", "info");
          }
          return true;
        default:
          return false;
      }
    },
  });
}

export default register;
