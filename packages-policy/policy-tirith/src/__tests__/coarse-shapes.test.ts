import { describe, expect, it } from "vitest";

import { tirithClass, tirithDisposition, tirithFailure, type TirithReport } from "../tirith.js";

const finding = (rule_id: string) => ({
  rule_id,
  severity: "HIGH" as const,
  title: rule_id,
  description: rule_id,
});
const blocked = (...ids: string[]): TirithReport => ({ action: "block", findings: ids.map(finding) });

describe("coarse shapes are soft-deny", () => {
  it.each(["private_network_access", "shortened_url"])("%s alone is deny", (id) => {
    expect(tirithDisposition(blocked(id))).toBe("deny");
    expect(tirithClass(blocked(id))).toBe("attack-shape");
  });
  it("a precise shape next to a coarse one stays block", () => {
    expect(tirithDisposition(blocked("shortened_url", "curl_pipe_shell"))).toBe("block");
    expect(tirithDisposition(blocked("metadata_endpoint"))).toBe("block");
    expect(tirithDisposition(blocked("reverse_shell"))).toBe("block");
  });
  it("a scanner error is a policy fault and stays block", () => {
    const report = tirithFailure(new Error("ENOENT"));
    expect(tirithDisposition(report)).toBe("block");
    expect(tirithClass(report)).toBe("policy-fault");
  });
});
