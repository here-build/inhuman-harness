/**
 * Rule classes: why the floor voted the tier it did. The taxonomy is closed and ships with the
 * harness. A user layer may tag its own rules with one of these ids and configure how each class
 * resolves; it cannot add an id or move a rule between classes.
 *
 * `risky` / `general` are not classes and not tier names. The tier names are "soft-deny"
 * (engine `deny`) and "ask" (engine `ask`).
 */

export const CLASS_IDS = [
  "destroy-catastrophic",
  "destroy-local",
  "vcs-history",
  "privilege",
  "credential",
  "control-plane",
  "attack-shape",
  "policy-fault",
  "package-install",
  "publish",
  "remote-write",
  "network-egress",
  "exec-unknown",
  "unmodelled",
  "envelope-read",
  "envelope-write",
  "protected-file",
  "workspace-write",
  "mcp-lookup",
  "mcp-action",
] as const;

export type ClassId = (typeof CLASS_IDS)[number];

export type ClassInfo = {
  /** Short name for prompts and the permissions view. */
  readonly label: string;
  /** Trusted, harness-written description. The soft-deny judge reads it as FLOOR context. */
  readonly description: string;
  /** UI warning colour only. It has no resolution meaning. */
  readonly risky: boolean;
};

export const CLASSES: Readonly<Record<ClassId, ClassInfo>> = {
  "destroy-catastrophic": {
    label: "Destroys the machine or home",
    description: "Irrecoverable machine or home-scale destruction.",
    risky: true,
  },
  "destroy-local": {
    label: "Discards local work",
    description: "Discards uncommitted or untracked work in the tree.",
    risky: true,
  },
  "vcs-history": {
    label: "Rewrites history",
    description: "Rewrites or deletes refs and history, local or remote.",
    risky: true,
  },
  privilege: {
    label: "Elevates privilege",
    description: "Elevates privilege, widens permissions, or changes machine state.",
    risky: true,
  },
  credential: {
    label: "Touches credentials",
    description: "Reads, writes or exports secrets and credential stores.",
    risky: true,
  },
  "control-plane": {
    label: "Changes the controls on the agent",
    description:
      "Changes or bypasses the controls that govern the agent: harness or agent config, VCS hooks, hook bypass, CI workflows, policy files.",
    risky: true,
  },
  "attack-shape": {
    label: "Known attack shape",
    description: "A known attack pattern: pipe-to-shell, reverse shell, exfiltration, suspicious network target.",
    risky: true,
  },
  "policy-fault": {
    label: "Policy fault",
    description: "The gate itself failed: the policy did not compile, the check threw, or the scanner errored.",
    risky: true,
  },
  "package-install": {
    label: "Installs packages",
    description: "Installs or removes packages, or runs foreign install scripts.",
    risky: false,
  },
  publish: {
    label: "Publishes",
    description: "Publishes an artifact or content to a public or shared registry.",
    risky: true,
  },
  "remote-write": {
    label: "Changes remote state",
    description: "Mutates remote state other than publishing: push, PR or issue edits, kubectl, a remote docker host.",
    risky: true,
  },
  "network-egress": {
    label: "Uses the network",
    description: "Sends or fetches data over the network.",
    risky: false,
  },
  "exec-unknown": {
    label: "Runs code the floor cannot see",
    description:
      "Runs code whose effect the floor cannot see: unknown programs, interpreters, scripts, build tasks, eval, env-prefix, xargs, non-literal arguments.",
    risky: false,
  },
  unmodelled: {
    label: "Not precisely modelled",
    description: "A known program whose verb or option the floor does not model precisely.",
    risky: false,
  },
  "envelope-read": {
    label: "Reads outside the workspace",
    description: "Reads a path outside the enabled roots.",
    risky: false,
  },
  "envelope-write": {
    label: "Writes outside the workspace",
    description: "Writes outside the enabled roots, or to an untyped output path.",
    risky: true,
  },
  "protected-file": {
    label: "Writes a protected file",
    description: "Writes an in-tree file the policy carves out (manifests, lockfiles, Makefile).",
    risky: false,
  },
  "workspace-write": {
    label: "Writes in the workspace",
    description: "Ordinary in-tree or scratch write.",
    risky: false,
  },
  "mcp-lookup": {
    label: "MCP look-up",
    description: "An MCP tool whose name scores as a look-up.",
    risky: false,
  },
  "mcp-action": {
    label: "MCP action",
    description: "Any other MCP or unknown tool.",
    risky: false,
  },
};

const IDS: ReadonlySet<string> = new Set(CLASS_IDS);

export function isClassId(value: unknown): value is ClassId {
  return typeof value === "string" && IDS.has(value);
}

/** Tier names as users write them. The engine names stay `deny` / `ask`. */
export const TIER_NAMES = ["soft-deny", "ask"] as const;
