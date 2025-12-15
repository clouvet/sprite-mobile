import { spawn, type Subprocess } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.PORT || "8081");
const PUBLIC_DIR = join(import.meta.dir, "public");
const DATA_DIR = join(import.meta.dir, "data");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const SPRITES_FILE = join(DATA_DIR, "sprites.json");
const MESSAGES_DIR = join(DATA_DIR, "messages");
const UPLOADS_DIR = join(DATA_DIR, "uploads");

// Ensure directories exist
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(MESSAGES_DIR)) mkdirSync(MESSAGES_DIR, { recursive: true });
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

// Types
interface ChatSession {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastMessageAt: number;
  lastMessage?: string;
  claudeSessionId?: string;
  isProcessing?: boolean; // True if Claude is working on a response
}

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  image?: {
    id: string;
    filename: string;
    mediaType: string;
  };
}

interface SpriteProfile {
  id: string;
  name: string;
  address: string;
  port: number;
  createdAt: number;
}

// Background process tracking - persists across WebSocket reconnects
interface BackgroundProcess {
  process: Subprocess;
  buffer: string;
  assistantBuffer: string;
  sessionId: string;
  ws: WebSocket | null; // null if client disconnected
  startedAt: number;
}

const backgroundProcesses = new Map<string, BackgroundProcess>();

