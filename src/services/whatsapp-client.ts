/**
 * WhatsApp client service using Baileys.
 * Manages connection, authentication, and message operations.
 */

import { Boom } from "@hapi/boom";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { Writable } from "stream";
import pino from "pino";

// Self-healing: force a reconnect when Signal-protocol errors accumulate.
// WhatsApp will kick ALL linked devices if Bad MAC / PreKey errors persist long enough.
const SIGNAL_ERROR_THRESHOLD = parseInt(process.env.WHATSAPP_SIGNAL_ERROR_THRESHOLD || "10", 10);
const SIGNAL_ERROR_WINDOW_MS = parseInt(process.env.WHATSAPP_SIGNAL_ERROR_WINDOW_MS || "120000", 10);

/**
 * Writable stream that passes every byte through to stderr while counting
 * Signal-protocol error patterns. When the count exceeds SIGNAL_ERROR_THRESHOLD
 * within SIGNAL_ERROR_WINDOW_MS milliseconds, onThreshold() is called so the
 * caller can force a clean reconnect before WhatsApp revokes the session.
 */
class SignalErrorMonitor extends Writable {
  private count = 0;
  private windowStart = Date.now();
  private readonly onThreshold: () => void;

  constructor(onThreshold: () => void) {
    super();
    this.onThreshold = onThreshold;
  }

  _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    process.stderr.write(chunk);

    const line = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const isSignalError =
      line.includes("PreKeyError") ||
      line.includes("Bad MAC") ||
      line.includes("failed to decrypt");

    if (isSignalError) {
      const now = Date.now();
      if (now - this.windowStart > SIGNAL_ERROR_WINDOW_MS) {
        this.count = 0;
        this.windowStart = now;
      }
      this.count++;
      if (this.count >= SIGNAL_ERROR_THRESHOLD) {
        this.count = 0;
        this.windowStart = Date.now();
        this.onThreshold();
      }
    }

    callback();
  }
}

const execFileAsync = promisify(execFile);

export interface WhatsAppMessage {
  id: string;
  chatId: string;
  chatName: string;
  sender: string;
  senderName: string;
  timestamp: number;
  text: string;
  isFromMe: boolean;
  isGroup: boolean;
  type: string;
  media?: WhatsAppMedia;
}

export interface WhatsAppMedia {
  kind: "image" | "video" | "document" | "audio" | "sticker" | "unknown";
  mimetype?: string;
  fileName?: string;
  fileLength?: number;
  seconds?: number;
  isVoiceNote?: boolean;
  caption?: string;
}

export interface WhatsAppChat {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessage?: string;
  lastMessageTime?: number;
}

export interface ConnectionStatus {
  connected: boolean;
  qrCode?: string;
  phoneNumber?: string;
  error?: string;
}

type ConnectionCallback = (status: ConnectionStatus) => void;

type StoredMessage = Omit<WhatsAppMessage, "chatName">;

let makeWASocket: any, DisconnectReason: any, Browsers: any, useMultiFileAuthState: any, fetchLatestBaileysVersion: any, makeCacheableSignalKeyStore: any, downloadMediaMessage: any, extensionForMediaMessage: any, normalizeMessageContent: any, getContentType: any;

async function initBaileys() {
  if (!makeWASocket) {
    const baileys = await import("@whiskeysockets/baileys");
    makeWASocket = baileys.default || baileys.makeWASocket;
    DisconnectReason = baileys.DisconnectReason;
    Browsers = baileys.Browsers;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
    downloadMediaMessage = baileys.downloadMediaMessage;
    extensionForMediaMessage = baileys.extensionForMediaMessage;
    normalizeMessageContent = baileys.normalizeMessageContent;
    getContentType = baileys.getContentType;
  }
}

export class WhatsAppClient {
  private socket: any | null = null;
  private authDir: string;
  private persistMessages: boolean;
  private maxMessagesPerChat: number;
  private maxMessagesTotal: number;
  private deviceName?: string;
  private connectionCallbacks: ConnectionCallback[] = [];
  private _status: ConnectionStatus = { connected: false };
  private qrDisplayed = false;
  private chatStore: Map<string, { id: string; name: string; isGroup: boolean; conversationTimestamp?: number }> = new Map();
  private saveChatStoreTimer: NodeJS.Timeout | null = null;
  private saveChatStoreInFlight: Promise<void> = Promise.resolve();
  private messageStore: Map<string, StoredMessage[]> = new Map();
  private rawMessageByKey: Map<string, any> = new Map();
  private saveMessageStoreTimer: NodeJS.Timeout | null = null;
  private saveMessageStoreInFlight: Promise<void> = Promise.resolve();
  private reconnectCount440 = 0;
  private socketGeneration = 0;
  private groupMetadataInFlight: Set<string> = new Set();

