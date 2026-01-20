import type { Request } from "express";
import * as tasks from "../lib/distributed-tasks";
import { discoverSprites } from "../lib/network";
import { spawn } from "child_process";
import type { BackgroundProcess } from "../lib/types";
import {
  backgroundProcesses,
  spawnClaude,
  handleClaudeOutput,
  handleClaudeStderr,
} from "../lib/claude";
import { getSession } from "../lib/storage";

export async function createTask(req: Request): Promise<any> {
  const { assignedTo, title, description } = req.body;

  if (!assignedTo || !title || !description) {
    return { error: "Missing required fields: assignedTo, title, description", status: 400 };
  }

  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  const assignedBy = (await import("../lib/network")).getHostname();

  const task = await tasks.createTask({
    assignedTo,
    assignedBy,
    title,
    description,
  });

  // Mark as in progress and create session immediately
  await tasks.updateTask(task.id, {
    status: "in_progress",
    startedAt: new Date().toISOString(),
  });

  // Create a Claude session for this task
  const sessionId = await createTaskSession(task);

  // Update task with session ID
  await tasks.updateTask(task.id, {
    sessionId,
  });

  // Start Claude on the target sprite using sprite exec with --resume
  // This creates a detachable session that keeps the sprite alive
  wakeAndStartTaskOnSprite(assignedTo, sessionId).catch(err => {
    console.error(`Failed to start task on ${assignedTo}:`, err);
  });

  return { task };
}

export async function distributeTasks(req: Request): Promise<any> {
  const { taskDescriptions } = req.body;

  if (!Array.isArray(taskDescriptions) || taskDescriptions.length === 0) {
    return { error: "taskDescriptions must be a non-empty array", status: 400 };
  }

  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  const assignedBy = (await import("../lib/network")).getHostname();

  // Get available sprites (excluding self)
  const sprites = await discoverSprites();
  const availableSprites = sprites
    .filter(s => s.hostname !== assignedBy)
    .map(s => s.hostname);

  if (availableSprites.length === 0) {
    return { error: "No other sprites available in network", status: 400 };
  }

  // Distribute tasks round-robin
  const createdTasks = [];
  for (let i = 0; i < taskDescriptions.length; i++) {
    const { title, description } = taskDescriptions[i];
    const assignedTo = availableSprites[i % availableSprites.length];

    const task = await tasks.createTask({
      assignedTo,
      assignedBy,
      title,
      description,
    });

    createdTasks.push(task);

    // Wake the sprite
    wakeAndNotifySprite(assignedTo).catch(err => {
      console.error(`Failed to wake sprite ${assignedTo}:`, err);
    });
  }

  return { tasks: createdTasks, distribution: summarizeDistribution(createdTasks) };
}

function summarizeDistribution(tasks: tasks.DistributedTask[]): Record<string, number> {
  const distribution: Record<string, number> = {};
  for (const task of tasks) {
    distribution[task.assignedTo] = (distribution[task.assignedTo] || 0) + 1;
  }
  return distribution;
}

async function wakeAndStartTaskOnSprite(spriteName: string, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use sprite exec to run Claude with --resume to use the session we already created
    // This avoids shell escaping issues and creates a detachable session
    console.log(`Starting Claude on ${spriteName} for session ${sessionId}`);

    const proc = spawn("sprite", [
      "exec",
      "-s",
      spriteName,
      "claude",
      "--resume",
      sessionId
    ]);

    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
    });

    proc.stderr.on("data", (data) => {
      output += data.toString();
    });

    proc.on("close", (code) => {
      console.log(`Claude session completed on ${spriteName}, output length: ${output.length}`);
      if (code === 0 || output.length > 0) {
        // Consider it successful if we got output, even if exit code is non-zero
        resolve();
      } else {
        console.error(`Failed to start Claude on ${spriteName}:`, output);
        reject(new Error(`Failed to start Claude on ${spriteName}: ${output}`));
      }
    });
  });
}

// Keep the old function for backward compatibility but make it call check
async function wakeAndNotifySprite(spriteName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sprite", [
      "exec",
      "-s",
      spriteName,
      "curl",
      "-X",
      "POST",
      "http://localhost:8081/api/distributed-tasks/check"
    ]);

    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
    });

    proc.stderr.on("data", (data) => {
      output += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`Notified ${spriteName} to check for tasks`);
        resolve();
      } else {
        reject(new Error(`Failed to notify ${spriteName}: ${output}`));
      }
    });
  });
}

