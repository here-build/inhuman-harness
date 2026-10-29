/**
 * Judge env: evidence cuts and sections, the call's floor verdict, and the sinks the host applies.
 *
 * `classifier/*` are sinks for the ask judge: they bind a scheme lambda. The host applies the
 * matching one with the cluster payload (compact's applyCallback). Retrieval is the remainder
 * program, not inlined in each lambda. The ask judge votes `risk` and `authorization`; the
 * program allows only when authorization (plus `risk-margin`) reaches risk.
 *
 * `soft-deny/*` are sinks for the soft-deny judge ("did the user request this exactly?"). The host
 * applies one with the round number (1, then 2 with the agent's last answer). Every section it
 * reads is one line of JSON the host built, so agent text can never forge a label.
 *
 * `bypass/judge` is the sink of the unattended-run bypass check.
 */
import { EnvCapability } from "@here.build/arrival";
import { applyCallback, getCapabilityResources } from "@here.build/arrival/host-internals";
import { ErrorWithInvariant } from "@inhuman.tools/error-with-invariant";
import { z } from "zod";

type Cluster = "bash" | "read" | "write" | "mcp";

class ProcessorError extends ErrorWithInvariant {
  override readonly name = "ProcessorError";
}

type ClassifierFn = Parameters<typeof applyCallback>[0];

export type ClassifierResources = {
  bash: ClassifierFn | undefined;
  read: ClassifierFn | undefined;
  write: ClassifierFn | undefined;
  mcp: ClassifierFn | undefined;
  softDeny: Record<Cluster, ClassifierFn | undefined>;
  bypass: ClassifierFn | undefined;
};

function bind(cluster: Cluster) {
  return function (this: { resources: ClassifierResources }, fn: ClassifierFn) {
    this.resources[cluster] = fn;
    return undefined;
  };
}

function bindSoftDeny(cluster: Cluster) {
  return function (this: { resources: ClassifierResources }, fn: ClassifierFn) {
    this.resources.softDeny[cluster] = fn;
    return undefined;
  };
}

export const processorCapability = EnvCapability.define("policy/classifier", {
  configuration: {
    privileged: z.string().default(""),
    priorTurn: z.string().default(""),
    quarantined: z.string().default(""),
    policy: z.string().default(""),
    /** Ask judge: allow needs `authorization + riskMargin >= risk`. */
    riskMargin: z.number().default(0),
    floorJson: z.string().default(""),
    userJson: z.string().default("[]"),
    callJson: z.string().default(""),
    agentAnswerJson: z.string().default(""),
    callTier: z.string().default(""),
    callClasses: z.string().default(""),
    callRules: z.string().default(""),
    taskJson: z.string().default(""),
    restrictionsJson: z.string().default(""),
    callsJson: z.string().default(""),
    hintsJson: z.string().default(""),
    notesJson: z.string().default(""),
  },
  resources: (): ClassifierResources => ({
    bash: undefined,
    read: undefined,
    write: undefined,
    mcp: undefined,
    softDeny: { bash: undefined, read: undefined, write: undefined, mcp: undefined },
    bypass: undefined,
  }),
  symbols: (symbol, sz) => ({
    "risk-margin": symbol.rosetta`risk-margin: how far authorization may trail risk and still allow (0 by default)`(
      { input: [], output: [sz.number], provenance: "source" },
      function () {
        return this.configuration.riskMargin;
      },
    ),
    evidence: symbol.rosetta`evidence: named PIP cut or host-built section of the judge request`(
      { input: [sz.foldName], output: [sz.string], provenance: "source" },
      function (name) {
        switch (name) {
          case "privileged":
            return this.configuration.privileged;
          case "prior-turn":
            return this.configuration.priorTurn;
          case "quarantined":
            return this.configuration.quarantined;
          case "policy":
            return this.configuration.policy;
          case "floor-json":
            return this.configuration.floorJson;
          case "user-json":
            return this.configuration.userJson;
          case "call-json":
            return this.configuration.callJson;
          case "agent-answer-json":
            return this.configuration.agentAnswerJson;
          case "task-json":
            return this.configuration.taskJson;
          case "restrictions-json":
            return this.configuration.restrictionsJson;
          case "calls-json":
            return this.configuration.callsJson;
          case "hints-json":
            return this.configuration.hintsJson;
          case "notes-json":
            return this.configuration.notesJson;
          default:
            throw new ProcessorError(`evidence: unknown cut ${name}`);
        }
      },
    ),
    call: symbol.rosetta`call: the floor verdict of the call being judged (tier, classes, rules)`(
      { input: [sz.foldName], output: [sz.string], provenance: "source" },
      function (name) {
        switch (name) {
          case "tier":
            return this.configuration.callTier;
          case "classes":
            return this.configuration.callClasses;
          case "rules":
            return this.configuration.callRules;
          default:
            throw new ProcessorError(`call: unknown field ${name}`);
        }
      },
    ),
    "classifier/bash": symbol.rosetta`classifier/bash: remainder classifier for the shell cluster`(
      { input: [sz.lambda], output: [sz.undefinedResult], provenance: "sink" },
      bind("bash"),
    ),
    "classifier/read": symbol.rosetta`classifier/read: remainder classifier for the read cluster`(
      { input: [sz.lambda], output: [sz.undefinedResult], provenance: "sink" },
      bind("read"),
    ),
    "classifier/write": symbol.rosetta`classifier/write: remainder classifier for the write cluster`(
      { input: [sz.lambda], output: [sz.undefinedResult], provenance: "sink" },
      bind("write"),
    ),
    "classifier/mcp": symbol.rosetta`classifier/mcp: remainder classifier for MCP and unknown tools`(
      { input: [sz.lambda], output: [sz.undefinedResult], provenance: "sink" },
      bind("mcp"),
    ),
    "soft-deny/bash": symbol.rosetta`soft-deny/bash: soft-deny judge for the shell cluster; applied with the round`(
      { input: [sz.lambda], output: [sz.undefinedResult], provenance: "sink" },
      bindSoftDeny("bash"),
    ),
    "soft-deny/read": symbol.rosetta`soft-deny/read: soft-deny judge for the read cluster; applied with the round`(
      { input: [sz.lambda], output: [sz.undefinedResult], provenance: "sink" },
      bindSoftDeny("read"),
    ),
    "soft-deny/write": symbol.rosetta`soft-deny/write: soft-deny judge for the write cluster; applied with the round`(
      { input: [sz.lambda], output: [sz.undefinedResult], provenance: "sink" },
      bindSoftDeny("write"),
    ),
    "soft-deny/mcp": symbol.rosetta`soft-deny/mcp: soft-deny judge for MCP and unknown tools; applied with the round`(
      { input: [sz.lambda], output: [sz.undefinedResult], provenance: "sink" },
      bindSoftDeny("mcp"),
    ),
    "bypass/judge":
      symbol.rosetta`bypass/judge: does this series of calls look like an attempt to bypass a restriction`(
        { input: [sz.lambda], output: [sz.undefinedResult], provenance: "sink" },
        function (this: { resources: ClassifierResources }, fn: ClassifierFn) {
          this.resources.bypass = fn;
          return undefined;
        },
      ),
  }),
});

/** Same env as `processorCapability`. Prefer this name in-tree. */
export const policyEnvCapability = processorCapability;

export function classifierResources(runCtx: Parameters<typeof getCapabilityResources>[0]): ClassifierResources {
  const bag = getCapabilityResources(runCtx, policyEnvCapability) as ClassifierResources | undefined;
  ProcessorError.invariant(bag !== undefined, "classifier resources missing");
  return bag;
}
