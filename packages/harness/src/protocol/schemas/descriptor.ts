import { z } from "zod";

import type { ReadinessKind } from "./health.js";

/** Servers the hypervisor launches. Hypervisor itself is not a descriptor. */
export const serverRoleSchema = z.enum(["yjs", "runtime"]);
export type ServerRole = z.infer<typeof serverRoleSchema>;

const yjsReadiness = ["sync", "storage"] as const satisfies readonly ReadinessKind[];
const runtimeReadiness = ["execution"] as const satisfies readonly ReadinessKind[];

/** Readiness kinds a role publishes. Socket bind is not a kind. */
export function publishedReadiness(role: ServerRole): readonly ReadinessKind[] {
  return role === "yjs" ? yjsReadiness : runtimeReadiness;
}

export const restartPolicySchema = z
  .object({
    mode: z.enum(["never", "on-failure", "always"]),
    maxAttempts: z.number().int().nonnegative(),
    backoffMs: z.number().int().nonnegative(),
  })
  .strict();
export type RestartPolicy = z.infer<typeof restartPolicySchema>;

/**
 * Launch data only: path and argv, not an import of a server implementation.
 * `requires` names other descriptor ids whose published readiness must hold
 * before this process is admitted.
 */
export const serverDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    role: serverRoleSchema,
    executable: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    requires: z.array(z.string().trim().min(1)).default([]),
    restart: restartPolicySchema,
  })
  .strict();
export type ServerDescriptor = z.infer<typeof serverDescriptorSchema>;

export const serverRosterSchema = z
  .object({
    servers: z.array(serverDescriptorSchema).min(1),
  })
  .strict()
  .superRefine((roster, ctx) => {
    const ids = new Set<string>();
    for (const [index, server] of roster.servers.entries()) {
      if (ids.has(server.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate descriptor id ${server.id}`,
          path: ["servers", index, "id"],
        });
      }
      ids.add(server.id);
    }
    for (const [index, server] of roster.servers.entries()) {
      for (const [reqIndex, required] of server.requires.entries()) {
        if (!ids.has(required)) {
          ctx.addIssue({
            code: "custom",
            message: `unknown readiness dependency ${required}`,
            path: ["servers", index, "requires", reqIndex],
          });
        }
      }
    }
    const byId = new Map(roster.servers.map((server) => [server.id, server]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visited.has(id)) return false;
      if (visiting.has(id)) return true;
      visiting.add(id);
      const server = byId.get(id);
      if (server) {
        for (const required of server.requires) {
          if (visit(required)) return true;
        }
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    for (const [index, server] of roster.servers.entries()) {
      if (visit(server.id)) {
        ctx.addIssue({
          code: "custom",
          message: `readiness dependency cycle at ${server.id}`,
          path: ["servers", index, "requires"],
        });
      }
    }
  });
export type ServerRoster = z.infer<typeof serverRosterSchema>;
