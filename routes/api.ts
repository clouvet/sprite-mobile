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

// Claude projects directory
const CLAUDE_PROJECTS_DIR = join(process.env.HOME || "/home/sprite", ".claude", "projects");

interface ClaudeCliSession {
  sessionId: string;
  cwd: string;
  lastModified: number;
  size: number;
  preview?: string;
}

// Discover Claude CLI sessions from ~/.claude/projects/
function discoverClaudeSessions(): ClaudeCliSession[] {
  const sessions: ClaudeCliSession[] = [];

  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    return sessions;
  }

  try {
    const cwdDirs = readdirSync(CLAUDE_PROJECTS_DIR);

    for (const cwdDir of cwdDirs) {
      const cwdPath = join(CLAUDE_PROJECTS_DIR, cwdDir);
      const stat = statSync(cwdPath);

      if (!stat.isDirectory()) continue;

      // Convert directory name back to path (e.g., "-home-sprite" -> "/home/sprite")
      const cwd = "/" + cwdDir.replace(/-/g, "/").replace(/^\/+/, "");

      // Find .jsonl files (session histories)
      const files = readdirSync(cwdPath);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const sessionId = basename(file, ".jsonl");
        const filePath = join(cwdPath, file);
        const fileStat = statSync(filePath);

        // Skip empty files
        if (fileStat.size === 0) continue;

        // Try to get first user message as preview
        let preview = "";
        try {
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n").filter(l => l.trim());
          for (const line of lines.slice(0, 20)) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === "user" && obj.message?.content) {
                const text = typeof obj.message.content === "string"
                  ? obj.message.content
                  : obj.message.content.find((c: any) => c.type === "text")?.text || "";
                if (text) {
                  preview = text.slice(0, 100);
                  break;
                }
              }
            } catch {}
          }
        } catch {}

        sessions.push({
          sessionId,
          cwd,
          lastModified: fileStat.mtimeMs,
          size: fileStat.size,
          preview,
        });
      }
    }
  } catch (err) {
    console.error("Error discovering Claude sessions:", err);
  }

  // Sort by last modified, most recent first
  sessions.sort((a, b) => b.lastModified - a.lastModified);

  return sessions;
}

// Parse CLI session .jsonl file and convert to sprite-mobile message format
function parseCliSessionMessages(cwd: string, claudeSessionId: string): StoredMessage[] {
  const messages: StoredMessage[] = [];

  // Convert cwd to directory name format (e.g., "/home/sprite" -> "-home-sprite")
  const cwdDir = cwd.replace(/\//g, "-");
  const sessionFile = join(CLAUDE_PROJECTS_DIR, cwdDir, `${claudeSessionId}.jsonl`);

  if (!existsSync(sessionFile)) {
    console.log(`CLI session file not found: ${sessionFile}`);
    return messages;
  }

  try {
    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);

        // Skip non-message types
        if (obj.type !== "user" && obj.type !== "assistant") continue;

        // Skip meta messages and tool results
        if (obj.isMeta) continue;
        if (obj.message?.content?.[0]?.type === "tool_result") continue;

        const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();

        if (obj.type === "user" && obj.message?.content) {
          // User message - extract text content
          let content = "";
          if (typeof obj.message.content === "string") {
            content = obj.message.content;
          } else if (Array.isArray(obj.message.content)) {
            // Find text content in array
            const textBlock = obj.message.content.find((c: any) => c.type === "text");
            if (textBlock) content = textBlock.text;
          }

          // Skip command messages and empty content
          if (content && !content.startsWith("<command-name>") && !content.startsWith("<local-command")) {
            messages.push({ role: "user", content, timestamp });
          }
        } else if (obj.type === "assistant" && obj.message?.content) {
          // Assistant message - extract text blocks
          let content = "";
          if (Array.isArray(obj.message.content)) {
            const textBlocks = obj.message.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text);
            content = textBlocks.join("\n\n");
          }

          if (content) {
            messages.push({ role: "assistant", content, timestamp });
          }
        }
      } catch {}
    }
  } catch (err) {
    console.error("Error parsing CLI session:", err);
  }

  return messages;
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

  // GET /api/claude-sessions - Discover Claude CLI sessions
  if (req.method === "GET" && path === "/api/claude-sessions") {
    const cliSessions = discoverClaudeSessions();
    return Response.json(cliSessions);
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
        // Support attaching to external Claude CLI sessions
        claudeSessionId: body.claudeSessionId,
      };

      // If attaching to a CLI session, import its message history
      if (body.claudeSessionId) {
        const cliMessages = parseCliSessionMessages(cwd, body.claudeSessionId);
        if (cliMessages.length > 0) {
          saveMessages(newSession.id, cliMessages);
          // Update last message preview
          const lastMsg = cliMessages[cliMessages.length - 1];
          newSession.lastMessage = lastMsg.content.slice(0, 100);
          newSession.lastMessageAt = lastMsg.timestamp;
        }
      }

      sessions.push(newSession);
      saveSessions(sessions);
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
      const session = getSession(id);
      if (!session) return new Response("Not found", { status: 404 });

      const messages = loadMessages(id);
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

        const sessionUploadsDir = join(UPLOADS_DIR, sanitizedSessionId);
        if (!existsSync(sessionUploadsDir)) {
          mkdirSync(sessionUploadsDir, { recursive: true });
        }

        const id = generateId();
        const ext = file.name.split(".").pop() || "png";
        const filename = `${id}.${ext}`;
        const filePath = join(sessionUploadsDir, filename);

        const buffer = await file.arrayBuffer();
        writeFileSync(filePath, Buffer.from(buffer));

        return Response.json({
          id,
          filename,
          mediaType: file.type,
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

  return null;
}
