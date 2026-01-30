import { spawn } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import type { ChatSession, SpriteProfile } from "../lib/types";
import {
  loadSessions, saveSessions, getSession, updateSession,
  loadSprites, saveSprites,
  loadMessages, deleteMessagesFile, saveMessages,
  generateId, UPLOADS_DIR
} from "../lib/storage";
import type { StoredMessage } from "../lib/types";
import { backgroundProcesses, trySend } from "../lib/claude";
import { discoverSprites, getSpriteStatus, getNetworkInfo, getHostname, updateHeartbeat, deleteSprite } from "../lib/network";
import * as distributedTasks from "./distributed-tasks";
import { allClients } from "./websocket";

// Broadcast a message to all connected keepalive clients
function broadcastToAll(message: any) {
  const data = JSON.stringify(message);
  for (const client of allClients) {
    if (client.readyState === 1) {
      try {
        client.send(data);
      } catch (err) {
        // Client may have disconnected, ignore
      }
    }
  }
}

// Detect actual image format from file content (magic bytes)
function detectImageFormat(buffer: ArrayBuffer): { ext: string; mediaType: string } | null {
  const bytes = new Uint8Array(buffer);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { ext: "png", mediaType: "image/png" };
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 &&
      bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { ext: "jpg", mediaType: "image/jpeg" };
  }

  // GIF: 47 49 46 38 (GIF8)
  if (bytes.length >= 4 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { ext: "gif", mediaType: "image/gif" };
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { ext: "webp", mediaType: "image/webp" };
  }

  return null;
}

