import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { computed, reaction, runInAction } from "mobx";
import { describe, expect, it } from "vitest";

import {
  BrokenReferenceError,
  column,
  DocumentContainer,
  getModelByTag,
  hydrateModel,
  Model,
  model,
  SchemaAuditError,
  serializeModel,
  state,
} from "../index.js";
import type { ColumnCodec } from "../types.js";

// Sample tables for testing
const testSessionsTable = sqliteTable("test_sessions", {
  sessionId: text("session_id").primaryKey(),
  title: text("title").notNull(),
  depth: integer("depth").notNull(),
  parentSessionId: text("parent_session_id"),
  metadataJson: text("metadata_json"),
});

const foreignTable = sqliteTable("foreign_table", {
  foreignCol: text("foreign_col").notNull(),
});

const partialTable = sqliteTable("partial_table", {
  id: text("id").primaryKey(),
  colA: text("col_a").notNull(),
  colB: text("col_b").notNull(),
});

describe("@inhuman.tools/model", () => {
  describe("Schema Validation & First-Instantiation Runtime Audit", () => {
    it("instantiates a valid model matching Drizzle table schema", () => {
      @model("test:valid:session", testSessionsTable)
      class ValidSession extends Model {
        @column(testSessionsTable.sessionId) accessor sessionId!: string;
        @column(testSessionsTable.title) accessor title!: string;
        @column(testSessionsTable.depth) accessor depth!: number;
        @column(testSessionsTable.parentSessionId) accessor parentSessionId!: string | null;
        @column(testSessionsTable.metadataJson) accessor metadataJson!: string | null;
      }

      const instance = new ValidSession({
        sessionId: "sess-1",
        title: "Test Session",
        depth: 0,
        parentSessionId: null,
        metadataJson: null,
      });

      expect(instance.uuid).toBe("sess-1");
      expect(instance.sessionId).toBe("sess-1");
      expect(instance.title).toBe("Test Session");
      expect(instance.depth).toBe(0);
      expect(getModelByTag("test:valid:session")).toBe(ValidSession);
    });

    it("throws SchemaAuditError when a Drizzle table column is missing on the class", () => {
      // @ts-expect-error Statically rejected because depth, parentSessionId, metadataJson are missing
      @model("test:missing:col", testSessionsTable)
      class IncompleteSession extends Model {
        @column(testSessionsTable.sessionId) accessor sessionId!: string;
        @column(testSessionsTable.title) accessor title!: string;
        // Missing depth, parentSessionId, metadataJson
      }

      expect(() => new IncompleteSession()).toThrowError(SchemaAuditError);
      expect(() => new IncompleteSession()).toThrowError(
        /missing @column binding for Drizzle column "test_sessions.depth"/,
      );
    });

    it("allows omitting columns listed in options.ignoredColumns", () => {
      @model("test:ignored:col", partialTable, { ignoredColumns: ["colB"] })
      class IgnoredColModel extends Model {
        @column(partialTable.id) accessor id!: string;
        @column(partialTable.colA) accessor colA!: string;
      }

      const inst = new IgnoredColModel({ id: "id-1", colA: "val-a" });
      expect(inst.id).toBe("id-1");
      expect(inst.colA).toBe("val-a");
    });

    it("throws SchemaAuditError when binding a column from a foreign table", () => {
      // @ts-expect-error Statically rejected because foreignCol belongs to foreign_table
      @model("test:foreign:col", testSessionsTable)
      class ForeignColSession extends Model {
        @column(testSessionsTable.sessionId) accessor sessionId!: string;
        @column(testSessionsTable.title) accessor title!: string;
        @column(testSessionsTable.depth) accessor depth!: number;
        @column(testSessionsTable.parentSessionId) accessor parentSessionId!: string | null;
        @column(foreignTable.foreignCol) accessor metadataJson!: string;
      }

      expect(() => new ForeignColSession()).toThrowError(SchemaAuditError);
      expect(() => new ForeignColSession()).toThrowError(
        /binds column "foreign_col" from table "foreign_table", expected "test_sessions"/,
      );
    });

    it("throws SchemaAuditError when a SQLite column is mapped more than once", () => {
      // @ts-expect-error Statically rejected because title is bound twice
      @model("test:duplicate:col", testSessionsTable)
      class DuplicateColSession extends Model {
        @column(testSessionsTable.sessionId) accessor sessionId!: string;
        @column(testSessionsTable.title) accessor title!: string;
        @column(testSessionsTable.depth) accessor depth!: number;
        @column(testSessionsTable.parentSessionId) accessor parentSessionId!: string | null;
        @column(testSessionsTable.title) accessor duplicateTitle!: string;
      }

      expect(() => new DuplicateColSession()).toThrowError(SchemaAuditError);
      expect(() => new DuplicateColSession()).toThrowError(/maps SQLite column "test_sessions.title" more than once/);
    });

    it("throws SchemaAuditError if a local default initializer is declared on a @column", () => {
      @model("test:local:default", partialTable)
      class LocalDefaultModel extends Model {
        @column(partialTable.id) accessor id!: string;
        @column(partialTable.colA) accessor colA = "forbidden-local-default";
        @column(partialTable.colB) accessor colB!: string;
      }

      expect(() => new LocalDefaultModel()).toThrowError(SchemaAuditError);
      expect(() => new LocalDefaultModel()).toThrowError(/Forbidden local default value on DB-driven field "colA"/);
    });

    it("allows idempotent re-registration of the exact same class, but rejects a different class", () => {
      @model("test:idempotent", partialTable, { ignoredColumns: ["colB"] })
      class AlphaModel extends Model {
        @column(partialTable.id) accessor id!: string;
        @column(partialTable.colA) accessor colA!: string;
      }

      // Re-decorating / re-registering AlphaModel with same tag is idempotent
      model("test:idempotent", partialTable, { ignoredColumns: ["colB"] })(AlphaModel, {
        kind: "class",
        name: "AlphaModel",
        addInitializer: () => {},
        metadata: {},
      });

      // Attempting to register BetaModel with existing tag throws
      expect(() => {
        @model("test:idempotent", partialTable, { ignoredColumns: ["colB"] })
        class BetaModel extends Model {
          @column(partialTable.id) accessor id!: string;
          @column(partialTable.colA) accessor colA!: string;
        }
        new BetaModel();
      }).toThrowError(/Model tag "test:idempotent" is already registered/);
    });
  });

  describe("Column Codecs, toRow(), applyRow(), and Selective MobX Reactivity", () => {
    interface DateMetadata {
      readonly timestamp: number;
    }

    const metadataCodec: ColumnCodec<string | null, DateMetadata | null> = {
      toModel: (db) => (db ? (JSON.parse(db) as DateMetadata) : null),
      toDb: (modelVal) => (modelVal ? JSON.stringify(modelVal) : null),
    };

    @model("test:codec:session", testSessionsTable, { ignoredColumns: ["metadataJson"] })
    class CodecSession extends Model {
      @column(testSessionsTable.sessionId) accessor sessionId!: string;
      @column(testSessionsTable.title) accessor title!: string;
      @column(testSessionsTable.depth) accessor depth!: number;
      @column(testSessionsTable.parentSessionId) accessor parentSessionId!: string | null;
      @column(testSessionsTable.metadataJson, metadataCodec)
      accessor metadataJson!: DateMetadata | null;

      @computed
      get titleUppercase(): string {
        return this.title.toUpperCase();
      }

      @computed
      get depthPlusTen(): number {
        return this.depth + 10;
      }
    }

    it("hydrates from props with codec and serializes with toRow()", () => {
      const sess = new CodecSession({
        sessionId: "s-100",
        title: "my title",
        depth: 2,
        parentSessionId: null,
        metadataJson: JSON.stringify({ timestamp: 12345 }),
      });

      expect(sess.title).toBe("my title");
      expect(sess.titleUppercase).toBe("MY TITLE");
      expect(sess.metadataJson).toEqual({ timestamp: 12345 });

      const row = sess.toRow();
      expect(row).toMatchObject({
        sessionId: "s-100",
        title: "my title",
        depth: 2,
        parentSessionId: null,
        metadataJson: JSON.stringify({ timestamp: 12345 }),
      });
    });

    it("applyRow only updates changed columns and avoids notifying unaffected computeds", () => {
      const sess = new CodecSession({
        sessionId: "s-200",
        title: "initial title",
        depth: 5,
        parentSessionId: null,
        metadataJson: null,
      });

      let titleReactionCount = 0;
      let depthReactionCount = 0;

      const d1 = reaction(
        () => sess.titleUppercase,
        () => {
          titleReactionCount++;
        },
      );

      const d2 = reaction(
        () => sess.depthPlusTen,
        () => {
          depthReactionCount++;
        },
      );

      // Apply row where depth changed, but title and sessionId remain identical
      sess.applyRow({
        title: "initial title",
        depth: 6,
      });

      expect(sess.depth).toBe(6);
      expect(sess.depthPlusTen).toBe(16);
      expect(depthReactionCount).toBe(1);
      expect(titleReactionCount).toBe(0); // Title didn't change, so computed didn't notify!

      // Now apply row with new title
      sess.applyRow({
        title: "new title",
      });

      expect(sess.titleUppercase).toBe("NEW TITLE");
      expect(titleReactionCount).toBe(1);
      expect(depthReactionCount).toBe(1); // Depth didn't re-trigger

      d1();
      d2();
    });
  });

  describe("Two-Pass Graph Hydration (Polymorphic Trees, Cyclic & Sibling Refs)", () => {
    @model("test:graph:job")
    class TestJob extends Model {
      @state accessor name!: string;
      @state accessor completed = false;
      @state.childList accessor children: TestJob[] = [];
      @state.refList accessor after: TestJob[] = [];
      @state.ref accessor parentJob: TestJob | null = null;
    }

    @model("test:graph:agent-job")
    class TestAgentJob extends TestJob {
      @state accessor agentModel!: string;
    }

    it("round-trips polymorphic children and sibling dependency graphs without data loss", () => {
      // Build a diamond dependency job tree:
      // Job 0 (root)
      //   ├── Job 1 (AgentJob, after: [])
      //   ├── Job 2 (Job, after: [Job 1])
      //   └── Job 3 (AgentJob, after: [Job 1, Job 2])
      const root = new TestJob({ name: "root" });

      const j1 = new TestAgentJob({ name: "agent-1", agentModel: "gpt-4o" });
      const j2 = new TestJob({ name: "job-2" });
      const j3 = new TestAgentJob({ name: "agent-3", agentModel: "claude-3-5-sonnet" });

      j1.parentJob = root;
      j2.parentJob = root;
      j3.parentJob = root;

      j2.after.push(j1);
      j3.after.push(j1, j2);

      root.children.push(j1, j2, j3);

      const serialized = serializeModel(root);
      const hydrated = hydrateModel<TestJob>(serialized);

      expect(hydrated.name).toBe("root");
      expect(hydrated.children).toHaveLength(3);

      const [h1, h2, h3] = hydrated.children as [TestAgentJob, TestJob, TestAgentJob];

      // Polymorphic types preserved
      expect(h1).toBeInstanceOf(TestAgentJob);
      expect(h1.agentModel).toBe("gpt-4o");
      expect(h2).toBeInstanceOf(TestJob);
      expect(h3).toBeInstanceOf(TestAgentJob);
      expect(h3.agentModel).toBe("claude-3-5-sonnet");

      // Pass 2 reference linking resolved to exact sibling instances
      expect(h2.after).toHaveLength(1);
      expect(h2.after[0]).toBe(h1);

      expect(h3.after).toHaveLength(2);
      expect(h3.after[0]).toBe(h1);
      expect(h3.after[1]).toBe(h2);

      // Parent back-pointer preserved
      expect(h1.parentJob).toBe(hydrated);
      expect(h2.parentJob).toBe(hydrated);
      expect(h3.parentJob).toBe(hydrated);
    });

    it("throws BrokenReferenceError deterministically on missing target UUID", () => {
      const snap = {
        uuid: "root-1",
        tag: "test:graph:job",
        columns: {},
        state: { name: "broken-root", completed: false },
        refs: { parentJob: "non-existent-uuid" },
        refLists: {},
        children: {},
        childLists: {},
      };

      expect(() => hydrateModel(snap)).toThrowError(BrokenReferenceError);
      expect(() => hydrateModel(snap)).toThrowError(/references missing node "non-existent-uuid"/);
    });

    it("throws BrokenReferenceError when refList points to a missing UUID", () => {
      const snap = {
        uuid: "root-2",
        tag: "test:graph:job",
        columns: {},
        state: { name: "broken-list", completed: false },
        refs: { parentJob: null },
        refLists: { after: ["missing-uuid-123"] },
        children: {},
        childLists: {},
      };

      expect(() => hydrateModel(snap)).toThrowError(BrokenReferenceError);
      expect(() => hydrateModel(snap)).toThrowError(/references missing node "missing-uuid-123"/);
    });
  });

  describe("DocumentContainer: Revisioning, Patch Emission & Replica Convergence", () => {
    @model("test:container:item")
    class ContainerItem extends Model {
      @state accessor text!: string;
      @state accessor priority = 0;
    }

    @model("test:container:root", testSessionsTable)
    class ContainerRoot extends Model {
      @column(testSessionsTable.sessionId) accessor sessionId!: string;
      @column(testSessionsTable.title) accessor title!: string;
      @column(testSessionsTable.depth) accessor depth!: number;
      @column(testSessionsTable.parentSessionId) accessor parentSessionId!: string | null;
      @column(testSessionsTable.metadataJson) accessor metadataJson!: string | null;

      @state.childList accessor items: ContainerItem[] = [];
      @state.record accessor tags: Record<string, string> = {};
      @state.list accessor flags: string[] = [];
      @state.ref accessor activeItem: ContainerItem | null = null;

      @state.action
      batchAdd(item: ContainerItem, flag: string, tagKey: string, tagVal: string): void {
        this.items.push(item);
        this.flags.push(flag);
        this.tags[tagKey] = tagVal;
        this.activeItem = item;
      }
    }

    it("batches patches and increments revision when mutations occur inside transact or @state.action", () => {
      const root = new ContainerRoot({
        sessionId: "root-sess",
        title: "Container Test",
        depth: 0,
        parentSessionId: null,
        metadataJson: null,
      });

      const primary = new DocumentContainer(root);
      const emittedBatches: Array<{ revision: number; patchesCount: number }> = [];

      primary.onPatch((batch) => {
        emittedBatches.push({ revision: batch.revision, patchesCount: batch.patches.length });
      });

      expect(primary.revision).toBe(0);

      // Perform batch mutation via @state.action
      const item1 = new ContainerItem({ text: "Item 1", priority: 1 });
      root.batchAdd(item1, "flag-1", "env", "production");

      expect(primary.revision).toBe(1);
      expect(emittedBatches).toHaveLength(1);
      expect(emittedBatches[0].revision).toBe(1);
      // Items added: item pushed, flag pushed, tag set, activeItem set
      expect(emittedBatches[0].patchesCount).toBeGreaterThanOrEqual(4);
    });

    it("converges a replica DocumentContainer to an identical graph and computed state", () => {
      const primaryRoot = new ContainerRoot({
        sessionId: "sess-p",
        title: "Primary Session",
        depth: 1,
        parentSessionId: null,
        metadataJson: null,
      });
      const primary = new DocumentContainer(primaryRoot);

      // Snapshot to create identical initial replica
      const snapshot = primary.toSnapshot();
      const replica = DocumentContainer.fromSnapshot<ContainerRoot>(snapshot);

      expect(replica.root.sessionId).toBe("sess-p");
      expect(replica.root.title).toBe("Primary Session");
      expect(replica.revision).toBe(0);

      // Listen for patches on primary and apply them to replica
      primary.onPatch((batch) => {
        replica.applyPatchBatch(batch);
      });

      // 1. Column modification
      runInAction(() => {
        primaryRoot.title = "Updated Title";
      });

      expect(replica.root.title).toBe("Updated Title");
      expect(replica.revision).toBe(primary.revision);

      // 2. Child item addition and ref linking via @state.action
      const itemA = new ContainerItem({ text: "Alpha", priority: 10 });
      primaryRoot.batchAdd(itemA, "urgent", "category", "database");

      expect(replica.root.items).toHaveLength(1);
      expect(replica.root.items[0].text).toBe("Alpha");
      expect(replica.root.items[0].priority).toBe(10);
      expect(replica.root.flags).toEqual(["urgent"]);
      expect(replica.root.tags.category).toBe("database");
      expect(replica.root.activeItem).toBe(replica.root.items[0]);
      expect(replica.revision).toBe(primary.revision);

      // 3. Modifying the child item directly
      runInAction(() => {
        itemA.priority = 20;
      });

      expect(replica.root.items[0].priority).toBe(20);

      // 4. Record deletion
      runInAction(() => {
        delete primaryRoot.tags.category;
      });

      expect(replica.root.tags.category).toBeUndefined();

      // 5. Array splice removal
      runInAction(() => {
        primaryRoot.flags.splice(0, 1);
      });

      expect(replica.root.flags).toEqual([]);

      // Complete snapshot round-trip convergence check
      expect(replica.toSnapshot()).toEqual(primary.toSnapshot());
    });
  });
});
