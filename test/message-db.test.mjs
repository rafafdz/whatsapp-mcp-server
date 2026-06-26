import test from "node:test";
import assert from "node:assert/strict";
import { MessageDB } from "../dist/services/message-db.js";

function msg(over = {}) {
  return {
    id: over.id ?? "m" + Math.random().toString(36).slice(2),
    chatId: over.chatId ?? "111@s.whatsapp.net",
    sender: over.sender ?? "111@s.whatsapp.net",
    senderName: over.senderName ?? "Alice",
    timestamp: over.timestamp ?? 1700000000,
    text: over.text ?? "hello world",
    isFromMe: over.isFromMe ?? false,
    isGroup: over.isGroup ?? false,
    type: over.type ?? "text",
    ...(over.media ? { media: over.media } : {}),
  };
}

function freshDb() {
  return new MessageDB(":memory:");
}

test("add + count, and (chat_id,id) dedup is a no-op", () => {
  const db = freshDb();
  db.add(msg({ id: "a", text: "first" }));
  db.add(msg({ id: "b", text: "second" }));
  db.add(msg({ id: "a", text: "DUPLICATE - should be ignored" }));
  assert.equal(db.count(), 2);
  db.close();
});

test("list filters by chat + date range and returns ascending", () => {
  const db = freshDb();
  db.addMany([
    { m: msg({ id: "1", chatId: "A", timestamp: 100 }) },
    { m: msg({ id: "2", chatId: "A", timestamp: 300 }) },
    { m: msg({ id: "3", chatId: "A", timestamp: 200 }) },
    { m: msg({ id: "4", chatId: "B", timestamp: 250 }) },
  ]);
  const all = db.list({ chatId: "A" });
  assert.deepEqual(all.map((m) => m.id), ["1", "3", "2"]); // ascending by timestamp
  const windowed = db.list({ chatId: "A", after: 150, before: 250 });
  assert.deepEqual(windowed.map((m) => m.id), ["3"]);
  // limit returns the most-recent N (then ascending)
  const recent = db.list({ chatId: "A", limit: 2 });
  assert.deepEqual(recent.map((m) => m.id), ["3", "2"]);
  db.close();
});

test("FTS search finds messages by keyword, scoped + filtered", () => {
  const db = freshDb();
  db.addMany([
    { m: msg({ id: "1", chatId: "A", text: "lunch at the new ramen place" }) },
    { m: msg({ id: "2", chatId: "A", text: "sending the invoice tomorrow" }) },
    { m: msg({ id: "3", chatId: "B", text: "ramen tonight?" , timestamp: 1700000500 }) },
  ]);
  const ramen = db.search({ query: "ramen" });
  assert.deepEqual(ramen.map((m) => m.id).sort(), ["1", "3"]);
  const ramenInA = db.search({ query: "ramen", chatId: "A" });
  assert.deepEqual(ramenInA.map((m) => m.id), ["1"]);
  const none = db.search({ query: "nonexistentword" });
  assert.equal(none.length, 0);
  db.close();
});

test("oldestInChat + chatsByActivity (backfill helpers)", () => {
  const db = freshDb();
  db.addMany([
    { m: msg({ id: "1", chatId: "A", timestamp: 300 }) },
    { m: msg({ id: "2", chatId: "A", timestamp: 100, sender: "x@s.whatsapp.net", isFromMe: false }) },
    { m: msg({ id: "3", chatId: "B", timestamp: 500 }) },
  ]);
  const oldestA = db.oldestInChat("A");
  assert.equal(oldestA.id, "2");
  assert.equal(oldestA.timestamp, 100);
  assert.equal(db.oldestInChat("ZZZ"), null);
  // B is more recently active (ts 500) than A (300) → comes first
  assert.deepEqual(db.chatsByActivity(), ["B", "A"]);
  assert.deepEqual(db.chatsByActivity(1), ["B"]);
  db.close();
});

test("read-only query allows SELECT and blocks writes", () => {
  const db = freshDb();
  db.addMany([
    { m: msg({ id: "1", sender: "x", text: "a" }) },
    { m: msg({ id: "2", sender: "x", text: "b" }) },
    { m: msg({ id: "3", sender: "y", text: "c" }) },
  ]);
  const rows = db.query("SELECT sender, COUNT(*) AS n FROM messages GROUP BY sender ORDER BY n DESC");
  assert.equal(rows[0].sender, "x");
  assert.equal(rows[0].n, 2);
  for (const bad of [
    "DELETE FROM messages",
    "UPDATE messages SET text='x'",
    "DROP TABLE messages",
    "SELECT 1; DELETE FROM messages",
    "PRAGMA table_info(messages)",
  ]) {
    assert.throws(() => db.query(bad), /allowed|read-only|single statement/i, `should reject: ${bad}`);
  }
  // count must be unchanged by the rejected statements
  assert.equal(db.count(), 3);
  db.close();
});
