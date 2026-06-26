#!/usr/bin/env node
/**
 * WhatsApp MCP Server
 *
 * An MCP server that provides WhatsApp messaging capabilities via Baileys.
 * Connects to WhatsApp Web protocol and exposes tools for listing chats,
 * sending messages, and getting group information.
 *
 * Authentication: On first run, a QR code is displayed in the terminal.
 * Scan it with your phone (WhatsApp > Linked Devices > Link a Device).
 * The session is persisted so you only need to scan once.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { WhatsAppClient } from "./services/whatsapp-client.js";
import { registerStatusTool } from "./tools/status.js";
import { registerChatsTool } from "./tools/chats.js";
import { registerSendMessageTool } from "./tools/send-message.js";
import { registerGroupInfoTool } from "./tools/group-info.js";
import { registerListMessagesTool } from "./tools/list-messages.js";
import { registerDownloadMediaTool } from "./tools/download-media.js";
import { registerSendFileTool } from "./tools/send-file.js";
import { registerGetMediaTool } from "./tools/get-media.js";
import { registerSearchMessagesTool } from "./tools/search-messages.js";
import { registerQueryTool } from "./tools/query.js";

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline/promises";


type TransportMode = "stdio" | "http";

// ── Upload endpoint helpers ───────────────────────────────────────────

const UPLOAD_MAX_BYTES = Number.parseInt(process.env.WHATSAPP_UPLOAD_MAX_SIZE || "", 10) || 50 * 1024 * 1024; // 50 MB
const UPLOAD_DIR = process.env.WHATSAPP_UPLOAD_DIR || "/tmp/whatsapp-uploads";
const UPLOAD_TTL_MS = 60 * 60 * 1000; // 1 hour
const UPLOAD_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function ensureUploadDir(): Promise<void> {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}

async function cleanupUploads(): Promise<void> {
  try {
    const entries = await fsp.readdir(UPLOAD_DIR);
    const now = Date.now();
    for (const entry of entries) {
      const filePath = path.join(UPLOAD_DIR, entry);
      try {
        const stat = await fsp.stat(filePath);
        if (now - stat.mtimeMs > UPLOAD_TTL_MS) {
          await fsp.unlink(filePath);
        }
      } catch { /* file may have been deleted concurrently */ }
    }
  } catch { /* upload dir may not exist yet */ }
}

/**
 * Minimal multipart/form-data parser.
 * Extracts the first file part and streams it to disk.
 * Returns the original filename from the Content-Disposition header.
 */
async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  if (!boundaryMatch) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Missing multipart boundary" }));
    return;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const delimiterBuf = Buffer.from(`--${boundary}`);

  // Collect the full body (bounded by max upload size).
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += buf.length;
    if (totalBytes > UPLOAD_MAX_BYTES) {
      res.statusCode = 413;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: `File exceeds maximum size of ${UPLOAD_MAX_BYTES} bytes` }));
      return;
    }
    chunks.push(buf);
  }

  const body = Buffer.concat(chunks);

  // Find the first part after the initial boundary.
  const firstBoundaryIdx = body.indexOf(delimiterBuf);
  if (firstBoundaryIdx === -1) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "No multipart boundary found in body" }));
    return;
  }

  // Find the end of headers (double CRLF).
  const headersStart = firstBoundaryIdx + delimiterBuf.length + 2; // skip boundary + CRLF
  const headerEndIdx = body.indexOf(Buffer.from("\r\n\r\n"), headersStart);
  if (headerEndIdx === -1) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Malformed multipart headers" }));
    return;
  }

  const headerBlock = body.subarray(headersStart, headerEndIdx).toString("utf8");
  const fileDataStart = headerEndIdx + 4; // skip \r\n\r\n

  // Find the closing boundary.
  const closingBoundary = Buffer.from(`\r\n--${boundary}`);
  const fileDataEnd = body.indexOf(closingBoundary, fileDataStart);
  const fileData = fileDataEnd !== -1 ? body.subarray(fileDataStart, fileDataEnd) : body.subarray(fileDataStart);

  // Extract filename from Content-Disposition header.
  const filenameMatch = headerBlock.match(/filename="([^"]+)"/);
  const originalName = filenameMatch ? path.basename(filenameMatch[1]) : "upload";

  // Sanitize filename: keep only safe characters.
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const destName = `${randomUUID()}-${safeName}`;
  const destPath = path.join(UPLOAD_DIR, destName);

  await fsp.writeFile(destPath, fileData);

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path: destPath, size: fileData.length, name: originalName }));
}

/**
 * Serves a file from an allowed directory via HTTP GET.
 * Only files inside UPLOAD_DIR or the downloads directory are served.
 */
const DOWNLOAD_ALLOWED_PREFIXES: string[] = []; // populated at startup

