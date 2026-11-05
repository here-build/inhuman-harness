# Node 1: Reactive Entity Kernel & Drizzle Schema Validation (`@inhuman.tools/model`)

**DAG Position**: Layer 0 (Foundation — zero workspace dependencies)  
**Replaces**: `@here.build/plexus` (`PlexusModel`, `@syncing`, `Y.Doc` entity bindings)  
**Downstream Consumers**: `packages/plexus-expectations` (Node 3), `packages/harness-model` (Node 5), `packages-runtime/turn` (Node 6)

---

## 1. Goals & Non-Negotiable Laws

1. **100% Native MobX Stage 3 Decorators**: Every reactive field delegates directly to MobX 6.13+ standard `accessor` decorators (`@observable.ref`, `@observable.shallow`, `@computed`, `@action`). No `Y.Doc`, `Y.Map`, or `Y.Array` exists underneath.
2. **DB-Driven Initialization (Zero Local Defaults)**: Persisted model properties **must not** declare competing local default values (`accessor completed = false` is forbidden on DB-backed fields). All defaults come from the SQLite/Drizzle schema or explicit hydration snapshots.
3. **Static Compile-Time Verification Against Drizzle**: Model classes and their persisted accessors bind directly to Drizzle `SQLiteTable` and `SQLiteColumn` definitions so TypeScript statically rejects any type or nullability drift between a class property and its Drizzle column.
4. **First-Instantiation Runtime Schema Audit**: On the first instantiation of any `@model(tag, table)` class, the runtime inspects the Drizzle table metadata (`getTableColumns(table)`, `getTableConfig(table)`) and verifies 1-to-1 alignment with the class's decorated fields.
5. **Two-Pass Graph Serialization & Patch Recording**: Explicitly distinguishes owned child models (`@state.child`, `@state.childList`) from UUID pointers (`@state.ref`, `@state.refList`) and emits compact `(revision, patches[])` deltas per MobX action/transaction.

---

## 2. Static & Runtime Drizzle Schema Wiring

### 2.1 Static Type-Checking via `@model(tag, table)` and `@column(col)`

By passing the Drizzle table and column objects directly into the Stage 3 class and accessor decorators, TypeScript enforces that the class matches the Drizzle schema at compile time:

```ts
import {
  getTableColumns,
  getTableName,
  type GetColumnData,
  type InferSelectModel,
} from "drizzle-orm";
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { action, computed, observable } from "mobx";

/**
 * Compile-time assertion: every non-excluded column in `TTable`'s select model
 * must exist on `TInstance` with an assignable type.
 */
export type AssertModelMatchesTable<
  TTable extends SQLiteTable,
  TInstance,
  TExcluded extends keyof InferSelectModel<TTable> = never,
> = {
  [K in Exclude<keyof InferSelectModel<TTable>, TExcluded>]: K extends keyof TInstance
    ? InferSelectModel<TTable>[K] extends TInstance[K]
      ? unknown
      : {
          readonly __error: "Property type does not match Drizzle column type";
          readonly column: K;
          readonly expected: InferSelectModel<TTable>[K];
          readonly actual: TInstance[K];
        }
    : {
        readonly __error: "Missing Drizzle column on model class";
        readonly column: K;
      };
};
```

#### Column-Bound Accessor Decorator (`@column`)

Because TC39 Stage 3 `ClassAccessorDecoratorContext<This, Value>` is generic over `Value`, binding a Drizzle `SQLiteColumn` directly constrains the accessor's type to `GetColumnData<TCol, "raw">`:

