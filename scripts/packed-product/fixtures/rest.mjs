export const barrelForbidden = ["@inhuman.tools/harness-provider-", "@inhuman.tools/harness-hypervisor", "@/hypervisor"];
export const barrels = ["packages/harness-sdk/src/index.ts"];
// Packages allowed to reach the core's test door. The TUI and the CLI import it from their tests only.
export const compositionPackages = [
  "@inhuman.tools/harness-server",
  "@inhuman.tools/harness",
  "@inhuman.tools/harness-tui",
  "inhuman",
];

export const modelPackage = "@inhuman.tools/harness-model";
export const modelRange = "workspace:^";
export const internSymbol = "const internByKernel";
export const internFile = "packages/plexus-expectations/src/executor/kernel-intern.ts";
export const connectionsIntern = "packages/harness/src/connections/intern.ts";
export const connectionsImport = /from "@inhuman\.tools\/plexus-expectations\/executor"/;

export const cli = {
  packageName: "inhuman",
  binName: "inhuman",
  binPath: "./bin/inhuman.mjs",
  filesInclude: ["bin", "dist"],
  packedIncludes: ["bin/inhuman.mjs"],
  packMissing: "CLI pack missing bin/inhuman.mjs",
};

export const hypervisor = {
  packageName: "@inhuman.tools/harness-hypervisor",
  filesInclude: ["dist"],
  exportPaths: ["."],
};

export const openai = {
  packageName: "@inhuman.tools/harness-provider-openai-compat",
  exportPaths: ["./register"],
};