async function handleDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const filePath = reqUrl.searchParams.get("path");
  if (!filePath) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Missing ?path= query parameter" }));
    return;
  }

  const resolved = path.resolve(filePath);

  // Security: only serve files from allowed directories.
  const allowed = DOWNLOAD_ALLOWED_PREFIXES.some((prefix) => resolved.startsWith(prefix + path.sep) || resolved.startsWith(prefix + "/"));
  if (!allowed) {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Path not in an allowed directory" }));
    return;
  }

  try {
    await fsp.access(resolved, fs.constants.R_OK);
  } catch {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "File not found" }));
    return;
  }

  const stat = await fsp.stat(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
    ".mp4": "video/mp4", ".webm": "video/webm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
  };

  res.statusCode = 200;
  res.setHeader("content-type", mimeTypes[ext] || "application/octet-stream");
  res.setHeader("content-length", stat.size);
  res.setHeader("content-disposition", `attachment; filename="${path.basename(resolved)}"`);
  fs.createReadStream(resolved).pipe(res);
}

function createMcpServer(client: WhatsAppClient): McpServer {
  const server = new McpServer({
    name: "whatsapp-mcp-server",
    version: "0.1.0",
  });

  registerStatusTool(server, client);
  registerChatsTool(server, client);
  registerSendMessageTool(server, client);
  registerGroupInfoTool(server, client);
  registerListMessagesTool(server, client);
  registerDownloadMediaTool(server, client);
  registerSendFileTool(server, client);
  registerGetMediaTool(server, client);
  registerSearchMessagesTool(server, client);
  registerQueryTool(server, client);

  return server;
}

function resolveAuthDir(): string {
  const raw = process.env.WHATSAPP_AUTH_DIR;
  if (raw) {
    return raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  }
  return path.join(os.homedir(), ".whatsapp-mcp", "auth");
}

function resolveTransportMode(): TransportMode {
  const raw = (process.env.WHATSAPP_MCP_TRANSPORT || "stdio").trim().toLowerCase();
  if (!raw || raw === "stdio") return "stdio";
  if (raw === "http" || raw === "streamable-http" || raw === "streamable_http" || raw === "streamablehttp") {
    return "http";
  }
  throw new Error(`Invalid WHATSAPP_MCP_TRANSPORT: ${raw}. Expected "stdio" or "http".`);
}

function resolveHttpHost(): string {
  return (process.env.WHATSAPP_HTTP_HOST || "127.0.0.1").trim();
}