```ts
export function column<
  This extends Model,
  TCol extends SQLiteColumn,
  TValue = GetColumnData<TCol, "raw">,
>(
  drizzleCol: TCol,
  codec?: ColumnCodec<GetColumnData<TCol, "raw">, TValue>,
) {
  return function (
    target: ClassAccessorDecoratorTarget<This, TValue>,
    context: ClassAccessorDecoratorContext<This, TValue>,
  ): ClassAccessorDecoratorResult<This, TValue> {
    if (context.kind !== "accessor") {
      throw new TypeError("@column can only decorate an `accessor` field");
    }

    // 1. Record column metadata in Stage 3 Decorator Metadata (`Symbol.metadata`)
    registerColumnMetadata(context, {
      propertyKey: String(context.name),
      columnName: drizzleCol.name,
      column: drizzleCol,
      notNull: drizzleCol.notNull,
      dataType: drizzleCol.dataType,
      columnType: drizzleCol.columnType,
      primary: drizzleCol.primary,
      hasDefault: drizzleCol.hasDefault,
      codec,
    });

    // 2. Delegate reactivity to MobX `@observable.ref` + patch recorder hook
    return createTrackedObservableRef(target, context);
  };
}
```

#### Example Usage (No Local Defaults, Statically Checked)

```ts
import { sessionsTable } from "@inhuman.tools/harness-contract/schema";
import { column, Model, model, state } from "@inhuman.tools/model";

@model("harness:session:row", sessionsTable)
export class SessionRecord extends Model<InferSelectModel<typeof sessionsTable>> {
  @column(sessionsTable.sessionId) accessor sessionId!: string;
  @column(sessionsTable.title) accessor title!: string;
  @column(sessionsTable.running) accessor running!: boolean;
  @column(sessionsTable.mode) accessor mode!: "assistant" | "agentic";
  @column(sessionsTable.parentSessionId) accessor parentSessionId!: string | null;
  @column(sessionsTable.depth) accessor depth!: number;
  // If `sessionsTable.depth` is `integer().notNull()` and a developer writes
  // `accessor depth!: string`, `tsc` fails right on the `@column` line!
}
```

---

### 2.2 First-Instantiation Runtime Schema Audit

Static types catch compile-time mismatches, but cannot catch:
- A column added to `sessionsTable` in Drizzle that was omitted from `@column(...)` decorators on the class (unless enforced by runtime reflection),
- Duplicate `@column` bindings pointing to the same SQLite column,
- A `@column` decorator referencing a column from the *wrong* Drizzle table, or
- Local default initializers accidentally written on a `@column` accessor (`@column(...) accessor running = false`).

To guarantee zero drift, `Model`'s constructor runs a **one-time schema audit per class** (`auditedClasses = new WeakSet<Function>()`):

```ts
const auditedClasses = new WeakSet<Function>();

export function auditModelClassOnce(ctor: typeof Model): void {
  if (auditedClasses.has(ctor)) return;
  const meta = getModelMetadata(ctor);
  if (meta.table != null) {
    const tableConfig = getTableConfig(meta.table);
    const tableColumns = getTableColumns(meta.table);
    const mappedColumns = new Set<string>();

    // 1. Verify every @column belongs to `meta.table` and has no duplicate mapping
    for (const field of meta.columns.values()) {
      const colTableName = getTableName(field.column.table);
      if (colTableName !== tableConfig.name) {
        throw new SchemaAuditError(
          `${ctor.name}.${field.propertyKey} binds column "${field.columnName}" from table "${colTableName}", expected "${tableConfig.name}"`,
        );
      }
      if (mappedColumns.has(field.columnName)) {
        throw new SchemaAuditError(
          `${ctor.name} maps SQLite column "${tableConfig.name}.${field.columnName}" more than once`,
        );
      }
      mappedColumns.add(field.columnName);
    }

    // 2. Verify every column in the Drizzle SQLiteTable is accounted for on the class
    for (const [colKey, drizzleCol] of Object.entries(tableColumns)) {
      if (!mappedColumns.has(drizzleCol.name) && !meta.ignoredColumns.has(drizzleCol.name)) {
        throw new SchemaAuditError(
          `Model ${ctor.name} (${meta.tag}) is missing @column binding for Drizzle column "${tableConfig.name}.${drizzleCol.name}" (${colKey})`,
        );
      }
    }
  }
  auditedClasses.add(ctor);
}
```

