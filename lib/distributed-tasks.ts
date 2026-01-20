import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { getHostname } from "./network";

const CREDS_PATH = process.env.SPRITE_NETWORK_CREDS || `${process.env.HOME}/.sprite-network/credentials.json`;

let s3Client: S3Client | null = null;
let bucketName: string | null = null;
let initialized = false;

export interface DistributedTask {
  id: string;
  assignedTo: string;
  assignedBy: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "abandoned";
  title: string;
  description: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  result?: {
    summary: string;
    success: boolean;
    error?: string;
  };
}

export interface TaskQueue {
  spriteName: string;
  queuedTasks: string[];
  currentTask: string | null;
  lastUpdated: string;
}

export function initTasksNetwork(): boolean {
  if (initialized) return s3Client !== null;
  initialized = true;

  if (!existsSync(CREDS_PATH)) {
    console.log("Distributed tasks not configured (no credentials file)");
    return false;
  }

  try {
    const creds = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));

    if (!creds.AWS_ACCESS_KEY_ID || !creds.AWS_SECRET_ACCESS_KEY || !creds.BUCKET_NAME) {
      console.log("Distributed tasks credentials incomplete");
      return false;
    }

    s3Client = new S3Client({
      region: "auto",
      endpoint: creds.AWS_ENDPOINT_URL_S3 || "https://fly.storage.tigris.dev",
      credentials: {
        accessKeyId: creds.AWS_ACCESS_KEY_ID,
        secretAccessKey: creds.AWS_SECRET_ACCESS_KEY,
      },
      forcePathStyle: false,
    });

    bucketName = creds.BUCKET_NAME;

    console.log(`Distributed tasks initialized: bucket=${bucketName}`);
    return true;
  } catch (err) {
    console.error("Failed to initialize distributed tasks:", err);
    return false;
  }
}

export function isTasksNetworkEnabled(): boolean {
  return s3Client !== null && bucketName !== null;
}

export async function createTask(task: Omit<DistributedTask, "id" | "createdAt" | "status">): Promise<DistributedTask> {
  if (!s3Client || !bucketName) {
    throw new Error("Tasks network not initialized");
  }

  const fullTask: DistributedTask = {
    ...task,
    id: randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `tasks/${fullTask.id}.json`,
    Body: JSON.stringify(fullTask, null, 2),
    ContentType: "application/json",
  }));

  // Add to target sprite's queue
  await addTaskToQueue(task.assignedTo, fullTask.id);

  console.log(`Created task ${fullTask.id} for ${task.assignedTo}`);
  return fullTask;
}

export async function updateTask(taskId: string, updates: Partial<DistributedTask>): Promise<void> {
  if (!s3Client || !bucketName) {
    throw new Error("Tasks network not initialized");
  }

  // Get existing task
  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Merge updates
  const updatedTask = { ...task, ...updates };

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `tasks/${taskId}.json`,
    Body: JSON.stringify(updatedTask, null, 2),
    ContentType: "application/json",
  }));

  console.log(`Updated task ${taskId}`);
}

export async function getTask(taskId: string): Promise<DistributedTask | null> {
  if (!s3Client || !bucketName) {
    throw new Error("Tasks network not initialized");
  }

  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: `tasks/${taskId}.json`,
    }));

    const body = await response.Body?.transformToString();
    if (!body) return null;

    return JSON.parse(body);
  } catch (err: any) {
    if (err.name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}

export async function listAllTasks(): Promise<DistributedTask[]> {
  if (!s3Client || !bucketName) {
    throw new Error("Tasks network not initialized");
  }

  try {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: "tasks/",
    }));

    const tasks: DistributedTask[] = [];

    for (const obj of response.Contents || []) {
      if (!obj.Key?.endsWith(".json")) continue;

      try {
        const data = await s3Client.send(new GetObjectCommand({
          Bucket: bucketName,
          Key: obj.Key,
        }));

        const body = await data.Body?.transformToString();
        if (body) {
          tasks.push(JSON.parse(body));
        }
      } catch (err) {
        console.error(`Failed to read task ${obj.Key}:`, err);
      }
    }

    return tasks;
  } catch (err) {
    console.error("Failed to list tasks:", err);
    return [];
  }
}

export async function getTaskQueue(spriteName: string): Promise<TaskQueue> {
  if (!s3Client || !bucketName) {
    throw new Error("Tasks network not initialized");
  }

  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: `task-queues/${spriteName}.json`,
    }));

    const body = await response.Body?.transformToString();
    if (!body) {
      // Return empty queue if doesn't exist
      return {
        spriteName,
        queuedTasks: [],
        currentTask: null,
        lastUpdated: new Date().toISOString(),
      };
    }

    return JSON.parse(body);
  } catch (err: any) {
    if (err.name === "NoSuchKey") {
      return {
        spriteName,
        queuedTasks: [],
        currentTask: null,
        lastUpdated: new Date().toISOString(),
      };
    }
    throw err;
  }
}

