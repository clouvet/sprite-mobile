import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { BackgroundProcess, StoredMessage } from "../lib/types";
import { loadMessages, saveMessage, getSession, updateSession, UPLOADS_DIR, getInProgressMessage } from "../lib/storage";
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

      // Send history to this new client (including any in-progress message)
      const messages = loadMessages(sessionId);
      const inProgress = getInProgressMessage(sessionId);
      const allMessages = inProgress ? [...messages, inProgress] : messages;
      if (allMessages.length > 0) {
        ws.send(JSON.stringify({ type: "history", messages: allMessages }));
      }

      // Only notify if Claude is actively generating a response
      if (existingBg.isGenerating) {
        ws.send(JSON.stringify({ type: "system", message: "Joined session - Claude is still working", sessionId }));
        ws.send(JSON.stringify({ type: "processing", isProcessing: true }));
      }
      return;
    }

    console.log(`Client connected to session ${sessionId}${claudeSessionId ? ` (resuming ${claudeSessionId})` : ""}`);

    // Send stored message history (including any in-progress message)
    const messages = loadMessages(sessionId);
    const inProgress = getInProgressMessage(sessionId);
    const allMessages = inProgress ? [...messages, inProgress] : messages;
    if (allMessages.length > 0) {
      ws.send(JSON.stringify({ type: "history", messages: allMessages }));
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

    let bg = backgroundProcesses.get(sessionId);

    // If no background process exists, check if this is a user message and spawn a new one
    if (!bg) {
      try {
        const data = JSON.parse(message.toString());

        // Only spawn new process for user messages, not for interrupts
        if (data.type === "user" && (data.content || data.imageId)) {
          console.log(`Spawning new Claude process for session ${sessionId} after interruption`);
          const session = getSession(sessionId);
          const cwd = session?.cwd || process.env.HOME || "/home/sprite";
          const claudeSessionId = session?.claudeSessionId;

          const process = spawnClaude(cwd, claudeSessionId);
          bg = {
            process,
            buffer: "",
            assistantBuffer: "",
            sessionId,
            clients: new Set([ws]),
            startedAt: Date.now(),
            isGenerating: false,
          };
          backgroundProcesses.set(sessionId, bg);

          // Start handling output
          handleClaudeOutput(bg);
          handleClaudeStderr(bg);

          // Small delay to let the process initialize
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          ws.send(JSON.stringify({ type: "error", message: "No active Claude process" }));
          return;
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: "No active Claude process" }));
        return;
      }
    }

    try {
      const data = JSON.parse(message.toString());

      if (data.type === "interrupt") {
        // Kill the Claude process to stop it immediately
        try {
          console.log(`Interrupting Claude process for session ${sessionId}`);
          bg.process.kill();
          backgroundProcesses.delete(sessionId);
          updateSession(sessionId, { isProcessing: false });

          // Notify clients that processing stopped
          for (const client of bg.clients) {
            if (client.readyState === 1) {
              try {
                client.send(JSON.stringify({ type: "result" }));
              } catch {}
            }
          }
        } catch (err) {
          console.error("Error interrupting process:", err);
        }
        return;
      }

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