export async function checkForTasks(_req: Request): Promise<any> {
  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  const spriteName = (await import("../lib/network")).getHostname();
  const queue = await tasks.getTaskQueue(spriteName);

  // If already working on a task, don't start a new one
  if (queue.currentTask) {
    return { message: "Already working on a task", currentTask: queue.currentTask };
  }

  // Get next task
  const nextTask = await tasks.getNextTask(spriteName);

  if (!nextTask) {
    return { message: "No pending tasks" };
  }

  // Mark as in progress
  await tasks.updateTask(nextTask.id, {
    status: "in_progress",
    startedAt: new Date().toISOString(),
  });

  // Create a Claude session for this task
  const sessionId = await createTaskSession(nextTask);

  // Update task with session ID
  await tasks.updateTask(nextTask.id, {
    sessionId,
  });

  // Spawn Claude process to work on the task autonomously
  await spawnClaudeForTask(sessionId);

  return { message: "Started task", task: nextTask, sessionId };
}

export async function checkAndStartTask(_req: Request): Promise<any> {
  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  const spriteName = (await import("../lib/network")).getHostname();
  const queue = await tasks.getTaskQueue(spriteName);

  // If already working on a task, don't start a new one
  if (queue.currentTask) {
    return { message: "Already working on a task", currentTask: queue.currentTask };
  }

  // Get next task
  const nextTask = await tasks.getNextTask(spriteName);

  if (!nextTask) {
    return { message: "No pending tasks" };
  }

  // Mark as in progress
  await tasks.updateTask(nextTask.id, {
    status: "in_progress",
    startedAt: new Date().toISOString(),
  });

  // Create a Claude session for this task
  const sessionId = await createTaskSession(nextTask);

  // Update task with session ID
  await tasks.updateTask(nextTask.id, {
    sessionId,
  });

  // Start Claude in a detachable session using sprite exec
  // This keeps the sprite alive while Claude works on the task
  const taskPrompt = (await import("../lib/storage")).loadMessages(sessionId)[0].content;

  console.log(`Starting detachable Claude session for task ${nextTask.id} on session ${sessionId}`);

  // Spawn Claude via command line in the background
  // The Claude session becomes a detachable session that keeps the sprite alive
  spawn("claude", [
    "-p",
    taskPrompt,
    "--resume",
    sessionId
  ], {
    detached: true,
    stdio: 'ignore'
  }).unref();

  return { message: "Started task in detachable session", task: nextTask, sessionId };
}

async function createTaskSession(task: tasks.DistributedTask): Promise<string> {
  const { loadSessions, saveSessions, saveMessages, generateId } = await import("../lib/storage");
  const { ChatSession, StoredMessage } = await import("../lib/types");

  const sessions = loadSessions();

  const newSession = {
    id: generateId(),
    name: `Task: ${task.title}`,
    cwd: process.env.HOME || "/home/sprite",
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
  };

  sessions.push(newSession);
  saveSessions(sessions);

  // Add initial message to the session explaining the task
  const taskPrompt = `You have been assigned a task by ${task.assignedBy}:

**Task:** ${task.title}

**Description:**
${task.description}

**Instructions:**
1. Complete the task described above
2. When finished, report back with a summary of what you accomplished
3. Use the following API endpoint to mark the task complete:

POST /api/distributed-tasks/complete
{
  "summary": "Your summary of what was accomplished",
  "success": true
}

**Git Workflow (for repository work):**

If this task involves working on a git repository, follow this workflow:

1. **Before starting work**: Create a descriptive feature branch
   - Use format: "feat/brief-description" for features, "fix/brief-description" for fixes
   - Example: \`git checkout -b feat/add-user-authentication\`

2. **After completing the work**:
   - Stage and commit your changes with a clear commit message
   - Example: \`git add . && git commit -m "Add user authentication feature"\`

3. **Push and create PR**:
   - Push the branch: \`git push -u origin <branch-name>\`
   - Create a pull request using gh CLI:
     \`gh pr create --title "Your PR title" --body "Description of changes"\`

4. **Include PR URL in completion summary**:
   - The completion summary should include the PR URL for tracking
   - Example: "Completed task X. Created PR: https://github.com/org/repo/pull/123"

**Note:** If the task does not involve a git repository or the repository is not configured for remote pushes, skip the git workflow and just complete the task normally.

Get started!`;

  const initialMessage = {
    role: "user" as const,
    content: taskPrompt,
    timestamp: Date.now(),
  };

  saveMessages(newSession.id, [initialMessage]);

  return newSession.id;
}