export async function updateTaskQueue(queue: TaskQueue): Promise<void> {
  if (!s3Client || !bucketName) {
    throw new Error("Tasks network not initialized");
  }

  queue.lastUpdated = new Date().toISOString();

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `task-queues/${queue.spriteName}.json`,
    Body: JSON.stringify(queue, null, 2),
    ContentType: "application/json",
  }));

  console.log(`Updated task queue for ${queue.spriteName}`);
}

export async function addTaskToQueue(spriteName: string, taskId: string): Promise<void> {
  const queue = await getTaskQueue(spriteName);
  queue.queuedTasks.push(taskId);
  await updateTaskQueue(queue);
}

export async function getNextTask(spriteName: string): Promise<DistributedTask | null> {
  const queue = await getTaskQueue(spriteName);

  if (queue.queuedTasks.length === 0) {
    return null;
  }

  const nextTaskId = queue.queuedTasks.shift()!;
  queue.currentTask = nextTaskId;
  await updateTaskQueue(queue);

  return await getTask(nextTaskId);
}

export async function completeCurrentTask(spriteName: string, summary: string, success: boolean, error?: string): Promise<void> {
  const queue = await getTaskQueue(spriteName);

  if (!queue.currentTask) {
    throw new Error("No current task to complete");
  }

  await updateTask(queue.currentTask, {
    status: success ? "completed" : "failed",
    completedAt: new Date().toISOString(),
    result: {
      summary,
      success,
      error,
    },
  });

  queue.currentTask = null;
  await updateTaskQueue(queue);
}

export async function getMyTasks(): Promise<{ current: DistributedTask | null; queued: DistributedTask[] }> {
  const spriteName = getHostname();
  const queue = await getTaskQueue(spriteName);

  const current = queue.currentTask ? await getTask(queue.currentTask) : null;
  const queued = await Promise.all(queue.queuedTasks.map(id => getTask(id)));

  return {
    current,
    queued: queued.filter((t): t is DistributedTask => t !== null),
  };
}

export async function getAllSpritesStatus(): Promise<{ spriteName: string; current: DistributedTask | null; queuedCount: number }[]> {
  if (!s3Client || !bucketName) {
    throw new Error("Tasks network not initialized");
  }

  try {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: "task-queues/",
    }));

    const statuses: { spriteName: string; current: DistributedTask | null; queuedCount: number }[] = [];

    for (const obj of response.Contents || []) {
      if (!obj.Key?.endsWith(".json")) continue;

      try {
        const data = await s3Client.send(new GetObjectCommand({
          Bucket: bucketName,
          Key: obj.Key,
        }));

        const body = await data.Body?.transformToString();
        if (body) {
          const queue: TaskQueue = JSON.parse(body);
          const current = queue.currentTask ? await getTask(queue.currentTask) : null;

          statuses.push({
            spriteName: queue.spriteName,
            current,
            queuedCount: queue.queuedTasks.length,
          });
        }
      } catch (err) {
        console.error(`Failed to read queue ${obj.Key}:`, err);
      }
    }

    return statuses;
  } catch (err) {
    console.error("Failed to get all sprites status:", err);
    return [];
  }
}

export async function cancelTask(taskId: string): Promise<void> {
  if (!s3Client || !bucketName) {
    throw new Error("Tasks network not initialized");
  }

  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Update task status to cancelled (using "abandoned" status)
  await updateTask(taskId, {
    status: "abandoned",
    completedAt: new Date().toISOString(),
  });

  // Remove from the assigned sprite's queue
  const queue = await getTaskQueue(task.assignedTo);

  // Remove from queued tasks
  const queuedIndex = queue.queuedTasks.indexOf(taskId);
  if (queuedIndex !== -1) {
    queue.queuedTasks.splice(queuedIndex, 1);
    await updateTaskQueue(queue);
  }

  // If it's the current task, clear it
  if (queue.currentTask === taskId) {
    queue.currentTask = null;
    await updateTaskQueue(queue);
  }

  console.log(`Cancelled task ${taskId}`);
}

export async function reassignTask(taskId: string, newAssignedTo: string): Promise<void> {
  if (!s3Client || !bucketName) {
    throw new Error("Tasks network not initialized");
  }

  const task = await getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const oldAssignedTo = task.assignedTo;

  // Can't reassign completed or failed tasks
  if (task.status === "completed" || task.status === "failed") {
    throw new Error(`Cannot reassign ${task.status} task`);
  }

  // Remove from old sprite's queue
  const oldQueue = await getTaskQueue(oldAssignedTo);

  // Remove from queued tasks
  const queuedIndex = oldQueue.queuedTasks.indexOf(taskId);
  if (queuedIndex !== -1) {
    oldQueue.queuedTasks.splice(queuedIndex, 1);
    await updateTaskQueue(oldQueue);
  }

  // If it's the current task, clear it
  if (oldQueue.currentTask === taskId) {
    oldQueue.currentTask = null;
    await updateTaskQueue(oldQueue);
  }

  // Update task with new assignment
  await updateTask(taskId, {
    assignedTo: newAssignedTo,
    status: "pending",
    startedAt: undefined,
    sessionId: undefined,
  });

  // Add to new sprite's queue
  await addTaskToQueue(newAssignedTo, taskId);

  console.log(`Reassigned task ${taskId} from ${oldAssignedTo} to ${newAssignedTo}`);
}
