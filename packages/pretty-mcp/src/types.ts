export type ToolArg = {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
};

export type JsonSchema = Record<string, unknown>;

export type CalibratedTool = {
  readonly name: string;
  readonly description: string;
  readonly args: readonly ToolArg[];
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
};

export type CatalogTool = {
  readonly description: string;
  readonly opts: JsonSchema;
  readonly question: string | null;
  readonly effect: string | null;
  readonly result: {
    readonly schema: JsonSchema | null;
    readonly serializer: string | null;
  };
  readonly stale?: true;
};

export type CalibratedServer = {
  readonly id: string;
  readonly displayName: string;
  readonly source: "toolkit" | "official-docs" | "smithery";
  readonly description: string;
  readonly useCount?: number;
  readonly verified?: boolean;
  readonly tools: readonly CalibratedTool[];
};

export type CatalogFile = {
  readonly id: string;
  readonly displayName: string;
  readonly source: CalibratedServer["source"];
  readonly description: string;
  readonly tools: Record<string, CatalogTool>;
};

export type UncoveredTool = {
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly opts: JsonSchema;
};

/** Identity is covered; result serializer is still empty. */
export type UncoveredSerializer = {
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly schema: JsonSchema | null;
};

export type SmitheryDetail = {
  readonly qualifiedName: string;
  readonly displayName?: string;
  readonly description: string;
  readonly useCount: number;
  readonly verified: boolean;
  readonly toolCount: number;
  readonly tools: readonly CalibratedTool[];
};

export type Calibration = {
  readonly asOf: string;
  readonly purpose: string;
  readonly cut: {
    readonly toolkit: string;
    readonly official: string;
    readonly smithery: string;
  };
  readonly counts: {
    readonly servers: number;
    readonly tools: number;
    readonly smitheryAdmitted: number;
    readonly megaSkipped: number;
  };
  readonly argNames: Readonly<Record<string, number>>;
  readonly servers: readonly CalibratedServer[];
};

export type RetrieveOptions = {
  readonly fetch: boolean;
  readonly cachePath: string;
  readonly outPath: string;
  readonly docsDir?: string;
};
