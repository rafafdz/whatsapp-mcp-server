# WhatsApp MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that connects Claude and other LLM clients to WhatsApp. Built on top of the [Baileys](https://github.com/WhiskeySockets/Baileys) library, which implements the WhatsApp Web protocol natively — no browser automation required.

## Features

- **`whatsapp_get_status`** — Check connection status (connected, waiting for QR, error)
- **`whatsapp_list_chats`** — List available chats and groups with metadata
- **`whatsapp_list_messages`** — List recent messages from the server's local store (observed while running; optional persistence)
- **`whatsapp_send_message`** — Send text messages to contacts or groups
- **`whatsapp_send_file`** — Send files/media (document/image/video/audio/voice note)
- **`whatsapp_get_media`** — Get media directly as Base64 without local download (new!)
- **`whatsapp_download_media`** — Download attachments (including voice notes) to local file
- **`whatsapp_get_group_info`** — Get group details, participants, and admin info

## Prerequisites

- **Node.js** >= 18
- **A WhatsApp account** linked to a phone
- **An MCP-compatible client** (Claude Desktop, Claude Code, etc.)

> **Compatibility:** Works with both **regular WhatsApp** and **WhatsApp Business** accounts. Baileys implements the WhatsApp Web Multi-Device protocol, which is identical for both account types. Business-specific features (catalogs, auto-replies, labels) are not supported by this server.

> **Important:** This server requires `@whiskeysockets/baileys@^7.0.0-rc.9` or later. Older versions may fail to generate valid QR codes for new device linking.


## Quick Start

### 1. Clone and Build

```bash
git clone https://github.com/ydmw74/whatsapp-mcp-server.git
cd whatsapp-mcp-server
npm install
npm run build
```

### 2. First Run — QR Code Authentication

Run the server once manually to complete the QR code pairing:

```bash
node dist/index.js
```

A QR code will appear in your terminal. Scan it with your phone:

**WhatsApp > Settings > Linked Devices > Link a Device**

After successful pairing, the session is persisted in `~/.whatsapp-mcp/auth`. You won't need to scan again unless you unlink the device.

> Note: To use `whatsapp_list_messages`, keep the server running while messages arrive. The server can only list messages it has observed (and optionally persisted).

### 3. Configure Your MCP Client

#### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-mcp-server/dist/index.js"]
    }
  }
}
```

#### Claude Code

```bash
claude mcp add whatsapp node /absolute/path/to/whatsapp-mcp-server/dist/index.js
```

### 4. Optional: Shared HTTP Mode (Single Server Process)

If you want one long-running MCP server process for multiple clients, run in HTTP mode:

```bash
WHATSAPP_MCP_TRANSPORT=http WHATSAPP_HTTP_HOST=127.0.0.1 WHATSAPP_HTTP_PORT=8787 WHATSAPP_HTTP_PATH=/mcp node dist/index.js
```

Or with npm script:

```bash
WHATSAPP_HTTP_HOST=127.0.0.1 WHATSAPP_HTTP_PORT=8787 WHATSAPP_HTTP_PATH=/mcp npm run start:http
```

Then configure your MCP client to use the URL endpoint (Streamable HTTP), for example with Codex:

```bash
codex mcp add whatsapp --url http://127.0.0.1:8787/mcp
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `WHATSAPP_AUTH_DIR` | `~/.whatsapp-mcp/auth` | Directory for session persistence |
| `WHATSAPP_DEVICE_NAME` | *(unset)* | Optional linked-device label shown in WhatsApp ("Linked devices"), e.g. `WHATSAPP_DEVICE_NAME=MyAgent-1` (will show like `MyAgent-1 (Mac OS)` or `... (Ubuntu)`). |
| `WHATSAPP_RELINK` | *(unset)* | Force re-linking in non-interactive environments. Use `backup` (or `1`/`true`) to move the existing auth dir aside, or `delete` to remove it. |
| `WHATSAPP_EXIT_AFTER_PAIR` | `auto` | If a QR code was shown in this run, exit automatically after successful pairing. Defaults to enabled only for interactive terminal runs (TTY). |
| `WHATSAPP_PERSIST_MESSAGES` | `false` | Persist the local message store to disk (`message-store.json`). |
| `WHATSAPP_MAX_MESSAGES_PER_CHAT` | `200` | Retention limit per chat for the local message store. |
| `WHATSAPP_MAX_MESSAGES_TOTAL` | `2000` | Global retention limit for the local message store. |
| `WHATSAPP_MCP_TRANSPORT` | `stdio` | MCP transport mode: `stdio` or `http` (`http` = Streamable HTTP server). |
| `WHATSAPP_HTTP_HOST` | `127.0.0.1` | Bind address for HTTP mode. Use `0.0.0.0` if clients connect from other hosts. |
| `WHATSAPP_HTTP_PORT` | `8787` | TCP port for HTTP mode. |
| `WHATSAPP_HTTP_PATH` | `/mcp` | HTTP endpoint path for MCP requests. |
| `WHATSAPP_UPLOAD_DIR` | `/tmp/whatsapp-uploads` | Directory for uploaded files (HTTP mode). |
| `WHATSAPP_UPLOAD_MAX_SIZE` | `52428800` | Max upload file size in bytes (default: 50 MB). |

