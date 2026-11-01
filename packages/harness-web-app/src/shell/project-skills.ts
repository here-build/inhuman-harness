import { useEffect, useMemo, useState } from "react";

import { useDial } from "../client/context.js";

type SkillRow = {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly invoke: string;
};

/** Fetch metadata only: skill bodies are expanded by the daemon on submit. */
export function useProjectSkills(path: string, enabled: boolean): readonly SkillRow[] {
  const dial = useDial();
  const rpc = dial.kernelRpc;
  // Each slash activation needs a fresh catalog: old canonical mappings can
  // resolve to a different skill after files or plugin commands change.
  const activation = useMemo(() => ({}), [enabled, path, rpc]);
  const [catalog, setCatalog] = useState<{
    readonly activation: object;
    readonly rows: readonly SkillRow[];
  } | null>(null);

  useEffect(() => {
    if (!enabled || rpc == null) return;
    let current = true;
    void rpc.request("skill/list", { project: path }).then(
      (result: unknown) => {
        if (current) setCatalog({ activation, rows: readSkills(result) });
        return undefined;
      },
      () => {
        if (current) setCatalog({ activation, rows: [] });
        return undefined;
      },
    );
    return () => {
      current = false;
    };
  }, [activation, enabled, path, rpc]);

  return enabled && catalog?.activation === activation ? catalog.rows : [];
}

function readSkills(result: unknown): SkillRow[] {
  if (result == null || typeof result !== "object" || !("skills" in result) || !Array.isArray(result.skills)) return [];
  return result.skills.filter((row: unknown): row is SkillRow => {
    if (row == null || typeof row !== "object") return false;
    return (
      "name" in row &&
      typeof row.name === "string" &&
      "description" in row &&
      typeof row.description === "string" &&
      "location" in row &&
      typeof row.location === "string" &&
      "invoke" in row &&
      typeof row.invoke === "string"
    );
  });
}