// Session storage
function loadSessions(): ChatSession[] {
  try {
    if (existsSync(SESSIONS_FILE)) {
      return JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveSessions(sessions: ChatSession[]) {
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function getSession(id: string): ChatSession | undefined {
  return loadSessions().find(s => s.id === id);
}

function updateSession(id: string, updates: Partial<ChatSession>) {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === id);
  if (session) {
    Object.assign(session, updates);
    saveSessions(sessions);
  }
}

// Sprite storage
function loadSprites(): SpriteProfile[] {
  try {
    if (existsSync(SPRITES_FILE)) {
      return JSON.parse(readFileSync(SPRITES_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveSprites(sprites: SpriteProfile[]) {
  writeFileSync(SPRITES_FILE, JSON.stringify(sprites, null, 2));
}

// Message storage
function getMessagesFile(sessionId: string): string {
  return join(MESSAGES_DIR, `${sessionId}.json`);
}

function loadMessages(sessionId: string): StoredMessage[] {
  try {
    const file = getMessagesFile(sessionId);
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch {}
  return [];
}

function saveMessage(sessionId: string, msg: StoredMessage) {
  const messages = loadMessages(sessionId);
  messages.push(msg);
  writeFileSync(getMessagesFile(sessionId), JSON.stringify(messages, null, 2));
}

function generateId(): string {
  return crypto.randomUUID();
}

// Generate a chat name from the first message using Claude
async function generateChatName(message: string, sessionId: string, bg: BackgroundProcess): Promise<void> {
  try {
    const prompt = `Generate a very short title (3-5 words max) for a chat that starts with this message. Reply with ONLY the title, no quotes or punctuation:\n\n${message.slice(0, 500)}`;

    const proc = spawn({
      cmd: ["claude", "--print", "-p", prompt],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const title = output.trim().slice(0, 50) || "New Chat";

    updateSession(sessionId, { name: title });
    trySend(bg, JSON.stringify({ type: "refresh_sessions" }));
  } catch (err) {
    console.error("Failed to generate chat name:", err);
    // Fallback to truncated message
    const fallback = message.slice(0, 40).trim() + (message.length > 40 ? "..." : "");
    updateSession(sessionId, { name: fallback || "New Chat" });
    trySend(bg, JSON.stringify({ type: "refresh_sessions" }));
  }
}

// Spawn Claude process
function spawnClaude(cwd: string, claudeSessionId?: string): Subprocess {
  const cmd = [
    "claude",
    "--print",
    "--verbose",
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
  ];

  if (claudeSessionId) {
    cmd.push("--resume", claudeSessionId);
  }

  return spawn({
    cmd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwd || process.env.HOME,
  });
}

// Send to WebSocket if connected, otherwise just log
function trySend(bg: BackgroundProcess, data: string) {
  if (bg.ws && bg.ws.readyState === 1) { // OPEN
    try {
      bg.ws.send(data);
    } catch {
      bg.ws = null;
    }
  }
}

// Handle Claude output - continues even if client disconnects
async function handleClaudeOutput(bg: BackgroundProcess) {
  const reader = bg.process.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bg.buffer += decoder.decode(value, { stream: true });
      const lines = bg.buffer.split("\n");
      bg.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);

          // Always send to client if connected
          trySend(bg, JSON.stringify(msg));

          // Capture Claude's session ID from init
          if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
            updateSession(bg.sessionId, { claudeSessionId: msg.session_id });
          }

          // Accumulate assistant text
          if (msg.type === "assistant" && msg.message?.content) {
            const content = msg.message.content;
            if (Array.isArray(content)) {
              const textBlock = content.find((b: any) => b.type === "text");
              if (textBlock?.text) {
                bg.assistantBuffer = textBlock.text;
              }
            }
          }

          // Save complete assistant message
          if (msg.type === "result" && bg.assistantBuffer) {
            saveMessage(bg.sessionId, {
              role: "assistant",
              content: bg.assistantBuffer,
              timestamp: Date.now(),
            });
            updateSession(bg.sessionId, {
              lastMessageAt: Date.now(),
              lastMessage: bg.assistantBuffer.slice(0, 100),
              isProcessing: false,
            });
            trySend(bg, JSON.stringify({ type: "refresh_sessions" }));
            bg.assistantBuffer = "";
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error("Error reading Claude output:", err);
  }

  // Process finished - clean up
  console.log(`Claude process finished for session ${bg.sessionId}`);
  updateSession(bg.sessionId, { isProcessing: false });
  trySend(bg, JSON.stringify({ type: "system", message: "Claude finished" }));
  backgroundProcesses.delete(bg.sessionId);
}

// Handle stderr - just forward to client if connected
async function handleClaudeStderr(bg: BackgroundProcess) {
  const reader = bg.process.stderr.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.trim()) {
        trySend(bg, JSON.stringify({ type: "stderr", message: text }));
      }
    }
  } catch {}
}

function getContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  return "text/plain";
}

// REST API
function handleApi(req: Request, url: URL): Response | null {
  const path = url.pathname;

  // GET /api/sessions
  if (req.method === "GET" && path === "/api/sessions") {
    const sessions = loadSessions();
    // Add real-time processing status
    for (const s of sessions) {
      s.isProcessing = backgroundProcesses.has(s.id);
    }
    sessions.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return Response.json(sessions);
  }

  // GET /api/sessions/:id/messages
  if (req.method === "GET" && path.match(/^\/api\/sessions\/[^/]+\/messages$/)) {
    const id = path.split("/")[3];
    const messages = loadMessages(id);
    return Response.json(messages);
  }

  // POST /api/sessions
  if (req.method === "POST" && path === "/api/sessions") {
    return (async () => {
      const body = await req.json().catch(() => ({}));
      const sessions = loadSessions();
      const newSession: ChatSession = {
        id: generateId(),
        name: body.name || `Chat ${sessions.length + 1}`,
        cwd: body.cwd || process.env.HOME || "/home/sprite",
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      };
      sessions.push(newSession);
      saveSessions(sessions);
      return Response.json(newSession);
    })();
  }

  // PATCH /api/sessions/:id
  if (req.method === "PATCH" && path.startsWith("/api/sessions/")) {
    return (async () => {
      const id = path.split("/")[3];
      const body = await req.json().catch(() => ({}));
      const sessions = loadSessions();
      const session = sessions.find(s => s.id === id);
      if (!session) return new Response("Not found", { status: 404 });
      if (body.name) session.name = body.name;
      if (body.cwd) session.cwd = body.cwd;
      saveSessions(sessions);
      return Response.json(session);
    })();
  }

  // DELETE /api/sessions/:id
  if (req.method === "DELETE" && path.startsWith("/api/sessions/")) {
    const id = path.split("/")[3];
    // Kill any background process
    const bg = backgroundProcesses.get(id);
    if (bg) {
      try { bg.process.kill(9); } catch {}
      backgroundProcesses.delete(id);
    }
    let sessions = loadSessions();
    sessions = sessions.filter(s => s.id !== id);
    saveSessions(sessions);
    try {
      const msgFile = getMessagesFile(id);
      if (existsSync(msgFile)) unlinkSync(msgFile);
    } catch {}
    return new Response(null, { status: 204 });
  }

  // GET /api/sprites
  if (req.method === "GET" && path === "/api/sprites") {
    const sprites = loadSprites();
    sprites.sort((a, b) => b.createdAt - a.createdAt);
    return Response.json(sprites);
  }

  // POST /api/sprites
  if (req.method === "POST" && path === "/api/sprites") {
    return (async () => {
      const body = await req.json().catch(() => ({}));
      if (!body.name || !body.address) {
        return new Response("Name and address required", { status: 400 });
      }
      const sprites = loadSprites();
      const newSprite: SpriteProfile = {
        id: generateId(),
        name: body.name,
        address: body.address,
        port: body.port || 8080,
        createdAt: Date.now(),
      };
      sprites.push(newSprite);
      saveSprites(sprites);
      return Response.json(newSprite);
    })();
  }

  // DELETE /api/sprites/:id
  if (req.method === "DELETE" && path.match(/^\/api\/sprites\/[^/]+$/)) {
    const id = path.split("/")[3];
    let sprites = loadSprites();
    sprites = sprites.filter(s => s.id !== id);
    saveSprites(sprites);
    return new Response(null, { status: 204 });
  }

  // POST /api/upload?session={sessionId}
  if (req.method === "POST" && path === "/api/upload") {
    return (async () => {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) {
        return new Response("Session ID required", { status: 400 });
      }

      try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;

        if (!file) {
          return new Response("No file provided", { status: 400 });
        }

        // Validate it's an image
        if (!file.type.startsWith("image/")) {
          return new Response("Only images are allowed", { status: 400 });
        }

        // Create session upload directory
        const sessionUploadsDir = join(UPLOADS_DIR, sessionId);
        if (!existsSync(sessionUploadsDir)) {
          mkdirSync(sessionUploadsDir, { recursive: true });
        }

        // Generate unique filename
        const id = generateId();
        const ext = file.name.split(".").pop() || "png";
        const filename = `${id}.${ext}`;
        const filePath = join(sessionUploadsDir, filename);

        // Save file
        const buffer = await file.arrayBuffer();
        writeFileSync(filePath, Buffer.from(buffer));

        return Response.json({
          id,
          filename,
          mediaType: file.type,
          url: `/api/uploads/${sessionId}/${filename}`,
        });
      } catch (err) {
        console.error("Upload error:", err);
        return new Response("Upload failed", { status: 500 });
      }
    })();
  }

  // GET /api/uploads/:sessionId/:filename
  if (req.method === "GET" && path.match(/^\/api\/uploads\/[^/]+\/[^/]+$/)) {
    const parts = path.split("/");
    const sessionId = parts[3];
    const filename = parts[4];
    const filePath = join(UPLOADS_DIR, sessionId, filename);

    try {
      if (!existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
      }
      const content = readFileSync(filePath);
      const contentType = filename.endsWith(".png") ? "image/png"
        : filename.endsWith(".jpg") || filename.endsWith(".jpeg") ? "image/jpeg"
        : filename.endsWith(".gif") ? "image/gif"
        : filename.endsWith(".webp") ? "image/webp"
        : "application/octet-stream";
      return new Response(content, {
        headers: { "Content-Type": contentType },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  return null;
}

const server = Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      const response = handleApi(req, url);
      if (response) return response;
    }

    // Keepalive WebSocket - keeps sprite awake while app is open
    if (url.pathname === "/ws/keepalive") {
      const upgraded = server.upgrade(req, { data: { type: "keepalive" } });
      if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
      return undefined;
    }

    if (url.pathname === "/ws") {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) return new Response("Missing session ID", { status: 400 });

      const session = getSession(sessionId);
      if (!session) return new Response("Session not found", { status: 404 });

      const upgraded = server.upgrade(req, {
        data: { sessionId, cwd: session.cwd, claudeSessionId: session.claudeSessionId }
      });
      if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
      return undefined;
    }

    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      const content = readFileSync(join(PUBLIC_DIR, filePath));
      return new Response(content, {
        headers: { "Content-Type": getContentType(filePath) },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },

  websocket: {
    open(ws) {
      const data = ws.data as { type?: string; sessionId?: string; cwd?: string; claudeSessionId?: string };

      // Handle keepalive connections
      if (data.type === "keepalive") {
        console.log("Keepalive connection opened");
        return;
      }

      const { sessionId, cwd, claudeSessionId } = data as {
        sessionId: string;
        cwd: string;
        claudeSessionId?: string;
      };

      // Check if there's already a background process for this session
      const existingBg = backgroundProcesses.get(sessionId);
      if (existingBg) {
        console.log(`Client reconnected to session ${sessionId} (process still running)`);
        existingBg.ws = ws;

        // Send history
        const messages = loadMessages(sessionId);
        if (messages.length > 0) {
          ws.send(JSON.stringify({ type: "history", messages }));
        }

        // Notify client that Claude is still working
        ws.send(JSON.stringify({ type: "system", message: "Reconnected - Claude is still working", sessionId }));
        ws.send(JSON.stringify({ type: "processing", isProcessing: true }));
        return;
      }

      console.log(`Client connected to session ${sessionId}${claudeSessionId ? ` (resuming ${claudeSessionId})` : ""}`);

      // Send stored message history
      const messages = loadMessages(sessionId);
      if (messages.length > 0) {
        ws.send(JSON.stringify({ type: "history", messages }));
      }

      // Spawn new Claude process
      const process = spawnClaude(cwd, claudeSessionId);
      const bg: BackgroundProcess = {
        process,
        buffer: "",
        assistantBuffer: "",
        sessionId,
        ws,
        startedAt: Date.now(),
      };
      backgroundProcesses.set(sessionId, bg);

      // Start handling output (continues even if ws disconnects)
      handleClaudeOutput(bg);
      handleClaudeStderr(bg);

      ws.send(JSON.stringify({ type: "system", message: "Connected to Claude Code", sessionId }));
    },

    async message(ws, message) {
      const wsData = ws.data as { type?: string; sessionId?: string };

      // Ignore messages on keepalive connections
      if (wsData.type === "keepalive") return;

      const sessionId = wsData.sessionId;
      if (!sessionId) return;

      const bg = backgroundProcesses.get(sessionId);
      if (!bg) {
        ws.send(JSON.stringify({ type: "error", message: "No active Claude process" }));
        return;
      }

      try {
        const data = JSON.parse(message.toString());

        if (data.type === "user" && (data.content || data.imageId)) {
          // Check if this is the first message - auto-rename the session
          const existingMessages = loadMessages(sessionId);
          const session = getSession(sessionId);
          if (existingMessages.length === 0 && session?.name.match(/^Chat \d+$/)) {
            // Fire off title generation in background (don't await)
            generateChatName(data.content || "Image shared", sessionId, bg);
          }

          // Build message content for Claude
          let claudeContent: any = data.content || "";
          let imageInfo: StoredMessage["image"] = undefined;

          // Handle image if present
          if (data.imageId && data.imageFilename && data.imageMediaType) {
            const imagePath = join(UPLOADS_DIR, sessionId, data.imageFilename);
            if (existsSync(imagePath)) {
              const imageBuffer = readFileSync(imagePath);
              const base64Data = imageBuffer.toString("base64");

              // Build content array for Claude with image
              claudeContent = [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: data.imageMediaType,
                    data: base64Data,
                  },
                },
              ];

              // Add text if provided
              if (data.content) {
                claudeContent.push({
                  type: "text",
                  text: data.content,
                });
              }

              imageInfo = {
                id: data.imageId,
                filename: data.imageFilename,
                mediaType: data.imageMediaType,
              };
            }
          }

          // Save user message
          saveMessage(sessionId, {
            role: "user",
            content: data.content || "[Image]",
            timestamp: Date.now(),
            image: imageInfo,
          });
          updateSession(sessionId, {
            lastMessageAt: Date.now(),
            lastMessage: "You: " + (data.content ? data.content.slice(0, 50) : "[Image]"),
            isProcessing: true,
          });

          // Send to Claude
          const claudeMsg = JSON.stringify({
            type: "user",
            message: { role: "user", content: claudeContent },
          }) + "\n";

          bg.process.stdin.write(claudeMsg);
          bg.process.stdin.flush();
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },

    close(ws) {
      const wsData = ws.data as { type?: string; sessionId?: string };

      // Handle keepalive disconnections
      if (wsData.type === "keepalive") {
        console.log("Keepalive connection closed");
        return;
      }

      const sessionId = wsData.sessionId;
      if (!sessionId) return;

      const bg = backgroundProcesses.get(sessionId);

      if (bg) {
        // DON'T kill the process - just detach the websocket
        console.log(`Client disconnected from session ${sessionId} - Claude continues in background`);
        bg.ws = null;
        // Process continues running and will save results
      } else {
        console.log(`Client disconnected from session ${sessionId}`);
      }
    },
  },
});

// Cleanup stale processes after 30 minutes of no activity
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [sessionId, bg] of backgroundProcesses) {
    if (now - bg.startedAt > maxAge && !bg.ws) {
      console.log(`Cleaning up stale process for session ${sessionId}`);
      try { bg.process.kill(9); } catch {}
      backgroundProcesses.delete(sessionId);
      updateSession(sessionId, { isProcessing: false });
    }
  }
}, 60 * 1000); // Check every minute

console.log(`Claude Mobile server running on http://localhost:${PORT}`);