## Tools Reference

### `whatsapp_get_status`

Check if WhatsApp is connected and ready.

**Parameters:** None

**Returns:** Connection status, phone number, or QR code if authentication is pending.

### `whatsapp_list_chats`

List available WhatsApp chats.

**Parameters:**
- `limit` (number, 1-100, default: 20) — Maximum chats to return

**Returns:** List of chats with ID, name, type (group/DM), and unread count.

### `whatsapp_list_messages`

List recent messages from the server's local message store.

**Parameters:**
- `chat_id` (string, optional) — Chat JID (DM or group). If omitted, returns recent messages across all chats.
- `limit` (number, 1-100, default: 20) — Maximum number of messages to return

**Returns:** A formatted list of messages with timestamp, sender, and text.

**Notes:**
- Only messages observed by the running server are available.
- To keep messages across restarts, set `WHATSAPP_PERSIST_MESSAGES=1` (stores `message-store.json` next to the auth dir).
- If a message includes media, the list includes basic media metadata (kind, mimetype, etc.). Use `whatsapp_download_media` to download the attachment.

### `whatsapp_send_message`

Send a text message.

**Parameters:**
- `chat_id` (string) — Phone number with country code (e.g., `4915123456789`) or full JID
- `text` (string) — Message text (max 4096 chars)

**Returns:** Message ID and timestamp.

### `whatsapp_send_file`

Send a file/media message (document/image/video/audio/voice note).

**Parameters:**
- `chat_id` (string) — Phone number with country code or full JID
- `path` (string) — Local file path (supports `~/` expansion)
- `kind` (string, optional) — `document|image|video|audio|voice` (default: `document`)
- `caption` (string, optional) — Caption (image/video/document)
- `mimetype` (string, optional) — MIME type override
- `fileName` (string, optional) — File name override (document only)

**Returns:** Message ID and timestamp.

### `whatsapp_download_media`

Download an attachment (including voice notes) from a message that the server has observed.

**Parameters:**
- `chat_id` (string) — Chat JID (from `whatsapp_list_messages`)
- `message_id` (string) — Message ID (from `whatsapp_list_messages`)
- `output_dir` (string, optional) — Directory to write the file to (supports `~/` expansion)

**Returns:** Absolute file `path` and `media` metadata.

### `whatsapp_get_media`

Get media (attachments) directly from the server as Base64 without saving to disk.

**Parameters:**
- `chat_id` (string) — Chat JID (from `whatsapp_list_messages`)
- `message_id` (string) — Message ID (from `whatsapp_list_messages`)
- `format` (string, optional) — Return format: `"base64"` for raw base64 (default) or `"data_url"` for image data URL

**Returns:** Base64 encoded media and `media` metadata.

**Notes:**
- Only works for messages observed by the server since it started
- No local file download required
- Supports images, videos, documents, audio, and voice notes

### `whatsapp_get_group_info`

Get detailed group information.

**Parameters:**
- `group_id` (string) — Group JID (e.g., `120363012345678901@g.us`)

**Returns:** Group subject, description, participant list with admin status.

## HTTP File Transfer Endpoints (HTTP Mode)

When running in HTTP mode, the server provides two additional endpoints for remote file transfer. These are essential for remote MCP clients that cannot access the server filesystem directly.

### `POST /upload` — Upload a file to the server

```bash
curl -s -F "file=@/local/path/photo.jpg" http://server:8787/upload
```

**Response:**
```json
{"path": "/tmp/whatsapp-uploads/a1b2c3d4-photo.jpg", "size": 123456, "name": "photo.jpg"}
```

