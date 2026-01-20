import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { ensureDirectories, getSession } from "./lib/storage";
import { cleanupStaleProcesses } from "./lib/claude";
import { handleApi } from "./routes/api";
import { websocketHandlers, allClients } from "./routes/websocket";
import { initNetwork, registerSprite, updateHeartbeat, buildSpriteRegistration, isNetworkEnabled } from "./lib/network";
import { initTasksNetwork } from "./lib/distributed-tasks";

// Load .env file if present
const ENV_FILE = join(import.meta.dir, ".env");
if (existsSync(ENV_FILE)) {
  const envContent = readFileSync(ENV_FILE, "utf-8");
  for (const line of envContent.split("\n")) {
    const [key, ...valueParts] = line.split("=");
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join("=").trim();
    }
  }
}

// Configuration
const PORT = parseInt(process.env.PORT || "8081");
const PUBLIC_DIR = join(import.meta.dir, "public");

// Ensure data directories exist
ensureDirectories();

// CORS headers for cross-origin requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
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

// Start server
const server = Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // API routes
    if (url.pathname.startsWith("/api/")) {
      const response = await handleApi(req, url);
      if (response) return addCorsHeaders(response);
    }

    // Keepalive WebSocket
    if (url.pathname === "/ws/keepalive") {
      const upgraded = server.upgrade(req, { data: { type: "keepalive" } });
      if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
      return undefined;
    }

    // Chat WebSocket
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

    // Static files
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

  websocket: websocketHandlers,
});

// Cleanup stale processes every minute
setInterval(cleanupStaleProcesses, 60 * 1000);

// Initialize sprite network for discovery
const networkEnabled = initNetwork();
if (networkEnabled) {
  // Register this sprite on startup
  const spriteInfo = buildSpriteRegistration();
  registerSprite(spriteInfo)
    .then(() => console.log(`Registered in sprite network as: ${spriteInfo.hostname}`))
    .catch((err) => console.error("Failed to register in sprite network:", err));

  // Heartbeat every 5 minutes to update lastSeen
  setInterval(() => {
    updateHeartbeat().catch((err) => console.error("Heartbeat failed:", err));
  }, 5 * 60 * 1000);
}

// Initialize distributed tasks
const tasksEnabled = initTasksNetwork();
if (tasksEnabled) {
  console.log("Distributed tasks enabled");
} else {
  console.log("Distributed tasks disabled (no credentials)");
}

// Hot-reloading disabled to prevent constant app refreshes during conversations
// If you need hot-reload during development, uncomment this block:
// let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
// watch(PUBLIC_DIR, { recursive: true }, (event, filename) => {
//   if (reloadDebounce) clearTimeout(reloadDebounce);
//   reloadDebounce = setTimeout(() => {
//     console.log(`File changed: ${filename}, notifying ${allClients.size} clients to reload`);
//     const msg = JSON.stringify({ type: "reload" });
//     for (const ws of allClients) {
//       try {
//         if (ws.readyState === 1) ws.send(msg);
//       } catch {}
//     }
//   }, 300);
// });

console.log(`Claude Mobile server running on http://localhost:${PORT}`);
