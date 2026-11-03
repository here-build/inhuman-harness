/** Session tri-state. Not Scheme program ids. */
export const PERMISSION_MODES = ["manual", "auto", "yolo"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: string): value is PermissionMode {
  return value === "manual" || value === "auto" || value === "yolo";
}

/** Unknown / empty / `plan` / `act` / `always-approve` → null. */
export function parsePermissionMode(value: unknown): PermissionMode | null {
  return typeof value === "string" && isPermissionMode(value) ? value : null;
}

/** New sessions take a valid project choice, then the kernel choice, then manual. */
export function sessionMintPermissionMode(kernel: string, project: string): PermissionMode {
  return parsePermissionMode(project) ?? parsePermissionMode(kernel) ?? "manual";
}
