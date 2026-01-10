import { spawn } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { ChatSession, SpriteProfile } from "../lib/types";
import {
  loadSessions, saveSessions, getSession, updateSession,
  loadSprites, saveSprites,
  loadMessages, deleteMessagesFile,
  generateId, UPLOADS_DIR
} from "../lib/storage";
import { backgroundProcesses, trySend } from "../lib/claude";
import { discoverSprites, getSpriteStatus, getNetworkInfo, getHostname, updateHeartbeat } from "../lib/network";

// Public URL from environment
const SPRITE_PUBLIC_URL = process.env.SPRITE_PUBLIC_URL || "";

export function handleApi(req: Request, url: URL): Response | Promise<Response> | null {
  const path = url.pathname;

  // GET /api/config - returns public configuration for the client
  if (req.method === "GET" && path === "/api/config") {
    return Response.json({
      publicUrl: SPRITE_PUBLIC_URL,
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

        if (!file.type.startsWith("image/")) {
          return new Response("Only images are allowed", { status: 400 });
        }

        const sessionUploadsDir = join(UPLOADS_DIR, sessionId);
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