async function spawnClaudeForTask(sessionId: string): Promise<void> {
  // Check if there's already a background process for this session
  if (backgroundProcesses.has(sessionId)) {
    console.log(`Claude process already running for session ${sessionId}`);
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const { loadMessages } = await import("../lib/storage");
  const messages = loadMessages(sessionId);

  if (messages.length === 0) {
    throw new Error(`No messages found for session ${sessionId}`);
  }

  const cwd = session.cwd || process.env.HOME || "/home/sprite";
  const claudeSessionId = session.claudeSessionId;

  console.log(`Spawning autonomous Claude process for task session ${sessionId}`);

  // Spawn Claude process
  const process = spawnClaude(cwd, claudeSessionId);

  // Create background process with no clients (runs detached)
  const bg: BackgroundProcess = {
    process,
    buffer: "",
    assistantBuffer: "",
    sessionId,
    clients: new Set(), // No WebSocket clients - runs in background
    startedAt: Date.now(),
    isGenerating: false,
  };

  backgroundProcesses.set(sessionId, bg);

  // Start handling output - continues autonomously
  handleClaudeOutput(bg);
  handleClaudeStderr(bg);

  // Give the process a moment to initialize
  await new Promise(resolve => setTimeout(resolve, 100));

  // Send the initial message to Claude's stdin to start the conversation
  const initialMessage = messages[messages.length - 1]; // Get the last (most recent) message
  if (initialMessage.role === "user") {
    const claudeMessage = JSON.stringify({
      type: "user",
      content: initialMessage.content,
    }) + "\n";

    try {
      bg.process.stdin.write(claudeMessage);
      console.log(`Sent initial message to Claude process for session ${sessionId}`);
    } catch (err) {
      console.error(`Failed to send initial message to Claude:`, err);
    }
  }

  console.log(`Claude process spawned for task session ${sessionId} - running autonomously`);
}

export async function completeTask(req: Request): Promise<any> {
  const { summary, success, error } = req.body;

  if (!summary) {
    return { error: "Missing required field: summary", status: 400 };
  }

  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  const spriteName = (await import("../lib/network")).getHostname();

  try {
    await tasks.completeCurrentTask(spriteName, summary, success !== false, error);

    // Check for next task
    const nextTask = await tasks.getNextTask(spriteName);

    if (nextTask) {
      // Mark as in progress
      await tasks.updateTask(nextTask.id, {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      });

      // Create session for next task
      const sessionId = await createTaskSession(nextTask);
      await tasks.updateTask(nextTask.id, { sessionId });

      // Spawn Claude process for the next task
      await spawnClaudeForTask(sessionId);

      return { message: "Task completed, started next task", nextTask, sessionId };
    }

    return { message: "Task completed, no more tasks in queue" };
  } catch (err: any) {
    return { error: err.message, status: 400 };
  }
}

export async function listTasks(_req: Request): Promise<any> {
  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  const allTasks = await tasks.listAllTasks();

  return { tasks: allTasks };
}

export async function getTask(req: Request): Promise<any> {
  const { id } = req.params;

  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  const task = await tasks.getTask(id);

  if (!task) {
    return { error: "Task not found", status: 404 };
  }

  return { task };
}

export async function updateTaskStatus(req: Request): Promise<any> {
  const { id } = req.params;
  const updates = req.body;

  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  try {
    await tasks.updateTask(id, updates);
    const task = await tasks.getTask(id);
    return { task };
  } catch (err: any) {
    return { error: err.message, status: 400 };
  }
}

export async function getMyTasks(_req: Request): Promise<any> {
  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  const myTasks = await tasks.getMyTasks();

  return myTasks;
}

export async function getStatus(_req: Request): Promise<any> {
  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  const statuses = await tasks.getAllSpritesStatus();

  return { sprites: statuses };
}

export async function cancelTask(req: Request): Promise<any> {
  const { id } = req.params;

  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  try {
    await tasks.cancelTask(id);
    return { message: "Task cancelled successfully", taskId: id };
  } catch (err: any) {
    return { error: err.message, status: 400 };
  }
}

export async function reassignTask(req: Request): Promise<any> {
  const { id } = req.params;
  const { assignedTo } = req.body;

  if (!assignedTo) {
    return { error: "Missing required field: assignedTo", status: 400 };
  }

  if (!tasks.isTasksNetworkEnabled()) {
    return { error: "Distributed tasks not configured", status: 503 };
  }

  try {
    await tasks.reassignTask(id, assignedTo);

    // Wake the new sprite to pick up the task
    wakeAndNotifySprite(assignedTo).catch(err => {
      console.error(`Failed to wake sprite ${assignedTo}:`, err);
    });

    const task = await tasks.getTask(id);
    return { message: "Task reassigned successfully", task };
  } catch (err: any) {
    return { error: err.message, status: 400 };
  }
}
