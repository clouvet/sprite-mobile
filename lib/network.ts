import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { readFileSync, existsSync } from "fs";
import { hostname } from "os";
import type { NetworkSprite } from "./types";

const CREDS_PATH = process.env.SPRITE_NETWORK_CREDS || `${process.env.HOME}/.sprite-network/credentials.json`;

let s3Client: S3Client | null = null;
let bucketName: string | null = null;
let networkOrg: string | null = null;
let initialized = false;

export function initNetwork(): boolean {
  if (initialized) return s3Client !== null;
  initialized = true;

  if (!existsSync(CREDS_PATH)) {
    console.log("Sprite network not configured (no credentials file)");
    return false;
  }

  try {
    const creds = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));

    if (!creds.AWS_ACCESS_KEY_ID || !creds.AWS_SECRET_ACCESS_KEY || !creds.BUCKET_NAME) {
      console.log("Sprite network credentials incomplete");
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
    networkOrg = process.env.SPRITE_NETWORK_ORG || creds.ORG || null;

    console.log(`Sprite network initialized: bucket=${bucketName}, org=${networkOrg}`);
    return true;
  } catch (err) {
    console.error("Failed to initialize sprite network:", err);
    return false;
  }
}

export function isNetworkEnabled(): boolean {
  return s3Client !== null && bucketName !== null;
}

export function getNetworkInfo(): { enabled: boolean; org: string | null; bucket: string | null } {
  return {
    enabled: isNetworkEnabled(),
    org: networkOrg,
    bucket: bucketName,
  };
}

export async function registerSprite(sprite: NetworkSprite): Promise<void> {
  if (!s3Client || !bucketName) {
    throw new Error("Network not initialized");
  }

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `registry/${sprite.hostname}.json`,
    Body: JSON.stringify(sprite, null, 2),
    ContentType: "application/json",
  }));

  console.log(`Registered sprite: ${sprite.hostname}`);
}

export async function updateHeartbeat(): Promise<void> {
  if (!s3Client || !bucketName) return;

  const spriteHostname = getHostname();

  try {
    // Get existing registration
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: `registry/${spriteHostname}.json`,
    }));

    const body = await response.Body?.transformToString();
    if (!body) return;

    const existing: NetworkSprite = JSON.parse(body);
    existing.lastSeen = Date.now();

    await registerSprite(existing);
    console.log(`Heartbeat updated for ${spriteHostname}`);
  } catch (err: any) {
    if (err.name === "NoSuchKey") {
      // Not registered yet, will be registered on next full registration
      console.log("Sprite not registered yet, skipping heartbeat");
    } else {
      console.error("Failed to update heartbeat:", err);
    }
  }
}

export async function discoverSprites(): Promise<NetworkSprite[]> {
  if (!s3Client || !bucketName) return [];

  try {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: "registry/",
    }));

    const sprites: NetworkSprite[] = [];

    for (const obj of response.Contents || []) {
      if (!obj.Key?.endsWith(".json")) continue;

      try {
        const data = await s3Client.send(new GetObjectCommand({
          Bucket: bucketName,
          Key: obj.Key,
        }));

        const body = await data.Body?.transformToString();
        if (body) {
          const sprite: NetworkSprite = JSON.parse(body);
          sprites.push(sprite);
        }
      } catch (err) {
        console.error(`Failed to read sprite ${obj.Key}:`, err);
      }
    }

    return sprites;
  } catch (err) {
    console.error("Failed to discover sprites:", err);
    return [];
  }
}

export function getSpriteStatus(sprite: NetworkSprite): "online" | "recent" | "offline" {
  const now = Date.now();
  const diff = now - sprite.lastSeen;

  if (diff < 10 * 60 * 1000) return "online";    // 10 minutes
  if (diff < 60 * 60 * 1000) return "recent";    // 60 minutes
  return "offline";
}

export function getHostname(): string {
  // Try to get hostname from env first (set during setup)
  return process.env.SPRITE_HOSTNAME || hostname().split(".")[0];
}

export function buildSpriteRegistration(): NetworkSprite {
  const now = Date.now();
  const spriteHostname = getHostname();

  return {
    hostname: spriteHostname,
    org: networkOrg || "",
    tailscaleUrl: process.env.TAILSCALE_SERVE_URL || "",
    publicUrl: process.env.SPRITE_PUBLIC_URL || "",
    ownerEmail: process.env.SPRITE_OWNER_EMAIL || "",
    registeredAt: now,
    lastSeen: now,
  };
}
