import { spawn, type Subprocess } from "bun";
import type { BackgroundProcess } from "./types";
import { saveMessage, updateSession } from "./storage";

// Background process tracking - persists across WebSocket reconnects
export const backgroundProcesses = new Map<string, BackgroundProcess>();

// Broadcast to all connected clients
export function trySend(bg: BackgroundProcess, data: string) {
  for (const ws of bg.clients) {
    if (ws.readyState === 1) { // OPEN
      try {
        ws.send(data);
      } catch {
        bg.clients.delete(ws);
      }
    } else {
      bg.clients.delete(ws);
    }
  }
}

// Spawn Claude process
export function spawnClaude(cwd: string, claudeSessionId?: string): Subprocess {
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

// Generate a chat name from the first message using Claude
export async function generateChatName(message: string, sessionId: string, bg: BackgroundProcess): Promise<void> {
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

// Handle Claude output - continues even if client disconnects
export async function handleClaudeOutput(bg: BackgroundProcess) {
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
            bg.isGenerating = false;
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
  backgroundProcesses.delete(bg.sessionId);
}

// Handle stderr - just forward to client if connected
export async function handleClaudeStderr(bg: BackgroundProcess) {
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

// Cleanup stale processes
export function cleanupStaleProcesses() {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [sessionId, bg] of backgroundProcesses) {
    if (now - bg.startedAt > maxAge && bg.clients.size === 0) {
      console.log(`Cleaning up stale process for session ${sessionId}`);
      try { bg.process.kill(9); } catch {}
      backgroundProcesses.delete(sessionId);
      updateSession(sessionId, { isProcessing: false });
    }
  }
}
