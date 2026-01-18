import type { Request } from "express";
import * as tasks from "../lib/distributed-tasks";
import { discoverSprites } from "../lib/network";
import { spawn } from "child_process";

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

  // Wake the target sprite and tell it to check for tasks
  wakeAndNotifySprite(assignedTo).catch(err => {
    console.error(`Failed to wake sprite ${assignedTo}:`, err);
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

async function wakeAndNotifySprite(spriteName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sprite", [
      "-s",
      spriteName,
      "exec",
      "--",
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

  return { message: "Started task", task: nextTask, sessionId };
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

Get started!`;

  const initialMessage = {
    role: "user" as const,
    content: taskPrompt,
    timestamp: Date.now(),
  };

  saveMessages(newSession.id, [initialMessage]);

  return newSession.id;
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