  constructor(authDir?: string) {
    const resolvedAuthDir = authDir?.startsWith("~/")
      ? path.join(os.homedir(), authDir.slice(2))
      : authDir;
    // Prefer explicit argument; then env var; then user's home dir. Avoid "~" which Node won't expand.
    const baseDir = process.env.WHATSAPP_AUTH_DIR || path.join(os.homedir(), ".whatsapp-mcp");
    this.authDir = resolvedAuthDir || path.join(baseDir, "auth");

    const persistRaw = (process.env.WHATSAPP_PERSIST_MESSAGES || "").trim().toLowerCase();
    this.persistMessages = persistRaw === "1" || persistRaw === "true" || persistRaw === "yes" || persistRaw === "y";
    this.maxMessagesPerChat = Number(process.env.WHATSAPP_MAX_MESSAGES_PER_CHAT || "200");
    this.maxMessagesTotal = Number(process.env.WHATSAPP_MAX_MESSAGES_TOTAL || "2000");
    this.deviceName = (process.env.WHATSAPP_DEVICE_NAME || "").trim() || undefined;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get isConnected(): boolean {
    return this._status.connected && this.socket !== null;
  }

  onConnection(callback: ConnectionCallback): void {
    this.connectionCallbacks.push(callback);
  }

  private notifyConnection(status: ConnectionStatus): void {
    this._status = status;
    for (const cb of this.connectionCallbacks) {
      cb(status);
    }
  }

  private get chatStoreFile(): string {
    return path.join(this.authDir, '..', 'chat-store.json');
  }

  private get messageStoreFile(): string {
    return path.join(this.authDir, "..", "message-store.json");
  }

  private loadChatStore(): void {
    try {
      const file = this.chatStoreFile;
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        for (const entry of data) {
          this.chatStore.set(entry.id, entry);
        }
        console.error('Loaded ' + this.chatStore.size + ' chats from persistent store');
      }
    } catch (e) {
      console.error('Failed to load chat store: ' + e);
    }
  }

