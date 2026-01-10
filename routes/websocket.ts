import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { BackgroundProcess, StoredMessage } from "../lib/types";
import { loadMessages, saveMessage, getSession, updateSession, UPLOADS_DIR } from "../lib/storage";
import {
  backgroundProcesses, spawnClaude, generateChatName,
  handleClaudeOutput, handleClaudeStderr
} from "../lib/claude";

// Track all connected clients for broadcast messages (e.g., reload)
export const allClients = new Set<any>();

export const websocketHandlers = {
  open(ws: any) {
    allClients.add(ws);
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
      console.log(`Client joined session ${sessionId} (${existingBg.clients.size + 1} clients now)`);
      existingBg.clients.add(ws);

      // Send history to this new client
      const messages = loadMessages(sessionId);
      if (messages.length > 0) {
        ws.send(JSON.stringify({ type: "history", messages }));
      }

      // Only notify if Claude is actively generating a response
      if (existingBg.isGenerating) {
        ws.send(JSON.stringify({ type: "system", message: "Joined session - Claude is still working", sessionId }));
        ws.send(JSON.stringify({ type: "processing", isProcessing: true }));
      }
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
      clients: new Set([ws]),
      startedAt: Date.now(),
      isGenerating: false,
    };
    backgroundProcesses.set(sessionId, bg);

    // Start handling output (continues even if ws disconnects)
    handleClaudeOutput(bg);
    handleClaudeStderr(bg);

    ws.send(JSON.stringify({ type: "system", message: "Connected to Claude Code", sessionId }));
  },

  async message(ws: any, message: any) {
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

            // Add text - either provided content or a placeholder for image-only messages
            claudeContent.push({
              type: "text",
              text: data.content || "What's in this image?",
            });

            imageInfo = {
              id: data.imageId,
              filename: data.imageFilename,
              mediaType: data.imageMediaType,
            };
          }
        }

        // Save user message
        const userMsg: StoredMessage = {
          role: "user",
          content: data.content || "[Image]",
          timestamp: Date.now(),
          image: imageInfo,
        };
        saveMessage(sessionId, userMsg);
        updateSession(sessionId, {
          lastMessageAt: Date.now(),
          lastMessage: "You: " + (data.content ? data.content.slice(0, 50) : "[Image]"),
          isProcessing: true,
        });

        // Broadcast user message to OTHER clients (not the sender)
        for (const client of bg.clients) {
          if (client !== ws && client.readyState === 1) {
            try {
              client.send(JSON.stringify({ type: "user_message", message: userMsg }));
            } catch {}
          }
        }

        // Small delay to ensure client-side renders user message before assistant starts
        await new Promise(resolve => setTimeout(resolve, 50));

        // Send to Claude
        const claudeMsg = JSON.stringify({
          type: "user",
          message: { role: "user", content: claudeContent },
        }) + "\n";

        bg.isGenerating = true;
        bg.process.stdin.write(claudeMsg);
        bg.process.stdin.flush();
      }
    } catch (err) {
      console.error("Error handling message:", err);
    }
  },

  close(ws: any) {
    allClients.delete(ws);
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
      bg.clients.delete(ws);
      console.log(`Client left session ${sessionId} (${bg.clients.size} clients remaining)`);
    } else {
      console.log(`Client disconnected from session ${sessionId}`);
    }
  },
};