#### Enforcing "No Local Defaults" at Instantiation

In Stage 3 `ClassAccessorDecoratorTarget.init(initialValue)`, if the class author wrote `@column(...) accessor running = false`, `initialValue` is `false` instead of `undefined`:

```ts
init(initialValue: TValue): TValue {
  if (initialValue !== undefined) {
    throw new SchemaAuditError(
      `Forbidden local default value on DB-driven field ${String(context.name)}. ` +
      `Hydrate from a DB row/snapshot instead of declaring a class initializer.`,
    );
  }
  return hydrateFieldFromCurrentContext(context.name);
}
```

---

## 3. Graph Relationships & Patch Recording (`@state`)

For hierarchical in-turn graph nodes (`SessionTurn`, `WorkContainer`, `WorkExpectation`, `Job`) that are persisted into `session_turns` / `session_jobs` / `session_updates`:

| Decorator | MobX Backing | Serialization Semantics |
| :--- | :--- | :--- |
| `@column(col)` | `@observable.ref` | Direct 1:1 column in the bound Drizzle `SQLiteTable`. |
| `@state` | `@observable.ref` | Scalar / immutable value field inside a structured node snapshot. |
| `@state.ref` | `@observable.ref` | Pointer to another `Model` in the same document, serialized as `uuid: string \| null`. |
| `@state.child` | `@observable.ref` | Owned child `Model`, serialized inline with its polymorphic `@model(tag)`. |
| `@state.list` | `@observable.shallow` | Observable array of scalar values. |
| `@state.refList` | `@observable.shallow` | Observable array of `Model` references, serialized as `uuid: string[]` (e.g., `Job.after`). |
| `@state.childList` | `@observable.shallow` | Observable array of owned child `Model` instances (e.g., `Job.children`, `SessionTurn.queue`). |
| `@state.record` | `@observable.shallow` | Observable `Record<string, T>` dictionary. |
| `@state.action` | `@action` | MobX action batching mutations and flushing one patch frame on exit. |

### Two-Pass Hydration (`hydrateDocument`)

Because `@state.ref` and `@state.refList` (such as `SessionRoot.head` or `Job.after`) can point to nodes anywhere in the document:
1. **Pass 1 (Tree Materialization)**: Instantiate all `@model(tag)` nodes (validating each class's Drizzle schema on first instantiation), populate scalar `@column`/`@state` fields, and register every instance in `registry: Map<string, Model>` by `uuid`.
2. **Pass 2 (Reference Linking)**: Resolve all `@state.ref` and `@state.refList` UUIDs against `registry`. Throw a deterministic `BrokenReferenceError` if any referenced UUID is missing.

### Transaction-Scoped Patch Emission

Every `DocumentContainer` (`SessionDocument`, `KernelDocument`) holds a monotonic `revision: number` and a mutation collector:
- When a `@column` or `@state` setter (or `@state.list` / `@state.record` mutation) runs inside an active MobX action, it appends a typed `ModelPatch` (`{ op: "set" | "splice" | "del", nodeId, field, value }`) to the current transaction buffer.
- When the outermost action completes, `revision` increments by 1 and subscribers receive `{ revision, patches }`.

---

## 4. Verification Criteria for Node 1

- [ ] `tsc --noEmit` fails when a `@column(table.col)` accessor has a mismatched type or nullability vs. Drizzle's `SQLiteColumn`.
- [ ] First instantiation of a `@model(tag, table)` class throws `SchemaAuditError` if a Drizzle table column is missing on the class, belongs to another table, or if a local default initializer (`accessor x = 1`) is present.
- [ ] Two-pass hydration round-trips cyclic/sibling `uuid` references (`Job.after`) and polymorphic `@state.childList` trees with zero data loss.
- [ ] MobX `computed`, `reaction`, and `when` trigger identically to native MobX with zero `Y.Doc` dependencies.
