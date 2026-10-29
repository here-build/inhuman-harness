/**
 * Workspace SQLite store. Imported only by the memory MCP child process.
 */
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { z } from "zod";

import {
  PACK_TOKEN_CEILING,
  citationsSupported,
  filterPromotableFacts,
  retainedRefKeys,
  validatePack,
} from "./extraction.js";
import {
  coreRowSchema,
  episodeRowSchema,
  memoryCommitRowSchema,
  sourceRefSchema,
  sourceSliceSchema,
  type CitedPack,
  type CoreRow,
  type EpisodeRow,
  type MemoryCommitRow,
  type RetentionCandidate,
} from "./schemas/memory.js";
import { assertWorkspaceDirectory, memoryDbPath, workspaceId } from "./workspace.js";

const sourceSlicesSchema = z.array(sourceSliceSchema);
const sourceRefsSchema = z.array(sourceRefSchema);
const idListSchema = z.array(z.string());

function parseJsonColumn<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class MemoryStore {
  readonly #db: Database.Database;
  readonly workspaceId: string;
  readonly #readDb: Database.Database;

  constructor(workspacePath: string) {
    assertWorkspaceDirectory(workspacePath);
    this.workspaceId = workspaceId(workspacePath);
    const dbPath = memoryDbPath(workspacePath);
    this.#db = new Database(dbPath);
    this.#readDb = new Database(dbPath, { readonly: true });
    this.#migrate();
    this.#ensureMetadata(workspacePath);
  }

  get databasePid(): number {
    return process.pid;
  }

  close(): void {
    this.#readDb.close();
    this.#db.close();
  }

  find(query: string, limit: number, tokenCeiling = PACK_TOKEN_CEILING): CitedPack {
    const rows = this.#readDb
      .prepare(
        `SELECT f.id AS factId, f.episode_id AS episodeId, f.body, f.valid_at AS validAt,
                f.invalid_at AS invalidAt, f.citations_json AS citationsJson,
                e.slices_json AS slicesJson
         FROM facts_fts fts
         JOIN facts f ON f.id = fts.fact_id
         JOIN episodes e ON e.id = f.episode_id
         WHERE facts_fts MATCH ? AND f.invalid_at IS NULL
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit * 3) as Array<{
      factId: string;
      episodeId: string;
      body: string;
      validAt: number;
      invalidAt: number | null;
      citationsJson: string;
      slicesJson: string;
    }>;
    const revision = this.snapshotRevision();
    const items: CitedPack["items"] = [];
    let tokenCount = 0;
    for (const row of rows) {
      const slices = parseJsonColumn(row.slicesJson, sourceSlicesSchema);
      if (slices == null) continue;
      const allowed = retainedRefKeys(slices);
      const citations = parseJsonColumn(row.citationsJson, sourceRefsSchema);
      if (citations == null) continue;
      if (
        !citations.every((ref) =>
          allowed.has(
            `${ref.sessionId}:${ref.turnId}:${ref.completionId}:${ref.entityId}:${ref.field}:${ref.start}:${ref.end}`,
          ),
        )
      ) {
        continue;
      }
      const snippet = row.body.slice(0, 400);
      const itemTokens = Math.ceil(snippet.length / 4);
      if (tokenCount + itemTokens > tokenCeiling) break;
      tokenCount += itemTokens;
      items.push({
        factId: row.factId,
        episodeId: row.episodeId,
        snippet,
        validAt: row.validAt,
        invalidAt: row.invalidAt,
        citations,
      });
      if (items.length >= limit) break;
    }
    const pack = { snapshotRevision: revision, items, tokenCount };
    return (
      validatePack(
        pack,
        new Set(
          items.flatMap((item) =>
            item.citations.map(
              (ref) =>
                `${ref.sessionId}:${ref.turnId}:${ref.completionId}:${ref.entityId}:${ref.field}:${ref.start}:${ref.end}`,
            ),
          ),
        ),
      ) ?? { snapshotRevision: revision, items: [], tokenCount: 0 }
    );
  }

  readEpisode(episodeId: string): EpisodeRow | null {
    const row = this.#readDb
      .prepare(
        `SELECT id, request_id AS requestId, workspace_id AS workspaceId, source_digest AS sourceDigest,
                slices_json AS slicesJson, created_at AS createdAt
         FROM episodes WHERE id = ?`,
      )
      .get(episodeId) as
      | {
          id: string;
          requestId: string;
          workspaceId: string;
          sourceDigest: string;
          slicesJson: string;
          createdAt: number;
        }
      | undefined;
    if (row == null) return null;
    const slices = parseJsonColumn(row.slicesJson, sourceSlicesSchema);
    if (slices == null) return null;
    const parsed = episodeRowSchema.safeParse({
      id: row.id,
      requestId: row.requestId,
      workspaceId: row.workspaceId,
      sourceDigest: row.sourceDigest,
      slices,
      createdAt: row.createdAt,
    });
    return parsed.success ? parsed.data : null;
  }

  readCommit(requestId: string): MemoryCommitRow | null {
    const row = this.#readDb
      .prepare(
        `SELECT request_id AS requestId, input_digest AS inputDigest, contribution_revision AS contributionRevision,
                kind, episode_ids_json AS episodeIdsJson, fact_ids_json AS factIdsJson,
                core_revision AS coreRevision, reason, committed_at AS committedAt
         FROM memory_commits WHERE request_id = ?`,
      )
      .get(requestId) as
      | {
          requestId: string;
          inputDigest: string;
          contributionRevision: string;
          kind: "retained" | "empty";
          episodeIdsJson: string;
          factIdsJson: string;
          coreRevision: number | null;
          reason: string | null;
          committedAt: number;
        }
      | undefined;
    if (row == null) return null;
    const episodeIds = parseJsonColumn(row.episodeIdsJson, idListSchema);
    const factIds = parseJsonColumn(row.factIdsJson, idListSchema);
    if (episodeIds == null || factIds == null) return null;
    const parsed = memoryCommitRowSchema.safeParse({
      requestId: row.requestId,
      inputDigest: row.inputDigest,
      contributionRevision: row.contributionRevision,
      kind: row.kind,
      episodeIds,
      factIds,
      coreRevision: row.coreRevision,
      reason: row.reason,
      committedAt: row.committedAt,
    });
    return parsed.success ? parsed.data : null;
  }

  getCore(scopeSessionId: string): CoreRow | null {
    const row = this.#readDb
      .prepare(
        `SELECT scope_session_id AS scopeSessionId, revision, body, source_request_id AS sourceRequestId,
                citations_json AS citationsJson
         FROM core_rows WHERE scope_session_id = ?`,
      )
      .get(scopeSessionId) as
      | {
          scopeSessionId: string;
          revision: number;
          body: string;
          sourceRequestId: string;
          citationsJson: string;
        }
      | undefined;
    if (row == null) return null;
    const citations = parseJsonColumn(row.citationsJson, sourceRefsSchema);
    if (citations == null) return null;
    const parsed = coreRowSchema.safeParse({
      scopeSessionId: row.scopeSessionId,
      revision: row.revision,
      body: row.body,
      sourceRequestId: row.sourceRequestId,
      citations,
    });
    return parsed.success ? parsed.data : null;
  }

  commit(
    requestId: string,
    inputDigest: string,
    contributionRevision: string,
    candidate: RetentionCandidate,
  ): MemoryCommitRow {
    const existing = this.readCommit(requestId);
    if (existing != null) {
      if (existing.inputDigest !== inputDigest) {
        throw new Error(`commit digest conflict for request ${requestId}`);
      }
      return existing;
    }
    if (candidate.emptyReason != null && (candidate.facts.length > 0 || candidate.core != null)) {
      throw new Error("empty candidate cannot contain facts or core update");
    }
    let sanitized: RetentionCandidate;
    if (candidate.episode == null) {
      sanitized =
        candidate.emptyReason != null
          ? { ...candidate, facts: [], core: null }
          : candidate.core != null
            ? { ...candidate, facts: [] }
            : candidate;
    } else {
      const allowed = retainedRefKeys(candidate.episode.slices);
      sanitized = {
        episode: candidate.episode,
        facts: filterPromotableFacts(candidate.facts, allowed),
        core:
          candidate.core != null && citationsSupported(candidate.core.next.citations, allowed) ? candidate.core : null,
        emptyReason: candidate.emptyReason,
      };
    }
    this.#db.prepare("BEGIN IMMEDIATE").run();
    try {
      const row = this.#commitImmediate(requestId, inputDigest, contributionRevision, sanitized);
      this.#db.prepare("COMMIT").run();
      return row;
    } catch (error) {
      this.#db.prepare("ROLLBACK").run();
      throw error;
    }
  }

  #invalidateFact(factId: string, invalidAt: number): void {
    this.#db.prepare(`UPDATE facts SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL`).run(invalidAt, factId);
  }

  #commitImmediate(
    requestId: string,
    inputDigest: string,
    contributionRevision: string,
    candidate: RetentionCandidate,
  ): MemoryCommitRow {
    const episodeIds: string[] = [];
    const factIds: string[] = [];
    let coreRevision: number | null = null;
    let kind: "retained" | "empty";
    let reason: string | null = candidate.emptyReason;

    if (candidate.episode != null) {
      const episodeId = randomUUID();
      const createdAt = Date.now();
      const allowed = retainedRefKeys(candidate.episode.slices);
      const promotableFacts = filterPromotableFacts(candidate.facts, allowed);
      this.#db
        .prepare(
          `INSERT INTO episodes (id, request_id, workspace_id, source_digest, slices_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          episodeId,
          candidate.episode.requestId,
          candidate.episode.workspaceId,
          candidate.episode.sourceDigest,
          JSON.stringify(candidate.episode.slices),
          createdAt,
        );
      episodeIds.push(episodeId);
      for (const fact of promotableFacts) {
        const factId = randomUUID();
        const recordedAt = Date.now();
        if (fact.supersedesId != null) {
          this.#invalidateFact(fact.supersedesId, fact.validAt);
        }
        this.#db
          .prepare(
            `INSERT INTO facts (id, episode_id, body, valid_at, invalid_at, recorded_at, supersedes_id,
                                confidence, citations_json, tags_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            factId,
            episodeId,
            fact.body,
            fact.validAt,
            fact.invalidAt,
            recordedAt,
            fact.supersedesId,
            fact.confidence,
            JSON.stringify(fact.citations),
            JSON.stringify(fact.tags),
          );
        this.#db.prepare(`INSERT INTO facts_fts(fact_id, body) VALUES (?, ?)`).run(factId, fact.body);
        factIds.push(factId);
      }
      kind = factIds.length > 0 || episodeIds.length > 0 ? "retained" : "empty";
      if (kind === "empty" && reason == null) reason = "episode_without_facts";
    } else if (candidate.emptyReason != null) {
      kind = "empty";
    } else if (candidate.core == null) {
      throw new Error("commit requires episode, emptyReason, or core");
    } else {
      kind = "retained";
    }

    if (candidate.core != null) {
      const allowed =
        candidate.episode == null
          ? candidate.core.next.citations.length === 0
            ? new Set<string>()
            : new Set<string>()
          : retainedRefKeys(candidate.episode.slices);
      if (
        candidate.core.next.citations.length > 0 &&
        !candidate.core.next.citations.every((ref) =>
          allowed.has(
            `${ref.sessionId}:${ref.turnId}:${ref.completionId}:${ref.entityId}:${ref.field}:${ref.start}:${ref.end}`,
          ),
        )
      ) {
        throw new Error("core citations must resolve against retained source refs");
      }
      const current = this.getCore(candidate.core.next.scopeSessionId);
      if (current != null && current.revision !== candidate.core.expectedRevision) {
        throw new Error(`stale core revision for ${candidate.core.next.scopeSessionId}`);
      }
      const nextRevision = (current?.revision ?? 0) + 1;
      this.#db
        .prepare(
          `INSERT INTO core_rows (scope_session_id, revision, body, source_request_id, citations_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(scope_session_id) DO UPDATE SET
             revision = excluded.revision,
             body = excluded.body,
             source_request_id = excluded.source_request_id,
             citations_json = excluded.citations_json
           WHERE core_rows.revision = ?`,
        )
        .run(
          candidate.core.next.scopeSessionId,
          nextRevision,
          candidate.core.next.body,
          candidate.core.next.sourceRequestId,
          JSON.stringify(candidate.core.next.citations),
          candidate.core.expectedRevision,
        );
      if ((this.#db.prepare(`SELECT changes() AS n`).get() as { n: number }).n === 0) {
        throw new Error(`stale core revision for ${candidate.core.next.scopeSessionId}`);
      }
      coreRevision = nextRevision;
    }

    const committedAt = Date.now();
    const row: MemoryCommitRow = {
      requestId,
      inputDigest,
      contributionRevision,
      kind,
      episodeIds,
      factIds,
      coreRevision,
      reason,
      committedAt,
    };
    this.#db
      .prepare(
        `INSERT INTO memory_commits (request_id, input_digest, contribution_revision, kind,
                                    episode_ids_json, fact_ids_json, core_revision, reason, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.requestId,
        row.inputDigest,
        row.contributionRevision,
        row.kind,
        JSON.stringify(row.episodeIds),
        JSON.stringify(row.factIds),
        row.coreRevision,
        row.reason,
        row.committedAt,
      );
    return row;
  }

  snapshotRevision(): number {
    const row = this.#readDb.prepare(`SELECT MAX(committed_at) AS n FROM memory_commits`).get() as {
      n: number | null;
    };
    return row.n ?? 0;
  }

  #migrate(): void {
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS store_metadata (
        workspace_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        slices_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        body TEXT NOT NULL,
        valid_at INTEGER NOT NULL,
        invalid_at INTEGER,
        recorded_at INTEGER NOT NULL,
        supersedes_id TEXT,
        confidence REAL NOT NULL,
        citations_json TEXT NOT NULL,
        tags_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(fact_id UNINDEXED, body);
      CREATE TABLE IF NOT EXISTS core_rows (
        scope_session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL,
        source_request_id TEXT NOT NULL,
        citations_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_commits (
        request_id TEXT PRIMARY KEY,
        input_digest TEXT NOT NULL,
        contribution_revision TEXT NOT NULL,
        kind TEXT NOT NULL,
        episode_ids_json TEXT NOT NULL,
        fact_ids_json TEXT NOT NULL,
        core_revision INTEGER,
        reason TEXT,
        committed_at INTEGER NOT NULL
      );
    `);
  }

  #ensureMetadata(workspacePath: string): void {
    const createdAt = Date.now();
    this.#db
      .prepare(
        `INSERT INTO store_metadata (workspace_id, workspace_path, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET workspace_path = excluded.workspace_path`,
      )
      .run(this.workspaceId, workspacePath, createdAt);
  }
}
