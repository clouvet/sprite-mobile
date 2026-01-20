import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { ChatSession, StoredMessage, SpriteProfile } from "./types";

// Directories
export const DATA_DIR = join(import.meta.dir, "..", "data");
export const MESSAGES_DIR = join(DATA_DIR, "messages");
export const UPLOADS_DIR = join(DATA_DIR, "uploads");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const SPRITES_FILE = join(DATA_DIR, "sprites.json");

// Ensure directories exist
export function ensureDirectories() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(MESSAGES_DIR)) mkdirSync(MESSAGES_DIR, { recursive: true });
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Generate UUID
export function generateId(): string {
  return crypto.randomUUID();
}

// Session storage
export function loadSessions(): ChatSession[] {
  try {
    if (existsSync(SESSIONS_FILE)) {
      return JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

export function saveSessions(sessions: ChatSession[]) {
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

export function getSession(id: string): ChatSession | undefined {
  return loadSessions().find(s => s.id === id);
}

export function updateSession(id: string, updates: Partial<ChatSession>) {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === id);
  if (session) {
    Object.assign(session, updates);
    saveSessions(sessions);
  }
}

// Sprite storage
export function loadSprites(): SpriteProfile[] {
  try {
    if (existsSync(SPRITES_FILE)) {
      return JSON.parse(readFileSync(SPRITES_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

export function saveSprites(sprites: SpriteProfile[]) {
  writeFileSync(SPRITES_FILE, JSON.stringify(sprites, null, 2));
}

// Message storage
export function getMessagesFile(sessionId: string): string {
  return join(MESSAGES_DIR, `${sessionId}.json`);
}

export function loadMessages(sessionId: string): StoredMessage[] {
  try {
    const file = getMessagesFile(sessionId);
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch {}
  return [];
}

export function saveMessage(sessionId: string, msg: StoredMessage) {
  const messages = loadMessages(sessionId);
  messages.push(msg);
  writeFileSync(getMessagesFile(sessionId), JSON.stringify(messages, null, 2));
}

export function deleteMessagesFile(sessionId: string) {
  try {
    const msgFile = getMessagesFile(sessionId);
    if (existsSync(msgFile)) unlinkSync(msgFile);
  } catch {}
}

export function saveMessages(sessionId: string, messages: StoredMessage[]) {
  writeFileSync(getMessagesFile(sessionId), JSON.stringify(messages, null, 2));
}

// In-progress message storage for surviving refreshes
function getInProgressFile(sessionId: string): string {
  return join(MESSAGES_DIR, `${sessionId}.inprogress.json`);
}

export function saveInProgressMessage(sessionId: string, content: string) {
  const file = getInProgressFile(sessionId);
  const msg: StoredMessage = {
    role: "assistant",
    content,
    timestamp: Date.now(),
  };
  writeFileSync(file, JSON.stringify(msg, null, 2));
}

export function clearInProgressMessage(sessionId: string) {
  const file = getInProgressFile(sessionId);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {}
}

export function getInProgressMessage(sessionId: string): StoredMessage | null {
  const file = getInProgressFile(sessionId);
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch {}
  return null;
}
