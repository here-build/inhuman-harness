import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.values(value).every(isJsonValue)
  );
}

/** Validate without rewriting object keys or Unicode escape sequences. */
export const jsonValueSchema = z.custom<JsonValue>(isJsonValue);

function recordOf<T>(entry: z.ZodType<T>): z.ZodType<Record<string, T>> {
  return z.custom<Record<string, T>>(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((item: unknown) => entry.safeParse(item).success),
  );
}

export function parseContentText(json: string): string {
  return z.string().parse(JSON.parse(json));
}

const contentRefSchema = z.object({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const packedContentSchema = z.object({
  format: z.literal("content-v1"),
  revision: z.number().optional(),
  value: jsonValueSchema,
  texts: z.array(contentRefSchema),
});

export type PackedContent = z.infer<typeof packedContentSchema>;

/** String bodies are immutable resources; paths distinguish references from literal user objects. */
export function packContent(
  json: string,
  hash: (text: string) => string,
): {
  readonly packed: PackedContent;
  readonly texts: ReadonlyMap<string, string>;
} {
  const value = jsonValueSchema.parse(JSON.parse(json));
  const texts = new Map<string, string>();
  const references: PackedContent["texts"] = [];
  const visit = (item: JsonValue, path: Array<string | number>): JsonValue => {
    if (typeof item === "string" && item.length >= 64) {
      const id = hash(item);
      texts.set(id, item);
      references.push({ path, hash: id });
      return null;
    }
    if (Array.isArray(item)) return item.map((child, index) => visit(child, [...path, index]));
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, [...path, key])]));
    }
    return item;
  };
  const revision =
    value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.revision === "number"
      ? value.revision
      : undefined;
  return {
    packed: {
      format: "content-v1",
      value: visit(value, []),
      texts: references,
      ...(revision === undefined ? {} : { revision }),
    },
    texts,
  };
}

export function unpackContent(packed: PackedContent, read: (hash: string) => string): string {
  let value = packed.value;
  for (const reference of packed.texts) {
    const text = read(reference.hash);
    if (reference.path.length === 0) {
      value = text;
      continue;
    }
    let cursor: unknown = value;
    for (const key of reference.path.slice(0, -1)) {
      if (cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, key))
        throw new TypeError("Invalid content path");
      cursor = Reflect.get(cursor, key);
    }
    const key = reference.path.at(-1);
    if (cursor === null || typeof cursor !== "object" || key === undefined || !Object.hasOwn(cursor, key))
      throw new TypeError("Invalid content path");
    Reflect.set(cursor, key, text);
  }
  return JSON.stringify(value);
}

export const storedModelRowSchema = z.object({
  uuid: z.string(),
  tag: z.string(),
  columns: recordOf(jsonValueSchema),
  state: recordOf(jsonValueSchema),
  refs: recordOf(z.string().nullable()),
  refLists: recordOf(z.array(z.string())),
  children: recordOf(z.string().nullable()),
  childLists: recordOf(z.array(z.string())),
  childRecords: recordOf(recordOf(z.string())),
});

export const storedDocumentHeaderSchema = z.object({
  guid: z.string().optional(),
  revision: z.number(),
  root: z.object({
    format: z.literal("rows-v1"),
    uuid: z.string(),
    tag: z.string(),
    nodes: recordOf(storedModelRowSchema),
  }),
  meta: recordOf(recordOf(jsonValueSchema)).optional(),
});