function resolveHttpPort(): number {
  const raw = (process.env.WHATSAPP_HTTP_PORT || "8787").trim();
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid WHATSAPP_HTTP_PORT: ${raw}. Expected integer 1-65535.`);
  }
  return port;
}

function resolveHttpPath(): string {
  const raw = (process.env.WHATSAPP_HTTP_PATH || "/mcp").trim();
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withLeadingSlash === "/") return withLeadingSlash;
  return withLeadingSlash.replace(/\/+$/, "");
}

function parseRelinkMode(): "backup" | "delete" | null {
  const raw = (process.env.WHATSAPP_RELINK || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "y" || raw === "backup") return "backup";
  if (raw === "delete" || raw === "wipe" || raw === "remove") return "delete";
  return null;
}

function backupSuffix(): string {
  // "2026-02-15T17-01-02Z"
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function backupDir(srcDir: string): Promise<string> {
  const dstDir = `${srcDir}.backup-${backupSuffix()}`;
  try {
    await fsp.rename(srcDir, dstDir);
    return dstDir;
  } catch {
    // Fallback for cases where rename fails: copy + remove.
    await fsp.cp(srcDir, dstDir, { recursive: true, errorOnExist: true });
    await fsp.rm(srcDir, { recursive: true, force: true });
    return dstDir;
  }
}

async function maybeRelinkAuthDir(authDir: string): Promise<void> {
  const credsPath = path.join(authDir, "creds.json");
  const hasCreds = fs.existsSync(credsPath);
  if (!hasCreds) return;

  const nonInteractiveMode = parseRelinkMode();
  if (nonInteractiveMode) {
    console.error(`Existing WhatsApp auth found at ${authDir} (WHATSAPP_RELINK=${nonInteractiveMode}).`);
    if (nonInteractiveMode === "delete") {
      await fsp.rm(authDir, { recursive: true, force: true });
      return;
    }
    const backup = await backupDir(authDir);
    console.error(`Backed up existing auth dir to ${backup}`);
    return;
  }

  // Only prompt when run manually; never block MCP clients (stdin is a pipe).
  if (!process.stdin.isTTY) return;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error(`Existing WhatsApp auth found at: ${authDir}`);
    const relink = (await rl.question("Create a new WhatsApp link (QR code)? (y/N): ")).trim().toLowerCase();
    if (!(relink === "y" || relink === "yes")) return;

    const action = (await rl.question("What to do with existing auth dir? [b]ackup/[d]elete/[c]ancel (default: backup): "))
      .trim()
      .toLowerCase();

    if (action === "d" || action === "delete") {
      await fsp.rm(authDir, { recursive: true, force: true });
      console.error("Deleted existing auth dir.");
      return;
    }
    if (action === "c" || action === "cancel") {
      console.error("Cancelled. Keeping existing auth.");
      return;
    }

    const backup = await backupDir(authDir);
    console.error(`Backed up existing auth dir to ${backup}`);
  } finally {
    rl.close();
  }
}

function shouldExitAfterPair(): boolean {
  const raw = (process.env.WHATSAPP_EXIT_AFTER_PAIR || "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "y") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "n") return false;
  // Default: only for manual runs in a real terminal; never for stdio-spawned MCP clients.
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function sendJsonError(res: ServerResponse, statusCode: number, message: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message,
      },
      id: null,
    }),
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const bufferChunk = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(bufferChunk);
    totalBytes += bufferChunk.length;
    if (totalBytes > 1_000_000) {
      throw new Error("Request body too large");
    }
  }

  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON request body");
  }
}

function getSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  if (Array.isArray(header)) return header[0];
  return header;
}

async function startHttpTransport(client: WhatsAppClient, authDir: string): Promise<void> {
  const host = resolveHttpHost();
  const port = resolveHttpPort();
  const mcpPath = resolveHttpPath();
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  // Configure allowed download directories.
  const downloadsDir = path.resolve(path.join(authDir, "..", "downloads"));
  DOWNLOAD_ALLOWED_PREFIXES.push(path.resolve(UPLOAD_DIR), downloadsDir, "/tmp");

  // Ensure upload directory exists and start periodic cleanup.
  await ensureUploadDir();
  const cleanupTimer = setInterval(() => void cleanupUploads(), UPLOAD_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref(); // Don't keep the process alive just for cleanup.

  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

        // ── File upload endpoint ────────────────────────────────
        if (reqUrl.pathname === "/upload" && (req.method || "").toUpperCase() === "POST") {
          await handleUpload(req, res);
          return;
        }

        // ── File download endpoint ──────────────────────────────
        if (reqUrl.pathname === "/download" && (req.method || "").toUpperCase() === "GET") {
          await handleDownload(req, res);
          return;
        }

        if (reqUrl.pathname !== mcpPath) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }

        const method = (req.method || "GET").toUpperCase();
        const parsedBody = method === "POST" ? await readJsonBody(req) : undefined;
        const sessionId = getSessionId(req);

        let entry = sessionId ? sessions.get(sessionId) : undefined;

        if (!entry) {
          if (sessionId) {
            sendJsonError(res, 404, "Unknown MCP session id");
            return;
          }
          if (method !== "POST" || !isInitializeRequest(parsedBody)) {
            sendJsonError(res, 400, "No active MCP session. Send initialize first.");
            return;
          }

          const server = createMcpServer(client);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, { server, transport });
            },
            onsessionclosed: async (closedSessionId) => {
              const closed = sessions.get(closedSessionId);
              sessions.delete(closedSessionId);
              if (closed) {
                try {
                  await closed.server.close();
                } catch (error) {
                  console.error("Failed to close MCP session server:", error);
                }
              }
            },
          });

          await server.connect(transport);
          entry = { server, transport };
        }

        await entry.transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        console.error("HTTP transport request failed:", error);
        if (!res.headersSent) {
          sendJsonError(res, 500, "Internal server error");
        } else {
          res.destroy();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  console.error(`WhatsApp MCP server running via streamable HTTP at http://${host}:${port}${mcpPath}`);
  console.error(`File upload endpoint available at http://${host}:${port}/upload`);
  console.error(`File download endpoint available at http://${host}:${port}/download?path=...`);
}

async function main(): Promise<void> {
  // Initialize WhatsApp client
  const authDir = resolveAuthDir();
  await maybeRelinkAuthDir(authDir);
  const client = new WhatsAppClient(authDir);
  const transportMode = resolveTransportMode();
  const exitAfterPair = shouldExitAfterPair();
  let sawQrThisRun = false;
  let exitScheduled = false;

  client.onConnection((status) => {
    if (status.qrCode) {
      sawQrThisRun = true;
    }
    if (exitAfterPair && sawQrThisRun && status.connected && !exitScheduled) {
      exitScheduled = true;
      console.error("WhatsApp pairing complete. Exiting (session saved).");
      setTimeout(() => process.exit(0), 1000);
    }
    if (status.connected && !exitScheduled) {
      client.loadRawMessageStore();
    }
  });

  // Start WhatsApp connection (runs in background)
  console.error("Starting WhatsApp connection...");
  client.connect().catch((error) => {
    console.error("WhatsApp connection error:", error);
  });

  if (transportMode === "stdio") {
    const server = createMcpServer(client);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("WhatsApp MCP server running via stdio");
    return;
  }

  await startHttpTransport(client, authDir);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
