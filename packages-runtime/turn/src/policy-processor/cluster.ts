/**
 * Classifier-lambda payload. Cluster table and args parse live in
 * harness-model. This module keeps the unknown[] shape the remainder
 * ports apply.
 */
import { clusterOf, fileQuestion } from "@inhuman.tools/harness-model";

/**
 * Strings the agent controls are JSON-encoded here: the judge prompt places them in a
 * labelled "untrusted" block, and encoding keeps a newline-and-label from forging a new section.
 */
/** Arguments for the matching `classifier/*` lambda, or undefined if the payload is missing. */
export function classifierArgs(name: string, args: Readonly<Record<string, unknown>> | null): unknown[] | undefined {
  switch (clusterOf(name)) {
    case "bash": {
      if (typeof args?.command !== "string" || args.command === "") return undefined;
      const cwd = typeof args.cwd === "string" && args.cwd !== "" && args.cwd !== "." ? args.cwd : undefined;
      return cwd === undefined
        ? [JSON.stringify(args.command)]
        : [JSON.stringify(args.command), `cwd ${JSON.stringify(cwd)}`];
    }
    case "read":
      return [JSON.stringify(fileQuestion(name, args) ?? ".")];
    case "write": {
      const question = fileQuestion(name, args);
      return question == null ? undefined : [JSON.stringify(question)];
    }
    case "mcp":
      return [JSON.stringify(name), JSON.stringify(args ?? {})];
  }
}
