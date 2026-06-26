/**
 * Full-text search over the local (SQLite-backed) WhatsApp message store,
 * including synced history. Backed by SQLite FTS5.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WhatsAppClient } from "../services/whatsapp-client.js";
import { SearchMessagesInputSchema, type SearchMessagesInput } from "../schemas/index.js";

export function registerSearchMessagesTool(server: McpServer, client: WhatsAppClient): void {
  server.registerTool(
    "whatsapp_search_messages",
    {
      title: "Search WhatsApp Messages",
      description: `Full-text search across stored WhatsApp messages (including synced history).

Args:
  - query (string): search terms, matched against message text (FTS5).
  - chat_id (string, optional): restrict to one chat JID.
  - sender (string, optional): restrict to a sender JID, or "me".
  - after / before (number, optional): Unix-second bounds.
  - limit (number): max matches (1-100, default 20).

Returns: matching messages with timestamp, sender, chat, and text.`,
      inputSchema: SearchMessagesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchMessagesInput) => {
      try {
        const messages = await client.searchMessages(params.query, {
          chatId: params.chat_id,
          sender: params.sender,
          after: params.after,
          before: params.before,
          limit: params.limit,
        });
        if (messages.length === 0) {
          return { content: [{ type: "text", text: `No messages matched "${params.query}".` }] };
        }
        const lines: string[] = [`# Search results for "${params.query}" (${messages.length})`, ""];
        for (const m of messages) {
          const time = client.formatTimestamp(m.timestamp);
          const sender = m.isFromMe ? "me" : (m.senderName || m.sender);
          lines.push(`- **${time}** ${sender} (${m.chatName}): ${m.text}`);
          lines.push(`  ID: \`${m.id}\`  Chat: \`${m.chatId}\``);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error searching messages: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
