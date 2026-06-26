/**
 * Sandboxed read-only SQL over the local message database, for analytics
 * ("who do I message most", "messages per month", etc.). Only a single
 * SELECT/WITH statement is allowed; writes/PRAGMA/multi-statement are rejected.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WhatsAppClient } from "../services/whatsapp-client.js";
import { QueryMessagesInputSchema, type QueryMessagesInput } from "../schemas/index.js";

const jsonSafe = (_k: string, v: any) => (typeof v === "bigint" ? Number(v) : v);

export function registerQueryTool(server: McpServer, client: WhatsAppClient): void {
  server.registerTool(
    "whatsapp_query",
    {
      title: "Query WhatsApp Messages (read-only SQL)",
      description: `Run a read-only SQL query over the local WhatsApp message database for analytics.

Table: messages(
  id, chat_id, sender, sender_name,
  timestamp  -- Unix seconds,
  text, is_from_me, is_group, type, media
)

Rules: a single SELECT or WITH statement only. INSERT/UPDATE/DELETE/DROP/PRAGMA/ATTACH and multiple statements are rejected.

Examples:
  SELECT sender_name, COUNT(*) AS n FROM messages WHERE is_from_me=0 GROUP BY sender ORDER BY n DESC LIMIT 10
  SELECT strftime('%Y-%m', timestamp, 'unixepoch') AS month, COUNT(*) AS n FROM messages GROUP BY month ORDER BY month`,
      inputSchema: QueryMessagesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: QueryMessagesInput) => {
      try {
        const rows = await client.queryMessages(params.sql, params.limit);
        const body = rows.length
          ? "```json\n" + JSON.stringify(rows, jsonSafe, 2) + "\n```"
          : "_(0 rows)_";
        return { content: [{ type: "text", text: `# ${rows.length} row(s)\n\n${body}` }] };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Query error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
