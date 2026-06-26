/**
 * WhatsApp media download tool.
 *
 * Downloads attachments (including voice notes) for messages observed by this server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WhatsAppClient } from "../services/whatsapp-client.js";
import { DownloadMediaInputSchema, type DownloadMediaInput } from "../schemas/index.js";

export function registerDownloadMediaTool(server: McpServer, client: WhatsAppClient): void {
  server.registerTool(
    "whatsapp_download_media",
    {
      title: "Download WhatsApp Media",
      description: `Download a message's media (PDF, image, audio, video, document) to disk and return its path.

PREFERRED over whatsapp_get_media for reading file contents: the download
directory (env WHATSAPP_DOWNLOAD_DIR) is a shared volume mounted into your
code-execution/terminal environment at the SAME path, so the returned 'Path' is
directly readable from your terminal — open/parse it there (e.g. extract a PDF
with pypdf) instead of fetching base64. Only fall back to whatsapp_get_media
(base64) if the returned path is not accessible from your environment.

Notes:
  - Media is fetched on demand; if WhatsApp's CDN expired it, your phone is asked
    to re-upload (works only if the phone still has the file & is online).
  - Use whatsapp_list_messages / whatsapp_search_messages to get message_id + chat_id.

Args:
  - chat_id (string): Chat JID
  - message_id (string): Message ID
  - output_dir (string, optional): Override the directory to write to ("~/" expands)

Returns:
  - path: Absolute path to the downloaded file (read this directly)
  - media: Metadata (kind, mimetype, fileName, bytes, etc.)`,
      inputSchema: DownloadMediaInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: DownloadMediaInput) => {
      try {
        const result = await client.downloadMedia(params.chat_id, params.message_id, params.output_dir);
        return {
          content: [{
            type: "text",
            text: `Downloaded media successfully.\n\nPath: ${result.path}\nKind: ${result.media.kind}${result.media.isVoiceNote ? " (voice-note)" : ""}\nMIME: ${result.media.mimetype || "unknown"}\nFile: ${result.media.fileName || "unknown"}\nBytes: ${result.media.fileLength ?? "unknown"}\nSeconds: ${result.media.seconds ?? "unknown"}`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error downloading media: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );
}