export function handleApi(req: Request, url: URL): Response | Promise<Response> | null {
  const path = url.pathname;

  // GET /api/config - returns public configuration for the client
  // Read env var lazily so .env file has time to load
  if (req.method === "GET" && path === "/api/config") {
    return Response.json({
      publicUrl: process.env.SPRITE_PUBLIC_URL || "",
      spriteName: getHostname(),
    });
  }

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
      const cwd = body.cwd || process.env.HOME || "/home/sprite";
      const newSession: ChatSession = {
        id: generateId(),
        name: body.name || `Chat ${sessions.length + 1}`,
        cwd,
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      };

      sessions.push(newSession);
      saveSessions(sessions);

      // Broadcast to all clients to refresh their session lists
      broadcastToAll({ type: "refresh_sessions" });

      return Response.json(newSession);
    })();
  }

  // PATCH /api/sessions/:id
  if (req.method === "PATCH" && path.startsWith("/api/sessions/") && !path.includes("regenerate")) {
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

  // POST /api/sessions/:id/regenerate-title
  if (req.method === "POST" && path.match(/^\/api\/sessions\/[^/]+\/regenerate-title$/)) {
    return (async () => {
      const id = path.split("/")[3];

      // Find Claude session file by scanning all cwd directories
      // Claude's files are the source of truth - no need for sprite-mobile metadata
      let claudeSessionFile: string | null = null;
      const claudeProjectsDir = join(process.env.HOME || "/home/sprite", ".claude", "projects");

      if (existsSync(claudeProjectsDir)) {
        const cwdDirs = readdirSync(claudeProjectsDir);
        for (const cwdDir of cwdDirs) {
          const candidateFile = join(claudeProjectsDir, cwdDir, `${id}.jsonl`);
          if (existsSync(candidateFile)) {
            claudeSessionFile = candidateFile;
            break;
          }
        }
      }

      if (!claudeSessionFile) {
        return new Response("No Claude session file found", { status: 404 });
      }

      let messages: Array<{ role: string; content: string }> = [];

      try {
        const content = readFileSync(claudeSessionFile, "utf-8");
        const lines = content.trim().split("\n").filter(line => line.trim());

        // Parse Claude's .jsonl format (written by claude-hub)
        messages = lines
          .map(line => {
            try {
              const msg = JSON.parse(line);

              // User message: {"type": "user", "message": {"role": "user", "content": "..."}}
              if (msg.type === "user" && msg.message?.content) {
                const content = msg.message.content;
                // Handle both string and array content
                const textContent = typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
                    : "";
                if (textContent) {
                  return { role: "user", content: textContent };
                }
              }

              // Assistant message: {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
              if (msg.type === "assistant" && msg.message?.content) {
                const content = Array.isArray(msg.message.content)
                  ? msg.message.content
                      .filter((c: any) => c.type === "text")
                      .map((c: any) => c.text)
                      .join("\n")
                  : "";
                if (content) {
                  return { role: "assistant", content };
                }
              }
            } catch {}
            return null;
          })
          .filter((msg): msg is { role: string; content: string } => msg !== null);
      } catch (err) {
        console.error("Failed to read Claude session file:", err);
        return new Response("Failed to read session file", { status: 500 });
      }

      if (messages.length === 0) {
        return new Response("No messages to generate title from", { status: 400 });
      }

      const conversationSummary = messages
        .slice(0, 10)
        .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");

      try {
        const prompt = `Based on this conversation, generate a very short title (3-5 words max) that captures the main topic. Reply with ONLY the title, no quotes or punctuation:\n\n${conversationSummary.slice(0, 1500)}`;

        const proc = spawn({
          cmd: ["claude", "--print", "-p", prompt],
          stdout: "pipe",
          stderr: "pipe",
        });

        const output = await new Response(proc.stdout).text();
        const title = output.trim().slice(0, 50) || session.name;

        updateSession(id, { name: title });

        const bg = backgroundProcesses.get(id);
        if (bg) {
          trySend(bg, JSON.stringify({ type: "refresh_sessions" }));
        }

        return Response.json({ id, name: title });
      } catch (err) {
        console.error("Failed to regenerate title:", err);
        return new Response("Failed to generate title", { status: 500 });
      }
    })();
  }

  // POST /api/sessions/:id/update-id
  if (req.method === "POST" && path.match(/^\/api\/sessions\/[^/]+\/update-id$/)) {
    return (async () => {
      const oldId = path.split("/")[3];
      const body = await req.json() as { newId: string };
      const { newId } = body;

      if (!newId) {
        return new Response("Missing newId", { status: 400 });
      }

      const session = getSession(oldId);
      if (!session) {
        return new Response("Session not found", { status: 404 });
      }

      console.log(`[API] Updating session ID from ${oldId} to ${newId}`);

      // Update sessions file
      const sessions = loadSessions();
      const sessionIndex = sessions.findIndex(s => s.id === oldId);
      if (sessionIndex !== -1) {
        sessions[sessionIndex].id = newId;
        saveSessions(sessions);
      }

      // Rename messages file if it exists
      const oldMessagesFile = join(process.env.HOME || "/home/sprite", ".sprite-mobile/data", `${oldId}.json`);
      const newMessagesFile = join(process.env.HOME || "/home/sprite", ".sprite-mobile/data", `${newId}.json`);
      try {
        if (existsSync(oldMessagesFile)) {
          const fs = await import("fs");
          fs.renameSync(oldMessagesFile, newMessagesFile);
          console.log(`[API] Renamed messages file from ${oldId}.json to ${newId}.json`);
        }
      } catch (err) {
        console.error(`[API] Failed to rename messages file:`, err);
      }

      // Update background process map
      const bg = backgroundProcesses.get(oldId);
      if (bg) {
        backgroundProcesses.delete(oldId);
        backgroundProcesses.set(newId, bg);
        console.log(`[API] Updated background process map`);
      }

      return Response.json({ success: true, oldId, newId });
    })();
  }

  // POST /api/sessions/:id/update-message
  if (req.method === "POST" && path.match(/^\/api\/sessions\/[^/]+\/update-message$/)) {
    return (async () => {
      const id = path.split("/")[3];
      const body = await req.json() as { role: 'user' | 'assistant'; content: string };
      const { role, content } = body;

      if (!role || !content) {
        return new Response("Missing role or content", { status: 400 });
      }

      const session = getSession(id);

      // If session doesn't exist in sprite-mobile metadata, that's OK
      // Claude files are source of truth - we just maintain lightweight metadata for UI
      if (!session) {
        const sessions = loadSessions();
        const preview = content.slice(0, 100);
        const newSession = {
          id,
          name: role === 'user' ? preview : "New Chat",
          cwd: process.env.HOME || "/home/sprite",
          createdAt: Date.now(),
          lastMessageAt: Date.now(),
          lastMessage: preview,
        };
        sessions.unshift(newSession);
        saveSessions(sessions);
      } else {
        // Update existing metadata
        const preview = content.slice(0, 100);
        updateSession(id, {
          lastMessage: preview,
          lastMessageAt: Date.now()
        });
      }

      return Response.json({ success: true });
    })();
  }

  // DELETE /api/sessions/:id
  if (req.method === "DELETE" && path.startsWith("/api/sessions/")) {
    const id = path.split("/")[3];
    const bg = backgroundProcesses.get(id);
    if (bg) {
      try { bg.process.kill(9); } catch {}
      backgroundProcesses.delete(id);
    }
    let sessions = loadSessions();
    sessions = sessions.filter(s => s.id !== id);
    saveSessions(sessions);
    deleteMessagesFile(id);

    // Broadcast to all clients to refresh their session lists
    broadcastToAll({ type: "refresh_sessions" });

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
        publicUrl: body.publicUrl,
        createdAt: Date.now(),
      };
      sprites.push(newSprite);
      saveSprites(sprites);
      return Response.json(newSprite);
    })();
  }

  // PATCH /api/sprites/:id
  if (req.method === "PATCH" && path.match(/^\/api\/sprites\/[^/]+$/)) {
    return (async () => {
      const id = path.split("/")[3];
      const body = await req.json().catch(() => ({}));
      const sprites = loadSprites();
      const sprite = sprites.find(s => s.id === id);
      if (!sprite) return new Response("Not found", { status: 404 });
      if (body.name) sprite.name = body.name;
      if (body.address) sprite.address = body.address;
      if (body.port) sprite.port = body.port;
      if (body.publicUrl !== undefined) sprite.publicUrl = body.publicUrl;
      saveSprites(sprites);
      return Response.json(sprite);
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

  // GET /api/network/status - Check if network is configured
  if (req.method === "GET" && path === "/api/network/status") {
    return Response.json(getNetworkInfo());
  }

  // GET /api/network/sprites - Discover sprites in the network
  if (req.method === "GET" && path === "/api/network/sprites") {
    return (async () => {
      const sprites = await discoverSprites();
      const currentHostname = getHostname();

      const spritesWithStatus = sprites.map(s => ({
        ...s,
        status: getSpriteStatus(s),
        isSelf: s.hostname === currentHostname,
      }));

      return Response.json(spritesWithStatus);
    })();
  }

  // POST /api/network/heartbeat - Manual heartbeat trigger
  if (req.method === "POST" && path === "/api/network/heartbeat") {
    return (async () => {
      await updateHeartbeat();
      return Response.json({ ok: true });
    })();
  }

  // DELETE /api/network/sprites/:hostname - Remove a sprite from the network
  if (req.method === "DELETE" && path.startsWith("/api/network/sprites/")) {
    const spriteHostname = path.replace("/api/network/sprites/", "");
    if (!spriteHostname) {
      return new Response("Hostname required", { status: 400 });
    }
    return (async () => {
      try {
        await deleteSprite(spriteHostname);
        return Response.json({ ok: true, deleted: spriteHostname });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    })();
  }

  // POST /api/upload?session={sessionId}
  if (req.method === "POST" && path === "/api/upload") {
    return (async () => {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) {
        return new Response("Session ID required", { status: 400 });
      }

      // Sanitize sessionId to prevent path traversal
      const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
      if (sanitizedSessionId !== sessionId || sanitizedSessionId.length === 0) {
        return new Response("Invalid session ID", { status: 400 });
      }

      try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;

        if (!file) {
          return new Response("No file provided", { status: 400 });
        }

        if (!file.type.startsWith("image/")) {
          return new Response("Only images are allowed", { status: 400 });
        }

        // Only read first 12 bytes for format detection (magic bytes check)
        const blobSlice = file.slice(0, 12);
        const headerBuffer = await blobSlice.arrayBuffer();

        // Detect actual image format from file content
        const imageFormat = detectImageFormat(headerBuffer);
        if (!imageFormat) {
          return new Response("Unsupported or invalid image format", { status: 400 });
        }

        const sessionUploadsDir = join(UPLOADS_DIR, sanitizedSessionId);
        if (!existsSync(sessionUploadsDir)) {
          mkdirSync(sessionUploadsDir, { recursive: true });
        }

        const id = generateId();
        const filename = `${id}.${imageFormat.ext}`;
        const filePath = join(sessionUploadsDir, filename);

        // Now read full file for saving
        const fullBuffer = await file.arrayBuffer();
        writeFileSync(filePath, Buffer.from(fullBuffer));

        return Response.json({
          id,
          filename,
          mediaType: imageFormat.mediaType,
          url: `/api/uploads/${sanitizedSessionId}/${filename}`,
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

    // Sanitize sessionId and filename to prevent path traversal
    const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '');

    if (sanitizedSessionId !== sessionId || sanitizedFilename !== filename ||
        sanitizedSessionId.length === 0 || sanitizedFilename.length === 0) {
      return new Response("Invalid parameters", { status: 400 });
    }

    const filePath = join(UPLOADS_DIR, sanitizedSessionId, sanitizedFilename);

    try {
      if (!existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
      }
      const content = readFileSync(filePath);
      const contentType = sanitizedFilename.endsWith(".png") ? "image/png"
        : sanitizedFilename.endsWith(".jpg") || sanitizedFilename.endsWith(".jpeg") ? "image/jpeg"
        : sanitizedFilename.endsWith(".gif") ? "image/gif"
        : sanitizedFilename.endsWith(".webp") ? "image/webp"
        : "application/octet-stream";
      return new Response(content, {
        headers: { "Content-Type": contentType },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // Distributed Tasks API

  // POST /api/distributed-tasks - Create a task
  if (req.method === "POST" && path === "/api/distributed-tasks") {
    return (async () => {
      const body = await req.json();
      const result = await distributedTasks.createTask({ body, params: {}, method: "POST" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 400 });
      }
      return Response.json(result);
    })();
  }

  // POST /api/distributed-tasks/distribute - Distribute tasks to available sprites
  if (req.method === "POST" && path === "/api/distributed-tasks/distribute") {
    return (async () => {
      const body = await req.json();
      const result = await distributedTasks.distributeTasks({ body, params: {}, method: "POST" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 400 });
      }
      return Response.json(result);
    })();
  }

  // POST /api/distributed-tasks/check - Check for new tasks
  if (req.method === "POST" && path === "/api/distributed-tasks/check") {
    return (async () => {
      const result = await distributedTasks.checkForTasks({ body: {}, params: {}, method: "POST" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 503 });
      }
      return Response.json(result);
    })();
  }

  // POST /api/distributed-tasks/check-and-start - Check for tasks and start in detachable session
  if (req.method === "POST" && path === "/api/distributed-tasks/check-and-start") {
    return (async () => {
      const result = await distributedTasks.checkAndStartTask({ body: {}, params: {}, method: "POST" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 503 });
      }
      return Response.json(result);
    })();
  }

  // POST /api/distributed-tasks/complete - Complete current task
  if (req.method === "POST" && path === "/api/distributed-tasks/complete") {
    return (async () => {
      const body = await req.json();
      const result = await distributedTasks.completeTask({ body, params: {}, method: "POST" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 400 });
      }
      return Response.json(result);
    })();
  }

  // GET /api/distributed-tasks - List all tasks
  if (req.method === "GET" && path === "/api/distributed-tasks") {
    return (async () => {
      const result = await distributedTasks.listTasks({ body: {}, params: {}, method: "GET" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 503 });
      }
      return Response.json(result);
    })();
  }

  // GET /api/distributed-tasks/mine - Get my tasks
  if (req.method === "GET" && path === "/api/distributed-tasks/mine") {
    return (async () => {
      const result = await distributedTasks.getMyTasks({ body: {}, params: {}, method: "GET" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 503 });
      }
      return Response.json(result);
    })();
  }

  // GET /api/distributed-tasks/status - Get all sprites status
  if (req.method === "GET" && path === "/api/distributed-tasks/status") {
    return (async () => {
      const result = await distributedTasks.getStatus({ body: {}, params: {}, method: "GET" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 503 });
      }
      return Response.json(result);
    })();
  }

  // POST /api/distributed-tasks/:id/cancel - Cancel a task
  if (req.method === "POST" && path.match(/^\/api\/distributed-tasks\/[^/]+\/cancel$/)) {
    const id = path.split("/")[3];
    return (async () => {
      const result = await distributedTasks.cancelTask({ body: {}, params: { id }, method: "POST" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 400 });
      }
      return Response.json(result);
    })();
  }

  // POST /api/distributed-tasks/:id/reassign - Reassign a task
  if (req.method === "POST" && path.match(/^\/api\/distributed-tasks\/[^/]+\/reassign$/)) {
    const id = path.split("/")[3];
    return (async () => {
      const body = await req.json();
      const result = await distributedTasks.reassignTask({ body, params: { id }, method: "POST" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 400 });
      }
      return Response.json(result);
    })();
  }

  // GET /api/distributed-tasks/:id - Get a specific task
  if (req.method === "GET" && path.match(/^\/api\/distributed-tasks\/[^/]+$/)) {
    const id = path.split("/")[3];
    return (async () => {
      const result = await distributedTasks.getTask({ body: {}, params: { id }, method: "GET" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 404 });
      }
      return Response.json(result);
    })();
  }

  // DELETE /api/distributed-tasks/history - Clear completed/failed tasks
  if (req.method === "DELETE" && path === "/api/distributed-tasks/history") {
    return (async () => {
      const result = await distributedTasks.clearHistory();
      return Response.json(result);
    })();
  }

  // PATCH /api/distributed-tasks/:id - Update a task
  if (req.method === "PATCH" && path.match(/^\/api\/distributed-tasks\/[^/]+$/)) {
    const id = path.split("/")[3];
    return (async () => {
      const body = await req.json();
      const result = await distributedTasks.updateTaskStatus({ body, params: { id }, method: "PATCH" } as any);
      if (result.error) {
        return Response.json(result, { status: result.status || 400 });
      }
      return Response.json(result);
    })();
  }

  // GET /api/keepalive/status - Check if keepalive process is running
  if (req.method === "GET" && path === "/api/keepalive/status") {
    return (async () => {
      try {
        // Check if process is running using pgrep
        const result = spawn(["pgrep", "-f", "session-keepalive.sh"], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const output = await new Response(result.stdout).text();
        const pid = output.trim();

        if (pid) {
          return Response.json({
            running: true,
            pid: parseInt(pid)
          });
        }

        return Response.json({ running: false });
      } catch (err) {
        console.error("Failed to check keepalive status:", err);
        return Response.json({ running: false, error: String(err) }, { status: 500 });
      }
    })();
  }

  // POST /api/keepalive/start - Start the keepalive process
  if (req.method === "POST" && path === "/api/keepalive/start") {
    return (async () => {
      try {
        // Check if already running
        const checkResult = spawn(["pgrep", "-f", "session-keepalive.sh"], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const pid = (await new Response(checkResult.stdout).text()).trim();

        if (pid) {
          console.log(`[Keepalive] Already running (PID: ${pid})`);
          return Response.json({
            success: true,
            message: "Keepalive already running",
            pid: parseInt(pid)
          });
        }

        // Start keepalive as background process
        const scriptPath = join(process.env.HOME || "/home/sprite", ".sprite-mobile/scripts/session-keepalive.sh");
        const logPath = join(process.env.HOME || "/home/sprite", ".sprite-mobile/data/keepalive.log");

        spawn(["bash", scriptPath], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: process.env,
          detached: true,
          // Redirect output to log file
          onExit: (proc, code) => {
            console.log(`[Keepalive] Process exited with code ${code}`);
          }
        });

        // Wait a moment for process to start
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify it started
        const verifyResult = spawn(["pgrep", "-f", "session-keepalive.sh"], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const newPid = (await new Response(verifyResult.stdout).text()).trim();

        if (newPid) {
          console.log(`[Keepalive] Started successfully (PID: ${newPid})`);
          return Response.json({ success: true, message: "Keepalive started", pid: parseInt(newPid) });
        } else {
          console.error("[Keepalive] Failed to start (process not found after spawn)");
          return Response.json({ success: false, error: "Failed to start keepalive process" }, { status: 500 });
        }
      } catch (err) {
        console.error("[Keepalive] Error starting:", err);
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    })();
  }

  // POST /api/keepalive/stop - Stop the keepalive process
  if (req.method === "POST" && path === "/api/keepalive/stop") {
    return (async () => {
      try {
        // Find the process
        const checkResult = spawn(["pgrep", "-f", "session-keepalive.sh"], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const pid = (await new Response(checkResult.stdout).text()).trim();

        if (!pid) {
          return Response.json({ success: true, message: "Keepalive not running" });
        }

        // Kill the process
        const killResult = spawn(["kill", pid], {
          stdout: "pipe",
          stderr: "pipe"
        });

        await killResult.exited;

        if (killResult.exitCode === 0) {
          console.log(`[Keepalive] Stopped process (PID: ${pid})`);
          return Response.json({ success: true, message: "Keepalive stopped" });
        } else {
          const error = await new Response(killResult.stderr).text();
          console.error("[Keepalive] Failed to stop:", error);
          return Response.json({ success: false, error }, { status: 500 });
        }
      } catch (err) {
        console.error("[Keepalive] Error stopping:", err);
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    })();
  }

  return null;
}
