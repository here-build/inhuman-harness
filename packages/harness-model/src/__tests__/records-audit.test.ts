import {
  kernelStateTable,
  pendingAsksTable,
  pluginStateLogsTable,
  projectsTable,
  scmResourcesTable,
  sessionsTable,
  sessionTurnsTable,
  tables,
} from "@inhuman.tools/harness-contract/schema";
import {
  auditModelClassOnce,
  DocumentContainer,
  getModelMetadata,
  ReadOnlyDocumentError,
} from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import {
  KernelDocument,
  KernelRecord,
  KernelRoot,
  PendingAskRecord,
  PluginStateLogRecord,
  ProjectDocument,
  ProjectRecord,
  ProjectRoot,
  ScmResourceRecord,
  SessionDocument,
  SessionRoot,
  SessionSummaryRecord,
  SessionTurnRecord,
} from "../index.js";

describe("Harness record schema audits, multi-tenant root state, and readOnly boundaries", () => {
  it("audits all 7 @column record classes against canonical SQLite tables with 1:1 column coverage", () => {
    const pairs = [
      { ctor: KernelRecord, table: kernelStateTable, def: tables.kernel_state },
      { ctor: ProjectRecord, table: projectsTable, def: tables.projects },
      { ctor: SessionSummaryRecord, table: sessionsTable, def: tables.sessions },
      { ctor: PendingAskRecord, table: pendingAsksTable, def: tables.pending_asks },
      { ctor: SessionTurnRecord, table: sessionTurnsTable, def: tables.session_turns },
      { ctor: ScmResourceRecord, table: scmResourcesTable, def: tables.scm_resources },
      { ctor: PluginStateLogRecord, table: pluginStateLogsTable, def: tables.plugin_state_logs },
    ] as const;

    for (const { ctor, table, def } of pairs) {
      auditModelClassOnce(ctor);
      const meta = getModelMetadata(ctor);
      expect(meta.table).toBe(table);
      const mappedSqlNames = new Set(Array.from(meta.columns.values(), (c) => c.columnName));
      const expectedSqlNames = [def.keySql, ...def.columns.map((c) => c.sql)];
      expect(mappedSqlNames.size).toBe(expectedSqlNames.length);
      for (const sqlName of expectedSqlNames) {
        expect(mappedSqlNames.has(sqlName)).toBe(true);
      }
    }
  });

  it("round-trips multi-tenant @state fields across KernelRoot, ProjectRoot, and SessionRoot", () => {
    const kernelSrc = KernelDocument.create(
      new KernelRoot({
        kernelId: "tenant-k1",
        enabledPlugins: ["todos", "fs-shell"],
      }),
    );
    const kernelDelta = kernelSrc.takeNodeDelta();
    const kernelReplica = KernelDocument.fromNodeRows(kernelDelta.upserts, {
      rootId: kernelDelta.rootId,
      revision: kernelDelta.revision,
    });
    expect(kernelReplica.root.kernelId).toBe("tenant-k1");
    expect(kernelReplica.root.enabledPlugins).toEqual(["todos", "fs-shell"]);

    kernelSrc.transact(() => {
      kernelSrc.root.enabledPlugins.push("goals");
    });
    kernelReplica.applyNodeRows(kernelSrc.takeNodeDelta());
    expect(kernelReplica.root.enabledPlugins).toEqual(["todos", "fs-shell", "goals"]);

    const projectSrc = new ProjectDocument(
      new ProjectRoot({
        projectId: "proj-42",
        kind: "virtual",
        path: "vm://tenant-k1/proj-42",
        enabledPlugins: ["fs-vfs"],
        pluginConfigs: { "fs-vfs": JSON.stringify({ bucket: "b1" }) },
      }),
    );
    expect(projectSrc.root.getPluginConfig("fs-vfs")).toBe(JSON.stringify({ bucket: "b1" }));
    const projectDelta = projectSrc.takeNodeDelta();
    const projectReplica = ProjectDocument.fromNodeRows(projectDelta.upserts, {
      rootId: projectDelta.rootId,
      revision: projectDelta.revision,
    });
    expect(projectReplica.root.projectId).toBe("proj-42");
    expect(projectReplica.root.kind).toBe("virtual");
    expect(projectReplica.root.enabledPlugins).toEqual(["fs-vfs"]);
    expect(projectReplica.root.getPluginConfig("fs-vfs")).toBe(JSON.stringify({ bucket: "b1" }));

    projectSrc.root.setPluginConfig("goals", JSON.stringify({ maxGoals: 5 }));
    projectReplica.applyNodeRows(projectSrc.takeNodeDelta());
    expect(projectReplica.root.getPluginConfig("goals")).toBe(JSON.stringify({ maxGoals: 5 }));

    const sessionSrc = SessionDocument.create(
      new SessionRoot({
        sessionId: "sess-99",
        projectId: "proj-42",
        path: "vm://tenant-k1/proj-42",
      }).sessionId,
      "vm://tenant-k1/proj-42",
    );
    sessionSrc.transact(() => {
      sessionSrc.root.projectId = "proj-42";
    });
    const sessionDelta = sessionSrc.takeNodeDelta();
    const sessionReplica = SessionDocument.fromNodeRows(sessionDelta.upserts, {
      rootId: sessionDelta.rootId,
      sessionId: "sess-99",
      revision: sessionDelta.revision,
    });
    expect(sessionReplica.root.projectId).toBe("proj-42");
  });

  it("enforces ReadOnlyDocumentError on KernelDocument, ProjectDocument, and SessionDocument (including repeated connect)", () => {
    // KernelDocument
    const kSrc = KernelDocument.create(new KernelRoot({ kernelId: "k-ro", enabledPlugins: ["todos"] }));
    const kContainer = DocumentContainer.fromSnapshot<KernelRoot>(kSrc.toSnapshot());
    kContainer.readOnly = true;
    const kRo = KernelDocument.connect(kContainer, { readOnly: true });
    expect(kRo.readOnly).toBe(true);
    expect(KernelDocument.connect(kRo, { readOnly: true })).toBe(kRo);

    expect(() => {
      kRo.root.kernelId = "mutated";
    }).toThrowError(ReadOnlyDocumentError);
    expect(kRo.root.kernelId).toBe("k-ro");
    expect(() => {
      kRo.root.enabledPlugins.push("hack");
    }).toThrowError(ReadOnlyDocumentError);
    expect(kRo.root.enabledPlugins).toEqual(["todos"]);

    kSrc.transact(() => {
      kSrc.root.enabledPlugins.push("memory");
    });
    kRo.applyNodeRows(kSrc.takeNodeDelta());
    expect(kRo.root.enabledPlugins).toEqual(["todos", "memory"]);

    // ProjectDocument
    const pSrc = new ProjectDocument(
      new ProjectRoot({ projectId: "p-ro", kind: "remote", path: "/remote/repo" }),
    );
    const pRo = ProjectDocument.connect(pSrc.toSnapshot(), { readOnly: true });
    expect(pRo.readOnly).toBe(true);
    expect(() => pRo.root.setPluginConfig("todos", "{}")).toThrowError(ReadOnlyDocumentError);
    expect(pRo.root.getPluginConfig("todos")).toBeUndefined();
    expect(() => {
      pRo.root.kind = "virtual";
    }).toThrowError(ReadOnlyDocumentError);
    expect(pRo.root.kind).toBe("remote");

    pSrc.root.setPluginConfig("todos", '{"enabled":true}');
    pRo.applyNodeRows(pSrc.takeNodeDelta());
    expect(pRo.root.getPluginConfig("todos")).toBe('{"enabled":true}');

    // SessionDocument
    const sSrc = SessionDocument.create("s-ro", "/repo");
    const sContainer = DocumentContainer.fromSnapshot<SessionRoot>(sSrc.toSnapshot());
    sContainer.readOnly = true;
    const sRo = SessionDocument.connect(sContainer, { readOnly: true });
    expect(sRo.readOnly).toBe(true);
    expect(SessionDocument.connect(sRo, { readOnly: true })).toBe(sRo);

    expect(() => {
      sRo.root.projectId = "hijacked";
    }).toThrowError(ReadOnlyDocumentError);
    expect(sRo.root.projectId).toBe("");

    sSrc.transact(() => {
      sSrc.root.projectId = "p-ro";
    });
    sRo.applyNodeRows(sSrc.takeNodeDelta());
    expect(sRo.root.projectId).toBe("p-ro");
  });
});
