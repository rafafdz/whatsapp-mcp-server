/**
 * SQLite-backed message store for the WhatsApp MCP server.
 *
 * Replaces the in-memory Map + full-file-rewrite JSON store with an indexed
 * SQLite database (better-sqlite3, synchronous). Gives fast filtered queries,
 * FTS5 full-text search, and a sandboxed read-only SQL surface for analytics —
 * without rewriting the whole store on every message.
 */
import Database from "better-sqlite3";

export interface DbMessage {
  id: string;
  chatId: string;
  sender: string;
  senderName: string;
  timestamp: number;
  text: string;
  isFromMe: boolean;
  isGroup: boolean;
  type: string;
  media?: any;
}

export interface ListOpts {
  chatId?: string;
  limit?: number;
  before?: number; // unix seconds, inclusive upper bound
  after?: number; // unix seconds, inclusive lower bound
  offset?: number;
}

export interface SearchOpts {
  query: string;
  chatId?: string;
  sender?: string;
  before?: number;
  after?: number;
  limit?: number;
}

const MAX_ROWS = 1000;

export class MessageDB {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.init();
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO messages
        (id, chat_id, sender, sender_name, timestamp, text, is_from_me, is_group, type, media, raw)
       VALUES (@id,@chat_id,@sender,@sender_name,@timestamp,@text,@is_from_me,@is_group,@type,@media,@raw)`
    );
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        pk INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender TEXT,
        sender_name TEXT,
        timestamp INTEGER NOT NULL,
        text TEXT,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        is_group INTEGER NOT NULL DEFAULT 0,
        type TEXT,
        media TEXT,
        raw TEXT,
        UNIQUE(chat_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_ts ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_ts ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_sender ON messages(sender);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(text, content='messages', content_rowid='pk');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.pk, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.pk, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.pk, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.pk, new.text);
      END;
    `);
  }

  /** Insert one message (no-op if (chat_id,id) already present). */
  add(m: DbMessage, raw?: any): void {
    this.insertStmt.run({
      id: m.id,
      chat_id: m.chatId,
      sender: m.sender ?? null,
      sender_name: m.senderName ?? null,
      timestamp: Math.floor(Number(m.timestamp) || 0),
      text: m.text ?? "",
      is_from_me: m.isFromMe ? 1 : 0,
      is_group: m.isGroup ? 1 : 0,
      type: m.type ?? null,
      media: m.media != null ? JSON.stringify(m.media) : null,
      raw: raw != null ? JSON.stringify(raw) : null,
    });
  }

  /** Bulk insert in a single transaction (fast path for history sync). */
  addMany(items: Array<{ m: DbMessage; raw?: any }>): void {
    const tx = this.db.transaction((arr: Array<{ m: DbMessage; raw?: any }>) => {
      for (const it of arr) this.add(it.m, it.raw);
    });
    tx(items);
  }

  private rowToMsg(r: any): DbMessage {
    return {
      id: r.id,
      chatId: r.chat_id,
      sender: r.sender,
      senderName: r.sender_name,
      timestamp: r.timestamp,
      text: r.text,
      isFromMe: !!r.is_from_me,
      isGroup: !!r.is_group,
      type: r.type,
      ...(r.media ? { media: JSON.parse(r.media) } : {}),
    };
  }

  /** Most-recent-first window, returned ascending (oldest→newest) to match the old API. */
  list(opts: ListOpts = {}): DbMessage[] {
    const where: string[] = [];
    const p: any = {};
    if (opts.chatId) { where.push("chat_id = @chatId"); p.chatId = opts.chatId; }
    if (opts.after != null) { where.push("timestamp >= @after"); p.after = opts.after; }
    if (opts.before != null) { where.push("timestamp <= @before"); p.before = opts.before; }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    p.limit = Math.max(1, Math.min(opts.limit ?? 20, MAX_ROWS));
    p.offset = Math.max(0, opts.offset ?? 0);
    const rows = this.db
      .prepare(`SELECT * FROM messages ${w} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`)
      .all(p);
    return rows.map((r) => this.rowToMsg(r)).sort((a, b) => a.timestamp - b.timestamp);
  }

  /** FTS5 full-text search over message text. */
  search(opts: SearchOpts): DbMessage[] {
    const fts = MessageDB.toFtsQuery(opts.query);
    if (!fts) return [];
    const where: string[] = [
      "m.pk IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH @q)",
    ];
    const p: any = { q: fts };
    if (opts.chatId) { where.push("m.chat_id = @chatId"); p.chatId = opts.chatId; }
    if (opts.sender) { where.push("m.sender = @sender"); p.sender = opts.sender; }
    if (opts.after != null) { where.push("m.timestamp >= @after"); p.after = opts.after; }
    if (opts.before != null) { where.push("m.timestamp <= @before"); p.before = opts.before; }
    p.limit = Math.max(1, Math.min(opts.limit ?? 20, MAX_ROWS));
    const rows = this.db
      .prepare(`SELECT m.* FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.timestamp DESC LIMIT @limit`)
      .all(p);
    return rows.map((r) => this.rowToMsg(r)).sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Turn a free-text query into a safe FTS5 MATCH expression (AND of quoted tokens). */
  static toFtsQuery(q: string): string {
    const tokens = (String(q || "").match(/[\p{L}\p{N}]+/gu) || []).map((t) => `"${t}"`);
    return tokens.join(" ");
  }

  getRaw(chatId: string, id: string): any | null {
    const r: any = this.db
      .prepare("SELECT raw FROM messages WHERE chat_id = ? AND id = ?")
      .get(chatId, id);
    return r?.raw ? JSON.parse(r.raw) : null;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM messages").get() as any).c;
  }

  /** Oldest stored message in a chat — anchor for history backfill. */
  oldestInChat(chatId: string): { id: string; sender: string; isFromMe: boolean; timestamp: number } | null {
    const r: any = this.db
      .prepare("SELECT id, sender, is_from_me, timestamp FROM messages WHERE chat_id = ? ORDER BY timestamp ASC LIMIT 1")
      .get(chatId);
    return r ? { id: r.id, sender: r.sender, isFromMe: !!r.is_from_me, timestamp: r.timestamp } : null;
  }

  /** Chat JIDs ordered by most-recent activity (optionally capped). */
  chatsByActivity(limit = 0): string[] {
    const sql =
      "SELECT chat_id FROM messages GROUP BY chat_id ORDER BY MAX(timestamp) DESC" +
      (limit > 0 ? " LIMIT " + Math.floor(limit) : "");
    return this.db.prepare(sql).all().map((r: any) => r.chat_id);
  }

  /**
   * Sandboxed read-only query. Only a single SELECT/WITH statement is allowed;
   * the prepared statement must be read-only. Returns at most `limit` rows.
   */
  query(sql: string, limit = 200): any[] {
    const trimmed = String(sql || "").trim().replace(/;+\s*$/, "");
    if (!trimmed) throw new Error("Empty query");
    if (trimmed.includes(";")) throw new Error("Only a single statement is allowed");
    if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Only SELECT / WITH queries are allowed");
    if (/\b(attach|detach|pragma|insert|update|delete|drop|create|alter|replace|vacuum|reindex)\b/i.test(trimmed)) {
      throw new Error("Only read-only SELECT queries are allowed");
    }
    const stmt = this.db.prepare(trimmed);
    if (!stmt.readonly) throw new Error("Query is not read-only");
    return stmt.all().slice(0, Math.max(1, Math.min(limit, MAX_ROWS)));
  }

  close(): void {
    this.db.close();
  }
}