Use the returned `path` with `whatsapp_send_file`. Files are auto-cleaned after 1 hour.

### `GET /download?path=...` — Download a file from the server

```bash
curl -s -o local-file.jpg "http://server:8787/download?path=/root/whatsapp-mcp-data/downloads/whatsapp-ABC123.jpeg"
```

Only serves files from allowed directories (`/tmp`, uploads dir, downloads dir) to prevent arbitrary file access.

**Typical workflow:**
1. `whatsapp_download_media` → returns a server-local path
2. `GET /download?path=<server-path>` → download the file to your local machine

## How It Works

By default (`WHATSAPP_MCP_TRANSPORT=stdio`), your MCP client (Claude Desktop, Claude Code, etc.) launches and manages the server process automatically in the background.

When you open a chat in Claude Desktop, it spawns `node dist/index.js` as a child process and communicates with it over **stdio** (stdin/stdout). When you close the chat, the process is stopped. You don't need to manage it yourself.

The **only manual step** is the one-time QR code authentication (see Quick Start, Step 2). After that, the session is persisted to disk and the server reconnects automatically on every subsequent start.

In HTTP mode (`WHATSAPP_MCP_TRANSPORT=http`), you run one persistent server process and clients connect to it via URL (for example `http://server:8787/mcp`).

## Architecture

`stdio` mode (local child process):

```
┌──────────────────┐     stdio      ┌──────────────────┐
│  Claude / LLM    │ ◄──────────── │  MCP Server      │
│  Client          │ ──────────── │  (this project)  │
└──────────────────┘               └────────┬─────────┘
                                            │
                                   Baileys Protocol
                                            │
                                   ┌────────▼─────────┐
                                   │  WhatsApp Web    │
                                   │  Servers         │
                                   └──────────────────┘
```

`http` mode (shared daemon):

```
┌──────────────────┐      HTTP      ┌──────────────────┐
│  MCP Client A    │ ────────────► │                  │
├──────────────────┤                │  MCP Server      │
│  MCP Client B    │ ────────────► │  (single process)│
└──────────────────┘                └────────┬─────────┘
                                             │
                                    Baileys Protocol
                                             │
                                    ┌────────▼─────────┐
                                    │  WhatsApp Web    │
                                    │  Servers         │
                                    └──────────────────┘
```

Session state is persisted to disk so re-authentication is only needed once.

## PM2 Deployment (Linux, Shared in Network)

This is the recommended setup if you want a single MCP server running on a dedicated Linux host in your LAN.

> **Important:** Baileys 7.x (this project requires `^7.0.0-rc.9`) is required for QR code authentication to work properly. If you encounter QR code issues, ensure you have the correct Baileys version installed.

### 0. Fresh server preflight (if Node.js/npm are missing)

On a fresh Debian host, install required base packages first:

```bash
apt-get update -y
apt-get install -y nodejs npm git rsync
```

### 1. Install PM2

```bash
npm install -g pm2
```

### 2. Build the server

```bash
cd /home/<linux-user>/whatsapp-mcp-server
npm install
npm run build
```

### 3. Start MCP server with PM2 (HTTP mode)

Bind to all interfaces (`0.0.0.0`) if clients connect from other machines:

```bash
WHATSAPP_MCP_TRANSPORT=http \
WHATSAPP_HTTP_HOST=0.0.0.0 \
WHATSAPP_HTTP_PORT=8787 \
WHATSAPP_HTTP_PATH=/mcp \
WHATSAPP_AUTH_DIR=/home/<linux-user>/whatsapp-mcp-data/auth \
pm2 start node --name whatsapp-mcp -- dist/index.js
```

You can also use:

```bash
WHATSAPP_HTTP_HOST=0.0.0.0 WHATSAPP_HTTP_PORT=8787 WHATSAPP_HTTP_PATH=/mcp pm2 start npm --name whatsapp-mcp -- run start:http
```

Recommended (path-independent): use the included PM2 config file:

```bash
cd /home/<linux-user>/whatsapp-mcp-server
pm2 start ecosystem.config.cjs
```

The provided `ecosystem.config.cjs` uses:

- `cwd: __dirname` (works regardless of clone directory)
- `WHATSAPP_AUTH_DIR` dynamically from the current Linux user's home directory, e.g. `/home/<linux-user>/whatsapp-mcp-data/auth`

### 4. Persist PM2 across reboot

