import type { ConnectionSpec } from "@inhuman.tools/expectations";

export type ClassifierRouteOpts = {
  /** Kernel last-choice. Session mint is a snapshot; this overlay is live. */
  readonly fallback?: Readonly<Record<string, string>>;
  /** Connection `settings.model` when the judge wire is named but `judgeModel` is empty. */
  readonly configuredModel?: (connectionId: string) => string;
};

export function classifierRoute(
  kvs: Readonly<Record<string, string>>,
  opts?: ClassifierRouteOpts,
): {
  readonly connection: string;
  readonly model: string;
  readonly key: string;
} {
  const fallback = opts?.fallback ?? {};
  const connection = (kvs.judgeConnection || fallback.judgeConnection || kvs.connection || "").trim();
  const judgeModel = (kvs.judgeModel || fallback.judgeModel || "").trim();
  const configured = connection !== "" && opts?.configuredModel != null ? opts.configuredModel(connection).trim() : "";
  const model = (judgeModel || configured || kvs.model || "").trim();
  return { connection, model, key: `${connection}\n${model}` };
}
export function configuredCompletionModel(
  connectionId: string,
  session: Readonly<Record<string, string>>,
  kernel: Readonly<Record<string, string>>,
  spec: ConnectionSpec | undefined,
): string {
  if (spec == null) return "";
  const configured = typeof spec.configuration.model === "string" ? spec.configuration.model.trim() : "";
  if (configured !== "") return configured;
  const activeConnection = (session.connection || kernel.connection || "").trim();
  if (connectionId === activeConnection) {
    const activeModel = (session.model || kernel.model || "").trim();
    if (activeModel !== "") return activeModel;
  }
  return spec.live.models?.find((id) => id.trim() !== "")?.trim() ?? "";
}
