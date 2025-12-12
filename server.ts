import { spawn, type Subprocess } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const PORT = 8080;
const PUBLIC_DIR = join(import.meta.dir, "public");
const DATA_DIR = join(import.meta.dir, "data");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const MESSAGES_DIR = join(DATA_DIR, "messages");

// Ensure directories exist
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(MESSAGES_DIR)) mkdirSync(MESSAGES_DIR, { recursive: true });

// Types
interface ChatSession {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastMessageAt: number;
  lastMessage?: string;
  claudeSessionId?: string; // Claude's internal session ID for --resume
}

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

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

// Track active connections
const activeConnections = new Map<WebSocket, {
  process: Subprocess;
  buffer: string;
  sessionId: string;
  assistantBuffer: string; // Accumulate assistant response
}>();

function spawnClaude(cwd: string, claudeSessionId?: string): Subprocess {
  const cmd = [
    "claude",
    "--print",
    "--verbose",
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
  ];

  // Resume existing Claude session if we have one
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

async function handleClaudeOutput(ws: WebSocket, connection: {
  process: Subprocess;
  buffer: string;
  sessionId: string;
  assistantBuffer: string;
}) {
  const reader = connection.process.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      connection.buffer += decoder.decode(value, { stream: true });
      const lines = connection.buffer.split("\n");
      connection.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);
          ws.send(JSON.stringify(msg));

          // Capture Claude's session ID from init
          if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
            updateSession(connection.sessionId, { claudeSessionId: msg.session_id });
          }

          // Accumulate assistant text
          if (msg.type === "assistant" && msg.message?.content) {
            const content = msg.message.content;
            if (Array.isArray(content)) {
              const textBlock = content.find((b: any) => b.type === "text");
              if (textBlock?.text) {
                connection.assistantBuffer = textBlock.text;
              }
            }
          }

          // Save complete assistant message
          if (msg.type === "result" && connection.assistantBuffer) {
            saveMessage(connection.sessionId, {
              role: "assistant",
              content: connection.assistantBuffer,
              timestamp: Date.now(),
            });
            updateSession(connection.sessionId, {
              lastMessageAt: Date.now(),
              lastMessage: connection.assistantBuffer.slice(0, 100),
            });
            // Notify client to refresh sidebar
            ws.send(JSON.stringify({ type: "refresh_sessions" }));
            connection.assistantBuffer = "";
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error("Error reading Claude output:", err);
  }

  ws.send(JSON.stringify({ type: "system", message: "Session ended" }));
}

async function handleClaudeStderr(ws: WebSocket, process: Subprocess) {
  const reader = process.stderr.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.trim()) {
        ws.send(JSON.stringify({ type: "stderr", message: text }));
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
  return "text/plain";
}

// REST API
function handleApi(req: Request, url: URL): Response | null {
  const path = url.pathname;

  // GET /api/sessions
  if (req.method === "GET" && path === "/api/sessions") {
    const sessions = loadSessions();
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
    let sessions = loadSessions();
    sessions = sessions.filter(s => s.id !== id);
    saveSessions(sessions);
    // Also delete messages file
    try {
      const msgFile = getMessagesFile(id);
      if (existsSync(msgFile)) {
        require("fs").unlinkSync(msgFile);
      }
    } catch {}
    return new Response(null, { status: 204 });
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
      const { sessionId, cwd, claudeSessionId } = ws.data as {
        sessionId: string;
        cwd: string;
        claudeSessionId?: string;
      };
      console.log(`Client connected to session ${sessionId}${claudeSessionId ? ` (resuming ${claudeSessionId})` : ""}`);

      // Send stored message history first
      const messages = loadMessages(sessionId);
      if (messages.length > 0) {
        ws.send(JSON.stringify({ type: "history", messages }));
      }

      const process = spawnClaude(cwd, claudeSessionId);
      const connection = { process, buffer: "", sessionId, assistantBuffer: "" };
      activeConnections.set(ws, connection);

      handleClaudeOutput(ws, connection);
      handleClaudeStderr(ws, process);

      ws.send(JSON.stringify({ type: "system", message: "Connected to Claude Code", sessionId }));
    },

    async message(ws, message) {
      const connection = activeConnections.get(ws);
      if (!connection) return;

      try {
        const data = JSON.parse(message.toString());

        if (data.type === "user" && data.content) {
          // Save user message
          saveMessage(connection.sessionId, {
            role: "user",
            content: data.content,
            timestamp: Date.now(),
          });
          updateSession(connection.sessionId, {
            lastMessageAt: Date.now(),
            lastMessage: "You: " + data.content.slice(0, 50),
          });

          // Send to Claude
          const claudeMsg = JSON.stringify({
            type: "user",
            message: { role: "user", content: data.content },
          }) + "\n";

          connection.process.stdin.write(claudeMsg);
          connection.process.stdin.flush();
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },

    close(ws) {
      console.log("Client disconnected");
      const connection = activeConnections.get(ws);
      if (connection) {
        try {
          connection.process.kill(9);
        } catch {}
        activeConnections.delete(ws);
      }
    },
  },
});

console.log(`Claude Mobile server running on http://localhost:${PORT}`);