```bash
pm2 startup
pm2 save
```

### 5. Useful PM2 commands

```bash
pm2 status
pm2 logs whatsapp-mcp
pm2 restart whatsapp-mcp
pm2 stop whatsapp-mcp
```

Check the MCP HTTP listener:

```bash
ss -lntp | grep 8787
```

### 5.1 QR code in PM2 logs (scan-friendly output)

PM2 prefixes each line with timestamp/process metadata, which can make the terminal QR hard to scan.
Use the helper script (from repository root) to print the latest complete QR block:

```bash
./scripts/show-whatsapp-qr.sh
```

Optional: pass a different PM2 app name:

```bash
./scripts/show-whatsapp-qr.sh whatsapp-mcp
```

### 6. Connect MCP clients to your Linux host

#### Codex

```bash
codex mcp add whatsapp --url http://<linux-server-ip>:8787/mcp
```

#### Claude Desktop (`claude_desktop_config.json`)

Use [`mcp-remote`](https://github.com/geelen/mcp-remote) to connect Claude Desktop to your remote HTTP server.

> **Important:** `mcp-remote` only allows HTTPS URLs by default. Since the server runs over plain HTTP (no TLS), you **must** add the `--allow-http` flag — otherwise the connection will fail with:
> ```
> Error: Non-HTTPS URLs are only allowed for localhost or when --allow-http flag is provided
> ```

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://<linux-server-ip>:8787/mcp",
        "--allow-http"
      ]
    }
  }
}
```

After editing `claude_desktop_config.json`, restart the Claude Desktop app to apply the changes.

> **Tip:** If your server is accessible via HTTPS (e.g. behind a reverse proxy with TLS), omit the `--allow-http` flag.

#### Claude Code (CLI)

```bash
claude mcp add whatsapp --url http://<linux-server-ip>:8787/mcp
```

### 7. Linking Troubleshooting

- If WhatsApp currently refuses new linked devices, this is usually a temporary WhatsApp-side issue.
- Keep the PM2 process running and retry QR linking later.
- To force a fresh QR attempt:

```bash
pm2 restart whatsapp-mcp
```

### 8. Quick Recovery (copy/paste runbook)

Use these commands in order when the remote deployment is not behaving as expected:

```bash
# 1) Process state
pm2 status whatsapp-mcp

# 2) Recent logs
pm2 logs whatsapp-mcp --lines 100 --nostream

# 3) Ensure HTTP endpoint is listening
ss -lntp | grep 8787

# 4) Restart app and refresh environment
pm2 restart whatsapp-mcp --update-env

# 5) Re-check logs after restart
pm2 logs whatsapp-mcp --lines 100 --nostream
```

If QR output is not scanable in PM2 logs:

```bash
./scripts/show-whatsapp-qr.sh
```

If PM2 is running but not restored after reboot:

```bash
pm2 startup systemd -u root --hp /root
pm2 save
systemctl status pm2-root
```

> Hint: If this server runs in your network, protect access with firewall rules and/or a reverse proxy with authentication/TLS. Do not expose an unauthenticated MCP endpoint directly to the public internet.

## Security Considerations

- **Session data** is stored locally in `~/.whatsapp-mcp/auth`. Protect this directory — anyone with access can impersonate your WhatsApp account.
- **Messages can be stored locally** in memory for `whatsapp_list_messages` (and optionally persisted to `message-store.json`). Treat stored message data as sensitive.
- The LLM client should **always confirm with the user** before sending messages via `whatsapp_send_message`.
- This project uses the unofficial WhatsApp Web protocol. WhatsApp may block accounts that violate their Terms of Service. Use responsibly.

## Limitations

- **Limited message history**: The server lists recent messages that it observed while running (and optionally persisted). It does not fetch arbitrary chat history from WhatsApp.
- **Media downloads are limited to observed messages**: `whatsapp_download_media` can only download media for messages the server has observed since it started (it keeps the raw message in memory for a bounded recent window).
- **Single session**: Only one WhatsApp account can be linked at a time.

## Development

```bash
# Install dependencies
npm install

# Run in development mode (auto-reload)
npm run dev

# Build
npm run build

# Clean build artifacts
npm run clean
```

## Acknowledgements

- [Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web API library
- [OpenClaw](https://github.com/openclaw/openclaw) — Inspiration for the WhatsApp integration architecture
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — Model Context Protocol SDK

## License

MIT