  private loadMessageStore(): void {
    if (!this.persistMessages) return;
    try {
      const file = this.messageStoreFile;
      if (!fs.existsSync(file)) return;
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!Array.isArray(data)) return;
      for (const entry of data) {
        const chatId = entry?.chatId;
        if (!chatId || typeof chatId !== "string") continue;
        const list = this.messageStore.get(chatId) || [];
        list.push(entry as StoredMessage);
        this.messageStore.set(chatId, list);
      }
      this.pruneMessageStore();
      console.error("Loaded message store (" + this.countMessages() + " messages) from persistent store");
    } catch (e) {
      console.error("Failed to load message store: " + e);
    }
  }

  loadRawMessageStore(): void {
    if (!this.persistMessages) return;
    try {
      const file = this.messageStoreFile;
      if (!fs.existsSync(file)) return;
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!Array.isArray(data)) return;
      
      let loadedCount = 0;
      for (const entry of data) {
        const chatId = entry?.chatId;
        const messageId = entry?.id;
        if (!chatId || !messageId || typeof chatId !== "string" || typeof messageId !== "string") continue;
        
        const key = `${chatId}:${messageId}`;
        if (this.rawMessageByKey.has(key)) continue;
        
        const message = {
          key: { remoteJid: chatId, fromMe: entry?.fromMe || false, id: messageId },
          message: entry?.message,
          messageTimestamp: entry?.timestamp,
          messageStubType: entry?.stubType,
          messageTimestampLow: entry?.timestampLow,
          messageTimestampHigh: entry?.timestampHigh,
          pushName: entry?.pushName,
          participant: entry?.participant,
          isForwarded: entry?.isForwarded,
          isViewOnce: entry?.isViewOnce,
        } as any;
        
        this.rawMessageByKey.set(key, message);
        loadedCount++;
      }
      
      if (loadedCount > 0) {
        console.error("Loaded " + loadedCount + " raw messages from persistent store for media downloads");
      }
    } catch (e) {
      console.error("Failed to load raw message store: " + e);
    }
  }

  private scheduleSaveChatStore(): void {
    if (this.saveChatStoreTimer) return;
    this.saveChatStoreTimer = setTimeout(() => {
      this.saveChatStoreTimer = null;
      void this.saveChatStoreAsync();
    }, 250);
  }

  private saveChatStoreAsync(): Promise<void> {
    const file = this.chatStoreFile;
    const data = Array.from(this.chatStore.values());
    const payload = JSON.stringify(data, null, 2);

    // Serialize writes to avoid partial overwrites if multiple writes race.
    this.saveChatStoreInFlight = this.saveChatStoreInFlight
      .catch(() => {
        // Keep the chain alive even if a previous write failed.
      })
      .then(async () => {
        try {
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          const tmp = file + ".tmp";
          await fs.promises.writeFile(tmp, payload, "utf-8");
          await fs.promises.rename(tmp, file);
        } catch (e) {
          console.error("Failed to save chat store: " + e);
        }
      });

    return this.saveChatStoreInFlight;
  }

  private scheduleSaveMessageStore(): void {
    if (!this.persistMessages) return;
    if (this.saveMessageStoreTimer) return;
    this.saveMessageStoreTimer = setTimeout(() => {
      this.saveMessageStoreTimer = null;
      void this.saveMessageStoreAsync();
    }, 500);
  }

  private saveMessageStoreAsync(): Promise<void> {
    if (!this.persistMessages) return Promise.resolve();
    const file = this.messageStoreFile;
    const payload = JSON.stringify(this.flattenMessageStore(), null, 2);

    this.saveMessageStoreInFlight = this.saveMessageStoreInFlight
      .catch(() => {
        // Keep the chain alive even if a previous write failed.
      })
      .then(async () => {
        try {
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          const tmp = file + ".tmp";
          await fs.promises.writeFile(tmp, payload, "utf-8");
          await fs.promises.rename(tmp, file);
        } catch (e) {
          console.error("Failed to save message store: " + e);
        }
      });

    return this.saveMessageStoreInFlight;
  }

  async connect(): Promise<void> {
    try {
      await initBaileys();

      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      // Load persisted chat store on first connect
      if (this.chatStore.size === 0) {
        this.loadChatStore();
      }
      if (this.messageStore.size === 0) {
        this.loadMessageStore();
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      let version: any | undefined;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch (e) {
        console.error("Failed to fetch latest Baileys version, continuing with defaults: " + e);
      }

      // Each connect() gets a unique generation ID
      const generation = ++this.socketGeneration;

      // Create a logger that writes to stderr (stdout is for MCP JSON-RPC).
      // The SignalErrorMonitor passes bytes through to stderr and triggers a
      // proactive reconnect when Signal-protocol errors accumulate — before
      // WhatsApp decides to revoke the session for all linked devices.
      const monitor = new SignalErrorMonitor(() => {
        if (generation !== this.socketGeneration) return;
        console.error(
          `Signal error threshold reached (${SIGNAL_ERROR_THRESHOLD} errors within ${SIGNAL_ERROR_WINDOW_MS / 1000}s) — forcing reconnect to prevent session invalidation`
        );
        this.qrDisplayed = false;
        try {
          this.socket?.end(new Boom("Signal error threshold exceeded", { statusCode: 428 }));
        } catch {
          // If end() throws, fall back to closing the underlying WebSocket.
          try { (this.socket as any)?.ws?.close(); } catch { /* ignore */ }
        }
      });
      const logger = pino({ level: "warn" }, monitor);

      const browser = this.deviceName
        ? Browsers.appropriate(this.deviceName)
        : undefined;

      this.socket = makeWASocket({
        ...(version ? { version } : {}),
        ...(browser ? { browser } : {}),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger as any),
        },
        logger: logger as any,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
      });

      this.socket.ev.on("creds.update", saveCreds);

      this.socket.ev.on("connection.update", (update: any) => {
        const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.notifyConnection({
          connected: false,
          qrCode: qr,
        });
        if (!this.qrDisplayed) {
          try {
            import("qrcode-terminal").then((qrTerminal) => {
              qrTerminal.default.generate(qr, { small: true }, (code: string) => {
                console.error("\n=== WhatsApp QR Code ===");
                console.error("Scan this QR code with your phone:");
                console.error("WhatsApp > Settings > Linked Devices > Link a Device\n");
                console.error(code);
                console.error("========================\n");
              });
            });
          } catch {
            console.error("QR Code (paste into QR reader):", qr);
          }
          this.qrDisplayed = true;
        }
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        // Only the current generation should reconnect
        if (generation !== this.socketGeneration) {
          console.error('Stale socket (gen ' + generation + ' vs ' + this.socketGeneration + '), ignoring disconnect');
          return;
        }

        if (shouldReconnect) {
          // Limit reconnect attempts for code 440 (conflict:replaced)
          if (statusCode === 440) {
            this.reconnectCount440++;
            if (this.reconnectCount440 > 2) {
              console.error("Too many conflict:replaced reconnects (" + this.reconnectCount440 + "), stopping. Will reconnect on next API call.");
              this.notifyConnection({
                connected: false,
                error: "Connection conflict. Restart to reconnect.",
              });
              return;
            }
          }
          const delay = statusCode === 440 ? 5000 : 2000;
          console.error("Connection closed (code: " + statusCode + "), reconnecting in " + delay + "ms...");
          this.qrDisplayed = false;
          setTimeout(() => {
            if (generation === this.socketGeneration) {
              void this.connect().catch((e) => {
                console.error("Reconnect failed:", e);
              });
            }
          }, delay);
        } else {
          this.notifyConnection({
            connected: false,
            error: "Logged out from WhatsApp. Delete auth directory and re-scan QR code.",
          });
        }
      } else if (connection === "open") {
        this.qrDisplayed = false;
        // Only reset reconnect counter after 30s of stable connection
        setTimeout(() => {
          if (this.isConnected && generation === this.socketGeneration) {
            this.reconnectCount440 = 0;
          }
        }, 30000);
        const phoneNumber = this.socket?.user?.id?.split(":")[0] || "unknown";
        this.notifyConnection({
          connected: true,
          phoneNumber,
        });
        console.error("WhatsApp connected as +" + phoneNumber);
      }
      });

    // Listen for incoming messages to discover individual chats
      this.socket.ev.on("messages.upsert", ({ messages }: { messages: any[] }) => {
      let changed = false;
      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast") continue;
        const isGroup = jid.endsWith("@g.us");
        if (!this.chatStore.has(jid)) {
          // For groups, avoid using "participant" as the chat name (that's a sender JID).
          const name = isGroup ? jid.split("@")[0] : (msg.pushName || jid.split("@")[0]);
          this.chatStore.set(jid, { id: jid, name, isGroup, conversationTimestamp: 0 });
          changed = true;
        }
        const entry = this.chatStore.get(jid)!;
        entry.conversationTimestamp = Math.floor(Date.now() / 1000);
        if (!isGroup && msg.pushName && entry.name === jid.split("@")[0]) {
          entry.name = msg.pushName;
          changed = true;
        }
        this.chatStore.set(jid, entry);

        // Opportunistically enrich group names from metadata (best-effort, non-blocking).
        if (isGroup) {
          this.maybeUpdateGroupSubject(jid);
        }

        this.addToMessageStore(msg);
      }
      if (changed) {
        this.scheduleSaveChatStore();
      }
      });

    // Listen for contacts to get names for individual chats
      this.socket.ev.on("contacts.upsert", (contacts: any[]) => {
      let changed = false;
      for (const contact of contacts) {
        if (!contact.id) continue;
        const id = contact.id;
        if (id.endsWith("@g.us") || id.endsWith("@broadcast")) continue;
        const name = (contact as any).notify || (contact as any).name || (contact as any).verifiedName || id.split("@")[0];
        const existing = this.chatStore.get(id);
        if (existing) {
          existing.name = name;
          this.chatStore.set(id, existing);
        } else {
          this.chatStore.set(id, { id, name, isGroup: false, conversationTimestamp: 0 });
        }
        changed = true;
      }
      if (changed) {
        console.error("Contacts updated, chat store now has " + this.chatStore.size + " entries");
        this.scheduleSaveChatStore();
      }
      });
    } catch (e) {
      this.notifyConnection({
        connected: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      await this.socket.logout();
      this.socket = null;
      this.notifyConnection({ connected: false });
    }
  }

  private ensureConnected(): any {
    if (!this.socket || !this.isConnected) {
      throw new Error(
        "WhatsApp is not connected. Please wait for QR code scan and connection to complete."
      );
    }
    return this.socket;
  }

  async getChats(limit: number = 20): Promise<WhatsAppChat[]> {
    const sock = this.ensureConnected();

    if (this.chatStore.size > 0) {
      const allChats = Array.from(this.chatStore.values())
        .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0))
        .slice(0, limit);

      console.error("Returning " + allChats.length + " chats from store");
      return allChats.map((chat) => ({
        id: chat.id,
        name: chat.name || chat.id.split("@")[0],
        isGroup: chat.isGroup,
        unreadCount: 0,
      }));
    }

    console.error("Chat store empty, fallback to groupFetchAllParticipating (10s timeout)...");
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 10000)
      );
      const conversations = await Promise.race([
        sock.groupFetchAllParticipating(),
        timeoutPromise,
      ]);

      const chats: WhatsAppChat[] = [];
      for (const [id, group] of Object.entries(conversations)) {
        if (chats.length >= limit) break;
        const chat = { id, name: (group as any).subject || id.split("@")[0], isGroup: true, unreadCount: 0 };
        chats.push(chat);
        this.chatStore.set(id, { id, name: chat.name, isGroup: true, conversationTimestamp: 0 });
      }

      console.error("Fallback returned " + chats.length + " group chats");
      this.scheduleSaveChatStore();
      return chats;
    } catch (e) {
      console.error("Fallback failed: " + e);
      return [];
    }
  }

  async sendMessage(
    chatId: string,
    text: string
  ): Promise<{ id: string; timestamp: number }> {
    const sock = this.ensureConnected();
    const normalizedId = this.normalizeJid(chatId);
    const result = await sock.sendMessage(normalizedId, { text });
    return {
      id: result?.key?.id || "unknown",
      timestamp: this.toUnixSeconds((result as any)?.messageTimestamp),
    };
  }

  async sendFile(
    chatId: string,
    filePath: string,
    opts: {
      kind?: "document" | "image" | "video" | "audio" | "voice";
      caption?: string;
      mimetype?: string;
      fileName?: string;
    } = {}
  ): Promise<{ id: string; timestamp: number }> {
    const sock = this.ensureConnected();
    const normalizedId = this.normalizeJid(chatId);

    const kind = opts.kind || "document";
    const caption = opts.caption;
    const expandedPath = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
    const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(expandedPath);
    const fileName = opts.fileName || path.basename(resolvedPath);
    const mimetype = opts.mimetype;

    // Fail early with a clear error if the path is wrong/unreadable.
    await fs.promises.access(resolvedPath, fs.constants.R_OK);

    // Auto-convert non-OGG files to OGG Opus for voice notes.
    let audioPath = resolvedPath;
    let tempOgg: string | null = null;
    if (kind === "voice" && !resolvedPath.toLowerCase().endsWith(".ogg")) {
      const oggPath = resolvedPath.replace(/\.[^.]+$/, "") + ".ogg";
      await execFileAsync("ffmpeg", [
        "-i", resolvedPath, "-c:a", "libopus", "-b:a", "64k", "-y", oggPath,
      ]);
      audioPath = oggPath;
      tempOgg = oggPath;
    }

    // Use `{ url: filePath }` so Baileys can stream from disk.
    const content: any = (() => {
      switch (kind) {
        case "image":
          return { image: { url: resolvedPath }, caption };
        case "video":
          return { video: { url: resolvedPath }, caption };
        case "audio":
          return { audio: { url: resolvedPath }, mimetype, ptt: false };
        case "voice":
          return { audio: { url: audioPath }, mimetype: "audio/ogg; codecs=opus", ptt: true };
        case "document":
        default:
          return { document: { url: resolvedPath }, mimetype, fileName, caption };
      }
    })();

    try {
      const result = await sock.sendMessage(normalizedId, content);
      return {
        id: result?.key?.id || "unknown",
        timestamp: this.toUnixSeconds((result as any)?.messageTimestamp),
      };
    } finally {
      // Clean up the temporary OGG file.
      if (tempOgg) {
        fs.promises.unlink(tempOgg).catch(() => {});
      }
    }
  }

  async downloadMedia(
    chatId: string,
    messageId: string,
    outputDir?: string
  ): Promise<{ path: string; media: WhatsAppMedia }> {
    const sock = this.ensureConnected();
    const normalizedChatId = this.normalizeJid(chatId);
    const key = `${normalizedChatId}:${messageId}`;
    const msg = this.rawMessageByKey.get(key);
    if (!msg) {
      throw new Error(
        "Message not found in the in-memory store. " +
        "The server can only download media for messages it has observed since it started."
      );
    }

    const messageContent = normalizeMessageContent(msg.message) as any;
    let ext = "bin";
    try {
      ext = messageContent ? extensionForMediaMessage(messageContent) : "bin";
    } catch {
      ext = "bin";
    }
    const meta: WhatsAppMedia = this.extractMediaMetaFromContent(messageContent) || { kind: "unknown" };

    const dir = outputDir
      ? (outputDir.startsWith("~/") ? path.join(os.homedir(), outputDir.slice(2)) : outputDir)
      : path.join(this.authDir, "..", "downloads");
    await fs.promises.mkdir(dir, { recursive: true });

    const baseName = meta.fileName || `whatsapp-${messageId}.${ext}`;
    const safeName = baseName.replace(/[\\/:*?"<>|]/g, "_");
    const outPath = path.join(dir, safeName);

    const logger = (sock as any).logger || pino({ level: "warn" }, pino.destination({ dest: 2, sync: true }));
    const data = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { reuploadRequest: (m: any) => (sock as any).updateMediaMessage(m), logger }
    );
    await fs.promises.writeFile(outPath, data);

    return {
      path: outPath,
      media: {
        ...meta,
        fileName: safeName,
        fileLength: data.length,
      },
    };
  }

  async getMedia(
    chatId: string,
    messageId: string,
    format: "base64" | "data_url" = "base64"
  ): Promise<{ base64: string; media: WhatsAppMedia }> {
    const sock = this.ensureConnected();
    const normalizedChatId = this.normalizeJid(chatId);
    const key = `${normalizedChatId}:${messageId}`;
    const msg = this.rawMessageByKey.get(key);
    if (!msg) {
      throw new Error(
        "Message not found in the in-memory store. " +
        "The server can only get media for messages it has observed since it started."
      );
    }

    const messageContent = normalizeMessageContent(msg.message) as any;
    const meta: WhatsAppMedia = this.extractMediaMetaFromContent(messageContent) || { kind: "unknown" };

    const logger = (sock as any).logger || pino({ level: "warn" }, pino.destination({ dest: 2, sync: true }));
    
    let data: Buffer;
    let base64: string;
    
    try {
      data = await downloadMediaMessage(
        msg,
        "buffer",
        {},
      { reuploadRequest: (m: any) => (sock as any).updateMediaMessage(m), logger }
      );
      base64 = data.toString("base64");
    } catch (error) {
      throw new Error(
        `Failed to download media: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return {
      base64,
      media: {
        ...meta,
        fileLength: data.length,
      },
    };
  }

  async listMessages(chatId?: string, limit: number = 20): Promise<WhatsAppMessage[]> {
    const normalized = chatId ? this.normalizeJid(chatId) : undefined;
    const messages = normalized
      ? (this.messageStore.get(normalized) || [])
      : this.flattenMessageStore();

    const slice = messages
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp);

    const tail = slice.slice(Math.max(0, slice.length - limit));
    return tail.map((m) => ({
      ...m,
      chatName: this.chatStore.get(m.chatId)?.name || m.chatId.split("@")[0],
    }));
  }

  async getContactName(jid: string): Promise<string> {
    if (!this.socket) return jid;
    const normalized = this.normalizeJid(jid);
    // For groups, prefer the stored chat name if we have it.
    const fromStore = this.chatStore.get(normalized)?.name || this.chatStore.get(jid)?.name;
    if (fromStore) return fromStore;
    try {
      const contact = (this.socket as any).contacts?.[normalized];
      if (contact?.name) return contact.name;
      if (contact?.notify) return contact.notify;
      if (contact?.verifiedName) return contact.verifiedName;
    } catch {
      // Fall through
    }
    const phone = normalized.split("@")[0].split(":")[0];
    return "+" + phone;
  }

  async searchMessages(
    query: string,
    chatId?: string,
    limit: number = 20
  ): Promise<WhatsAppMessage[]> {
    throw new Error(
      "Message search requires a message store implementation. " +
      "Use whatsapp_list_messages to browse recent messages observed by this server."
    );
  }

  async getGroupInfo(groupId: string): Promise<{
    id: string;
    subject: string;
    description: string;
    participants: Array<{ id: string; admin: boolean }>;
    creation: number;
  }> {
    const sock = this.ensureConnected();
    const normalizedId = this.normalizeJid(groupId);
    const metadata = await sock.groupMetadata(normalizedId);
    return {
      id: metadata.id,
      subject: metadata.subject,
      description: metadata.desc || "",
      participants: metadata.participants.map((p: any) => ({
        id: p.id,
        admin: p.admin === "admin" || p.admin === "superadmin",
      })),
      creation: metadata.creation || 0,
    };
  }

  private normalizeJid(input: string): string {
    let jid = input.replace(/^whatsapp:/gi, "");
    if (jid.includes("@")) return jid;
    const cleaned = jid.replace(/[^0-9]/g, "");
    if (cleaned.length > 0) {
      return cleaned + "@s.whatsapp.net";
    }
    return jid;
  }

  private countMessages(): number {
    let n = 0;
    for (const list of this.messageStore.values()) n += list.length;
    return n;
  }

  private flattenMessageStore(): StoredMessage[] {
    const all: StoredMessage[] = [];
    for (const list of this.messageStore.values()) {
      all.push(...list);
    }
    return all;
  }

  private pruneMessageStore(): void {
    // Enforce per-chat limit
    for (const [chatId, list] of this.messageStore.entries()) {
      if (list.length <= this.maxMessagesPerChat) continue;
      const sorted = list.slice().sort((a, b) => a.timestamp - b.timestamp);
      this.messageStore.set(chatId, sorted.slice(Math.max(0, sorted.length - this.maxMessagesPerChat)));
    }

    // Enforce global limit
    const total = this.countMessages();
    if (total <= this.maxMessagesTotal) {
      this.pruneRawMessageStore();
      return;
    }
    const all = this.flattenMessageStore().sort((a, b) => a.timestamp - b.timestamp);
    const keep = all.slice(Math.max(0, all.length - this.maxMessagesTotal));
    this.messageStore.clear();
    for (const msg of keep) {
      const list = this.messageStore.get(msg.chatId) || [];
      list.push(msg);
      this.messageStore.set(msg.chatId, list);
    }
    this.pruneRawMessageStore();
  }

  private pruneRawMessageStore(): void {
    // Keep raw messages only for messages still present in our (bounded) message store.
    const keep = new Set<string>();
    for (const list of this.messageStore.values()) {
      for (const m of list) {
        keep.add(`${m.chatId}:${m.id}`);
      }
    }
    for (const key of this.rawMessageByKey.keys()) {
      if (!keep.has(key)) this.rawMessageByKey.delete(key);
    }
  }

  private addToMessageStore(msg: any): void {
    const chatId = msg.key.remoteJid;
    if (!chatId) return;

    const id = msg.key.id || "unknown";
    const isFromMe = Boolean(msg.key.fromMe);
    const isGroup = chatId.endsWith("@g.us");
    const timestamp = this.toUnixSeconds((msg as any).messageTimestamp);

    const sender = isFromMe
      ? "me"
      : (msg.key.participant || chatId);

    const senderName = (msg.pushName || "").trim() || sender.split("@")[0];
    const { text, type } = this.extractTextAndType(msg);
    const media = this.extractMediaMeta(msg);

    const stored: StoredMessage = {
      id,
      chatId,
      sender,
      senderName,
      timestamp,
      text,
      isFromMe,
      isGroup,
      type,
      ...(media ? { media } : {}),
    };

    const list = this.messageStore.get(chatId) || [];
    list.push(stored);
    this.messageStore.set(chatId, list);
    this.rawMessageByKey.set(`${chatId}:${id}`, msg);
    this.pruneMessageStore();
    this.scheduleSaveMessageStore();
  }

  private extractTextAndType(msg: any): { text: string; type: string } {
    const m: any = (msg as any).message;
    if (!m) {
      const stub = (msg as any).messageStubType;
      if (stub !== undefined) return { text: `[stub:${stub}]`, type: "stub" };
      return { text: "[no-content]", type: "unknown" };
    }

    // Ephemeral messages wrap the actual message payload.
    if (m.ephemeralMessage?.message) {
      return this.extractTextFromAnyMessage(m.ephemeralMessage.message);
    }
    return this.extractTextFromAnyMessage(m);
  }

  private extractMediaMeta(msg: any): WhatsAppMedia | undefined {
    const content = normalizeMessageContent(msg.message) as any;
    return this.extractMediaMetaFromContent(content);
  }

  private extractMediaMetaFromContent(content: any): WhatsAppMedia | undefined {
    if (!content) return undefined;
    const ctype = getContentType(content) as string | undefined;
    if (!ctype) return undefined;

    const mediaType = ctype.replace(/Message$/, "");
    const m = (content as any)[ctype];
    if (!m || typeof m !== "object") return undefined;

    const kind: WhatsAppMedia["kind"] = (
      mediaType === "image" ||
      mediaType === "video" ||
      mediaType === "document" ||
      mediaType === "audio" ||
      mediaType === "sticker"
    ) ? mediaType : "unknown";

    const fileLength = this.toNumberSafe(m.fileLength);
    const seconds = this.toNumberSafe(m.seconds);
    const mimetype = typeof m.mimetype === "string" ? m.mimetype : undefined;
    const fileName = typeof m.fileName === "string" ? m.fileName : undefined;
    const isVoiceNote = kind === "audio" ? Boolean(m.ptt) : undefined;
    const caption = typeof m.caption === "string" && m.caption.length > 0 ? m.caption : undefined;

    // Only treat as "media" if it's a known media message shape.
    if (kind === "unknown") return undefined;

    return {
      kind,
      mimetype,
      fileName,
      fileLength,
      seconds,
      isVoiceNote,
      caption,
    };
  }

  private extractTextFromAnyMessage(m: any): { text: string; type: string } {
    const keys = Object.keys(m || {});
    const type = keys[0] || "unknown";

    if (typeof m.conversation === "string") {
      return { text: m.conversation, type: "text" };
    }
    if (typeof m.extendedTextMessage?.text === "string") {
      return { text: m.extendedTextMessage.text, type: "text" };
    }
    if (typeof m.imageMessage?.caption === "string") {
      return { text: m.imageMessage.caption, type: "image" };
    }
    if (typeof m.videoMessage?.caption === "string") {
      return { text: m.videoMessage.caption, type: "video" };
    }
    if (typeof m.documentMessage?.caption === "string") {
      return { text: m.documentMessage.caption, type: "document" };
    }
    if (m.documentMessage && typeof m.documentMessage?.fileName === "string") {
      return { text: `[document: ${m.documentMessage.fileName}]`, type: "document" };
    }
    if (m.audioMessage) {
      const isVoice = Boolean(m.audioMessage?.ptt);
      return { text: isVoice ? "[voice-note]" : "[audio]", type: "audio" };
    }
    if (m.imageMessage) {
      return { text: "[image]", type: "image" };
    }
    if (m.videoMessage) {
      return { text: "[video]", type: "video" };
    }
    if (m.stickerMessage) {
      return { text: "[sticker]", type: "sticker" };
    }
    if (typeof m.buttonsResponseMessage?.selectedDisplayText === "string") {
      return { text: m.buttonsResponseMessage.selectedDisplayText, type: "buttons_response" };
    }
    if (typeof m.listResponseMessage?.singleSelectReply?.selectedRowId === "string") {
      return { text: m.listResponseMessage.singleSelectReply.selectedRowId, type: "list_response" };
    }

    return { text: `[${type}]`, type };
  }

  private toNumberSafe(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    if (value && typeof value === "object") {
      const v = value as any;
      if (typeof v.toNumber === "function") {
        const n = v.toNumber();
        if (typeof n === "number" && Number.isFinite(n)) return n;
      }
      if (typeof v.toString === "function") {
        const n = Number(v.toString());
        if (Number.isFinite(n)) return n;
      }
    }
    return undefined;
  }

  private toUnixSeconds(value: unknown): number {
    // Baileys / proto timestamps can be number-like or Long-like objects.
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    if (value && typeof value === "object") {
      const v = value as any;
      if (typeof v.toNumber === "function") {
        const n = v.toNumber();
        if (typeof n === "number" && Number.isFinite(n)) return n;
      }
      if (typeof v.toString === "function") {
        const n = Number(v.toString());
        if (Number.isFinite(n)) return n;
      }
    }
    return Math.floor(Date.now() / 1000);
  }

  private maybeUpdateGroupSubject(groupJid: string): void {
    if (!this.socket) return;
    if (this.groupMetadataInFlight.has(groupJid)) return;
    const existing = this.chatStore.get(groupJid);
    // If the name is already something other than the placeholder (the group id prefix), keep it.
    const placeholder = groupJid.split("@")[0];
    if (existing?.name && existing.name !== placeholder) return;

    this.groupMetadataInFlight.add(groupJid);
    const sock = this.socket;

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 2000)
    );

    Promise.race([sock.groupMetadata(groupJid), timeout])
      .then((metadata: any) => {
        const subject = metadata?.subject;
        if (!subject) return;
        const current = this.chatStore.get(groupJid);
        if (!current) return;
        if (current.name !== subject) {
          current.name = subject;
          this.chatStore.set(groupJid, current);
          this.scheduleSaveChatStore();
        }
      })
      .catch(() => {
        // Best-effort only.
      })
      .finally(() => {
        this.groupMetadataInFlight.delete(groupJid);
      });
  }

  formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
}
