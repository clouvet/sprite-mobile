import { spawn, type Subprocess } from "bun";
import { readFileSync } from "fs";
import { join } from "path";

const PORT = 8080;
const PUBLIC_DIR = join(import.meta.dir, "public");

// Track active Claude sessions per WebSocket
const sessions = new Map<WebSocket, {
  process: Subprocess;
  buffer: string;
}>();

function spawnClaude(): Subprocess {
  return spawn({
    cmd: [
      "claude",
      "--print",
      "--verbose",
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.env.HOME,
  });
}

async function handleClaudeOutput(ws: WebSocket, session: { process: Subprocess; buffer: string }) {
  const reader = session.process.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      session.buffer += decoder.decode(value, { stream: true });

      // Process complete JSON lines
      const lines = session.buffer.split("\n");
      session.buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            ws.send(JSON.stringify(msg));
          } catch {
            // Skip malformed lines
          }
        }
      }
    }
  } catch (err) {
    console.error("Error reading Claude output:", err);
  }

  // Process exited
  ws.send(JSON.stringify({ type: "system", message: "Session ended" }));
  ws.close();
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
  } catch {
    // Ignore stderr errors
  }
}

function getContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "text/plain";
}

const server = Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // Serve static files
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
      console.log("Client connected, spawning Claude...");

      const process = spawnClaude();
      const session = { process, buffer: "" };
      sessions.set(ws, session);

      // Start reading output
      handleClaudeOutput(ws, session);
      handleClaudeStderr(ws, process);

      ws.send(JSON.stringify({ type: "system", message: "Connected to Claude Code" }));
    },

    async message(ws, message) {
      const session = sessions.get(ws);
      if (!session) return;

      try {
        const data = JSON.parse(message.toString());

        // Send user message to Claude
        if (data.type === "user" && data.content) {
          const claudeMsg = JSON.stringify({
            type: "user",
            message: { role: "user", content: data.content },
          }) + "\n";

          session.process.stdin.write(claudeMsg);
          session.process.stdin.flush();
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },

    close(ws) {
      console.log("Client disconnected");
      const session = sessions.get(ws);
      if (session) {
        session.process.kill();
        sessions.delete(ws);
      }
    },
  },
});

console.log(`Claude Mobile server running on http://localhost:${PORT}`);
