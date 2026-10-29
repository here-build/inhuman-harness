import type { Disposition } from "./types.js";

/** Match-all / pipeline lattice: any-block > any-deny > any-ask > all-approve. */
export function lattice(hits: readonly Disposition[]): Disposition {
  switch (true) {
    case hits.includes("block"):
      return "block";
    case hits.includes("deny"):
      return "deny";
    case hits.includes("ask"):
      return "ask";
    default:
      return "policyApprove";
  }
}
