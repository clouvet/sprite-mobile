# Sprite Mobile

> **⚠️ This project is a work in progress and is subject to change at any time. Features, APIs, and behavior may be modified or removed without notice.**
>
> Features added to Sprites will likely make some of the hacks described below redundant, and hopefully a lot of this, especially setup, configuration, and orchestration, will be simplified in the near future.
>
> This is a personal project, not an official Fly.io product.

sprite-mobile gives you a progressive web app chat UI for accessing Claude Code running in YOLO mode on a [Sprite](https://sprites.dev), an ideal vibe-coding interface on your phone. It allows input by text, voice, and image, persists sessions across clients, and seamlessly networks with your other sprites through Tailscale.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Claude Code Integration](#claude-code-integration)
- [Features](#features)
- [Distributed Tasks](#distributed-tasks)
- [Access Model](#access-model)
- [Sprite Setup](#sprite-setup)
- [Sprite Orchestration](#sprite-orchestration)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
  - [Services](#services)
  - [Data Storage](#data-storage)
  - [API Endpoints](#api-endpoints)
  - [WebSocket](#websocket)
  - [Keepalive](#keepalive)
- [Session Lifecycle](#session-lifecycle)
- [CLI Session Attachment](#cli-session-attachment)
- [Configuration](#configuration)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Prerequisites

This app is designed to run on a Sprite from [sprites.dev](https://sprites.dev). Sprites come with:

- **Bun** runtime pre-installed
- **Claude Code** CLI pre-installed and authenticated

If running elsewhere, you'll need to install these manually and authenticate Claude Code with `claude login`.

## Claude Code Integration

sprite-mobile includes a comprehensive Claude skill that provides context about the architecture, service management, development workflows, and sprite orchestration. When working with Claude Code on a sprite-mobile sprite, Claude automatically has access to this skill.

**The skill covers:**
- Architecture (tailnet-gate + sprite-mobile integration)
- Service management (restart procedures, logs, status)
- Development workflows (service worker cache versioning)
- Creating and managing other sprite-mobile sprites
- Configuration management and replication
- API endpoints and WebSocket protocol
- Common troubleshooting tasks

**Location:** `.claude/skills/sprite-mobile.md`

This means you can ask Claude questions like:
- "How do I restart the sprite-mobile service?"
- "Create a new sprite-mobile sprite called test-sprite"
- "What's the service worker cache version and when should I bump it?"
- "How does the tailnet-gate work?"

Claude will have full context about sprite-mobile without needing to read through documentation or search for files.

## Features

- **Multiple Chat Sessions**: Create and manage multiple independent chat sessions, each with its own Claude Code process
- **Persistent History**: Messages are saved to disk and survive server restarts
- **Session Resume**: Reconnecting to a session resumes the existing Claude conversation
- **CLI Session Attachment**: Attach to existing Claude CLI sessions started in the terminal and import their history
- **Image Support**: Upload and send images to Claude for analysis (auto-resized for API limits)
- **Real-time Streaming**: Responses stream in real-time via WebSocket
- **Activity Indicators**: See exactly what Claude is doing (reading files, running commands, searching)
- **Multi-client Support**: Multiple browser tabs can connect to the same session
- **Auto-naming**: Chat sessions are automatically named based on conversation content
- **Smart Auto-focus**: Input field auto-focuses on desktop after Claude responds (disabled on mobile to avoid keyboard popup)
- **Voice Input**: Tap the microphone button to dictate messages (uses Web Speech API, works on iOS Safari and Android Chrome)
- **Dynamic Branding**: Header displays the sprite's hostname with a neon green 👾
- **Tailscale Integration**: HTTPS access via Tailscale Serve, embedded in iframe from public URL
- **Tailnet Gate**: Public URL wakes sprite and embeds Tailscale URL in iframe (if authorized)
- **Deep Linking**: URL hash syncs bidirectionally between parent and iframe for shareable session links
- **PWA Support**: Installable as a Progressive Web App, works offline (requires HTTPS via Tailscale Serve)
- **Auto-update**: Pulls latest code when the service starts
- **Sprite Network**: Automatic discovery of other sprites in your Fly.io organization via shared Tigris bucket
- **Distributed Tasks**: Assign work across sprites, track progress, and automatically process task queues
- **Hot Reloading**: Server code changes take effect immediately without restart
- **Network Restart**: Run `scripts/restart-others.sh` to restart sprite-mobile on all other network sprites after pulling updates

## Distributed Tasks

> **⚠️ Experimental Feature**: Distributed tasks is a new feature that has not been thoroughly tested. Use with caution and expect potential issues or behavior changes.

sprite-mobile includes a distributed task management system that allows sprites in your network to assign work to each other, track progress, and automatically process queued tasks. This enables collaborative workflows across your sprite fleet.

### Overview

The distributed tasks feature enables:
- **Task assignment from chat**: Ask Claude to assign tasks to specific sprites
- **Round-robin distribution**: Distribute multiple tasks across available sprites automatically
- **Automatic sprite wake-up**: Target sprites are automatically awakened using `sprite exec`
- **Sequential processing**: Each sprite processes tasks one at a time from its queue
- **Auto-sessions**: Tasks automatically create Claude Code sessions with the task description
- **Progress tracking**: Monitor what each sprite is working on across your network

### Usage

#### Assigning Tasks from Chat

Simply tell Claude to assign work to another sprite:

```
"Assign carnivorous-slobbius to implement feature X"
"Assign eternalii-famishus to fix the bug in module Y"
```

Claude will create the task and automatically wake the target sprite. The target sprite will:
1. Receive the task in its queue
2. Create a new Claude Code session with the task description
3. Work on the task autonomously
4. Report completion back to Tigris
5. Automatically pick up the next queued task

#### Distributing Multiple Tasks

For bulk work, use round-robin distribution:

```
"Distribute these 4 tasks across available sprites"
```

This automatically spreads the workload evenly across sprites in your network.

#### Monitoring Task Status

Check on your sprite network's progress:

```
"What are other sprites working on?"
```

Claude will query the distributed task status and show:
- Current tasks in progress
- Queued tasks per sprite
- Recent completions

#### Using the Tasks UI

The web interface includes a Tasks button (📋) in the header that opens a modal showing:
- **My Tasks**: Your current task and queue
- **All Sprites Status**: What each sprite in the network is working on
- **Task History**: Complete task history with status-based color coding

### API Endpoints

The distributed tasks system provides these API endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/distributed-tasks` | Create a new task |
| POST | `/api/distributed-tasks/distribute` | Distribute tasks round-robin |
| POST | `/api/distributed-tasks/check` | Check for new tasks in queue |
| POST | `/api/distributed-tasks/complete` | Mark a task complete |
| POST | `/api/distributed-tasks/:id/cancel` | Cancel a task (aborts if in progress, removes from queue if pending) |
| POST | `/api/distributed-tasks/:id/reassign` | Reassign a task to a different sprite (updates queue accordingly) |
| GET | `/api/distributed-tasks` | List all tasks |
| GET | `/api/distributed-tasks/mine` | Get tasks for this sprite |
| GET | `/api/distributed-tasks/status` | Get status of all sprites |
| GET | `/api/distributed-tasks/:id` | Get a specific task by ID |
| PATCH | `/api/distributed-tasks/:id` | Update a task's status/fields |

**Cancellation:**
```bash
# Cancel a task by ID
curl -X POST http://localhost:8081/api/distributed-tasks/{task-id}/cancel \
  -H "Content-Type: application/json" \
  -d '{"reason": "Optional cancellation reason"}'
```

**Reassignment:**
```bash
# Reassign a task to a different sprite
curl -X POST http://localhost:8081/api/distributed-tasks/{task-id}/reassign \
  -H "Content-Type: application/json" \
  -d '{"newAssignedTo": "target-sprite-name"}'
```

### Data Model

Tasks are stored in your shared Tigris bucket with the following structure:

**Task Object** (`tasks/{task-id}.json`):
```json
{
  "id": "uuid",
  "assignedTo": "sprite-name",
  "assignedBy": "sprite-name",
  "status": "pending|in_progress|completed|failed|cancelled",
  "title": "Task title",
  "description": "Full task description",
  "createdAt": "ISO date",
  "startedAt": "ISO date",
  "completedAt": "ISO date",
  "cancelledAt": "ISO date",
  "sessionId": "session-id",
  "result": {
    "summary": "What was accomplished",
    "success": true
  },
  "cancellationReason": "Optional reason for cancellation",
  "reassignmentHistory": [
    {
      "from": "old-sprite",
      "to": "new-sprite",
      "at": "ISO date",
      "reason": "Optional reason"
    }
  ]
}
```

**Task Queue** (`task-queues/{sprite-name}.json`):
```json
{
  "spriteName": "sprite-name",
  "queuedTasks": ["task-id-1", "task-id-2"],
  "currentTask": "task-id-3",
  "lastUpdated": "ISO date"
}
```

### Example Workflow

Here's a complete example of distributed tasks in action:

1. **User on sprite `eternalii-famishus`**: "Assign carnivorous-slobbius to implement features A, B, and C"
2. **eternalii-famishus's Claude**: Creates 3 tasks in Tigris and wakes carnivorous-slobbius with `sprite exec`
3. **carnivorous-slobbius**: Receives tasks, creates a new Claude Code session for task A
4. **carnivorous-slobbius**: Completes task A, reports back to Tigris, automatically starts task B
5. **User on sprite `canis-latrans`**: "What are other sprites working on?"
6. **canis-latrans's Claude**: Queries task status and responds: "carnivorous-slobbius is working on 'Implement feature B' with 1 task queued"

### Prerequisites

Distributed tasks requires:
- **Sprite Network configuration**: Shared Tigris bucket credentials
- **sprite-exec access**: Ability to execute commands on target sprites
- **Multiple sprites**: At least 2 sprites in your network for cross-sprite assignment

The sprite network is automatically configured during initial setup if you provide Tigris credentials.

## Access Model

Sprite Mobile uses Tailscale for secure access without passwords or tokens:

```
Public URL (https://sprite.sprites.app)
         │
         ▼
   Tailnet Gate (port 8080)
         │
         ├── Embed iframe with Tailscale HTTPS URL
         │   │
         │   ├── Iframe loads? ──→ Show sprite-mobile interface
         │   │                     (WebSocket keeps sprite awake)
         │   │
         │   └── Iframe fails (4s timeout)? ──→ Show "Unauthorized" 👾 🚫
         │
         └── Hash syncing ──→ Deep linking to specific sessions
```

**Three access paths:**

| Path | URL | Auth | HTTPS | PWA |
|------|-----|------|-------|-----|
| Public | `https://sprite.sprites.app` | Tailnet Gate | Yes | Via iframe |
| Tailscale Serve | `https://my-sprite.ts.net` | Tailnet only | Yes | Yes |
| Tailscale IP | `http://100.x.x.x:8081` | Tailnet only | No | No |

**Recommended**: Bookmark the public URL. It wakes the sprite and embeds the Tailscale HTTPS URL in an iframe (with hash syncing for deep linking). A WebSocket keepalive keeps the sprite awake while the page is open.

## Sprite Setup

To set up a fresh Sprite with all dependencies, authentication, and services, download and run the setup script:

```bash
curl -fsSL https://raw.githubusercontent.com/clouvet/sprite-mobile/refs/heads/main/scripts/sprite-setup.sh -o sprite-setup.sh && chmod +x sprite-setup.sh && ./sprite-setup.sh
```

The script will:
1. Install Sprites CLI and authenticate
2. Configure hostname, git user, URLs, and repo (auto-detects public URL from sprite metadata)
3. Authenticate Claude CLI
4. Authenticate GitHub CLI
5. Install Fly.io CLI
6. Install and configure Tailscale
7. Set up Tailscale Serve (HTTPS for PWA support)
8. Clone and run sprite-mobile
9. Set up Sprite Network credentials (optional - enables automatic discovery of other sprites in your org)
10. Start the Tailnet Gate (public entry point that embeds Tailscale URL via iframe)
11. Create CLAUDE.md with sprite environment instructions

The script is idempotent and can be safely re-run.

The app is installed to `~/.sprite-mobile` (hidden directory). On each service start, it attempts to auto-update via `git pull` so all sprites receive updates when they wake up.

**Note:** During authentication:
- Claude CLI may start a new Claude session after completing. Just type `exit` or press `Ctrl+C` to exit and continue.

## Sprite Orchestration

Once you have one sprite-mobile sprite set up, it can automatically create and configure new sprites with a single command. This is useful for scaling your sprite fleet or letting Claude Code create new sprites on demand.

### Prerequisites

For fully automated sprite creation, you need:

1. **~/.sprite-config file** - Created automatically during initial setup
2. **Tailscale reusable auth key** - Must be saved in your `~/.sprite-config`
3. **Authenticated CLI tools** - Claude, GitHub, Fly.io, and Sprite CLI

**One-Time Setup: Tailscale Reusable Auth Key**

Create a reusable auth key and add it to your `~/.sprite-config`:

1. Go to https://login.tailscale.com/admin/settings/keys
2. Click "Generate auth key"
3. Check "Reusable"
4. Copy the key and add it to `~/.sprite-config`:
   ```bash
   TAILSCALE_AUTH_KEY=tskey-auth-xxxxx
   ```

### Creating a New Sprite (One Command)

From any existing sprite-mobile sprite:

```bash
~/.sprite-mobile/scripts/create-sprite.sh my-new-sprite
```

**That's it!** This single command will:

1. Create a new sprite with the given name
2. Make its URL public
3. Transfer your `.sprite-config` to the new sprite (excluding sprite-specific URLs)
4. Download and run the full setup script non-interactively
5. Verify all services are running

**Example output:**

```
Creating and Configuring Sprite
Target sprite: my-new-sprite

Step 1: Creating sprite...
  Created sprite: my-new-sprite

Step 2: Making URL public...
  Public URL: https://my-new-sprite.sprites.app

Step 3: Transferring configuration...
  Transferred ~/.sprite-config (excluded sprite-specific URLs)

Step 4: Downloading setup script...
  Downloaded sprite-setup.sh

Step 5: Running setup script (this may take 3-5 minutes)...
  [Setup runs automatically with your credentials]

Setup Complete!
```

### What Gets Transferred

The script transfers your `~/.sprite-config` which includes:
- Git configuration (user.name, user.email)
- Claude CLI OAuth token
- GitHub CLI token
- Fly.io API token
- Sprite API token
- Tailscale reusable auth key
- Sprite Network credentials

The following are **unique per sprite** and NOT transferred:
- `SPRITE_PUBLIC_URL` - Stripped during transfer, set correctly for the new sprite
- `TAILSCALE_SERVE_URL` - Stripped during transfer, generated during setup
- Hostname - Set to the sprite name automatically

### How It Works

The `create-sprite.sh` script uses a defense-in-depth approach:

1. **Filters sprite-specific values** during config transfer:
   ```bash
   # Strip SPRITE_PUBLIC_URL and TAILSCALE_SERVE_URL
   grep -v '^SPRITE_PUBLIC_URL=' ~/.sprite-config | \
   grep -v '^TAILSCALE_SERVE_URL=' > filtered-config
   ```

2. **Passes correct values** to setup script:
   ```bash
   sprite exec -- ./sprite-setup.sh --name 'my-new-sprite' --url 'https://my-new-sprite.sprites.app' all
   ```

This ensures the new sprite always gets the correct public URL and hostname, even if the source config contained different values.

### Manual Alternative

If you prefer manual control or need to customize the process:

```bash
# 1. Create sprite
sprite create my-new-sprite

# 2. Make URL public and get the URL
sprite url update --auth public -s my-new-sprite
PUBLIC_URL=$(sprite api /v1/sprites/my-new-sprite | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/')

# 3. Transfer config (excluding sprite-specific URLs)
grep -v '^SPRITE_PUBLIC_URL=' ~/.sprite-config | grep -v '^TAILSCALE_SERVE_URL=' | \
  sprite -s my-new-sprite exec -- cat > ~/.sprite-config

# 4. Download and run setup
sprite -s my-new-sprite exec -- bash -c "
  curl -fsSL https://gist.githubusercontent.com/clouvet/901dabc09e62648fa394af65ad004d04/raw/sprite-setup.sh -o ~/sprite-setup.sh
  chmod +x ~/sprite-setup.sh
  ~/sprite-setup.sh --name my-new-sprite --url '$PUBLIC_URL' all
"
```

### Letting Claude Create Sprites

With orchestration configured, you can simply tell Claude Code:

> "Create a new sprite-mobile sprite called test-sprite"

Claude will use `create-sprite.sh` to handle the entire process automatically.

## Quick Start

If you prefer to set things up manually:

```bash
git clone <repo-url> sprite-mobile
cd sprite-mobile
bun install
bun start
```

The server runs on port 8081 by default. Override with the `PORT` environment variable.

Open `http://localhost:8081` in a browser to access the chat interface.

## Environment Variables

### Configuration File

All environment variables are managed through `~/.sprite-config`, which serves as the single source of truth. Both bash and zsh automatically source this file.

**Format:**
```bash
# ~/.sprite-config
GH_TOKEN=ghp_xxxxx
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
FLY_API_TOKEN=fm2_xxxxx
SPRITE_API_TOKEN=your-org-name/org/id/token
SPRITE_PUBLIC_URL=https://my-sprite.sprites.app
TAILSCALE_SERVE_URL=https://my-sprite.tailxxxxx.ts.net
SPRITE_MOBILE_REPO=https://github.com/org/sprite-mobile
```

### Key Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Server port | `8081` |
| `SPRITE_PUBLIC_URL` | Public URL for waking sprite | `https://my-sprite.sprites.app` |
| `TAILSCALE_SERVE_URL` | Tailscale HTTPS URL | `https://my-sprite.ts.net` |
| `SPRITE_HOSTNAME` | Hostname for sprite network registration | `my-sprite` |
| `SPRITE_NETWORK_CREDS` | Path to Tigris credentials file | `~/.sprite-network/credentials.json` |
| `SPRITE_NETWORK_ORG` | Fly.io org for sprite network | `my-org` |
| `GH_TOKEN` | GitHub Personal Access Token | `ghp_xxxxx` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token | `sk-ant-oat01-xxxxx` |
| `FLY_API_TOKEN` | Fly.io API token | `fm2_xxxxx` |
| `SPRITE_API_TOKEN` | Sprite CLI API token | `your-org-name/org/id/token` |

These are automatically configured by the setup script and stored in `~/.sprite-config`.

## Architecture

### Services

After setup, these services run on your sprite:

| Service | Port | Description |
|---------|------|-------------|
| `tailnet-gate` | 8080 | Public entry point, embeds Tailscale URL in iframe with WebSocket keepalive |
| `sprite-mobile` | 8081 | Main app server (accessed via Tailscale) |
| `tailscaled` | - | Tailscale daemon |

### Data Storage

All data is stored in the `data/` directory:

- `sessions.json` - Chat session metadata
- `sprites.json` - Saved Sprite profiles
- `messages/{sessionId}.json` - Message history per session
- `uploads/{sessionId}/` - Uploaded images per session

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Get public configuration |
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Create new session |
| PATCH | `/api/sessions/:id` | Update session name/cwd |
| DELETE | `/api/sessions/:id` | Delete session |
| GET | `/api/sessions/:id/messages` | Get message history |
| POST | `/api/sessions/:id/regenerate-title` | Regenerate session title |
| GET | `/api/claude-sessions` | Discover Claude CLI sessions from `~/.claude/projects/` |
| POST | `/api/upload?session={id}` | Upload an image |
| GET | `/api/uploads/:sessionId/:filename` | Retrieve uploaded image |
| GET | `/api/sprites` | List saved Sprite profiles |
| POST | `/api/sprites` | Add a Sprite profile |
| PATCH | `/api/sprites/:id` | Update a Sprite profile |
| DELETE | `/api/sprites/:id` | Remove a Sprite profile |
| GET | `/api/network/status` | Check if sprite network is configured |
| GET | `/api/network/sprites` | Discover sprites in the network |
| POST | `/api/network/heartbeat` | Manual heartbeat trigger |
| DELETE | `/api/network/sprites/:hostname` | Remove a sprite from the network |
| POST | `/api/distributed-tasks` | Create a new task |
| POST | `/api/distributed-tasks/distribute` | Distribute tasks round-robin |
| POST | `/api/distributed-tasks/check` | Check for new tasks |
| POST | `/api/distributed-tasks/complete` | Mark task complete |
| POST | `/api/distributed-tasks/:id/cancel` | Cancel a task by ID |
| POST | `/api/distributed-tasks/:id/reassign` | Reassign a task to a different sprite |
| GET | `/api/distributed-tasks` | List all tasks |
| GET | `/api/distributed-tasks/mine` | Get this sprite's tasks |
| GET | `/api/distributed-tasks/status` | Get all sprites status |
| GET | `/api/distributed-tasks/:id` | Get a specific task by ID |
| PATCH | `/api/distributed-tasks/:id` | Update a task's status/fields |

### WebSocket

Connect to `/ws?session={sessionId}` to interact with a chat session.

**Incoming messages (from server):**
- `{ type: "history", messages: [...] }` - Message history on connect
- `{ type: "assistant", message: {...} }` - Streaming assistant response
- `{ type: "result", ... }` - Response complete
- `{ type: "user_message", message: {...} }` - User message from another client
- `{ type: "processing", isProcessing: true/false }` - Processing state
- `{ type: "refresh_sessions" }` - Session list changed
- `{ type: "system", message: "..." }` - System notifications

**Outgoing messages (to server):**
```json
{
  "type": "user",
  "content": "Your message here",
  "imageId": "optional-image-id",
  "imageFilename": "optional-filename",
  "imageMediaType": "image/png"
}
```

### Keepalive

Two WebSocket endpoints keep the Sprite awake:

1. **Public Gate Keepalive** (`/keepalive` on port 8080): The tailnet-gate opens a WebSocket connection to the sprite's http_port (8080) to keep it awake while the public URL is open. This ensures the sprite doesn't suspend before the Tailscale connection is established.

2. **App Keepalive** (`/ws/keepalive` on port 8081): The sprite-mobile app itself opens a WebSocket to keep the sprite awake while the app is in use.

Both use persistent WebSocket connections because sprites stay awake as long as there's an active connection to their http_port or any running service.

## Session Lifecycle

1. **Creation**: `POST /api/sessions` creates a new session with a working directory
2. **Connection**: WebSocket connection spawns a Claude Code process
3. **Messaging**: Messages are saved and streamed in real-time
4. **Disconnection**: Claude process continues running for 30 minutes
5. **Reconnection**: Rejoins the existing process if still alive, otherwise resumes via Claude's session ID
6. **Cleanup**: Idle processes with no clients are terminated after 30 minutes

## CLI Session Attachment

Sprite Mobile can attach to existing Claude CLI sessions that were started in the terminal. This allows you to:

1. Continue conversations that you started on the command line
2. Import the full conversation history into the web interface
3. Switch between CLI and web interface seamlessly

**How it works:**

- Click the terminal icon in the sidebar (next to "New Chat")
- The app discovers sessions from `~/.claude/projects/` directory
- Select a session to import its history and resume the conversation
- The session continues with the same Claude session ID, maintaining full context

**Session discovery format:**

Claude CLI stores sessions in `~/.claude/projects/{cwd}/{sessionId}.jsonl`. The app:
- Scans all working directories under the projects folder
- Parses `.jsonl` files to extract message history
- Shows the first user message as a preview
- Filters out empty sessions and internal tool messages

**Important caveat:**

When you attach to a CLI session, Sprite Mobile spawns a **new** Claude Code process that resumes the conversation using the session ID. This means:

- The web interface and CLI are running separate processes
- Any work done in the web interface is saved to the shared session history
- If you later try to resume the same session from the CLI while the web session is still active, both processes will be writing to the same session file
- **Best practice**: Finish your work in one interface before switching to the other to avoid potential conflicts

## Configuration

Sessions can specify a working directory (`cwd`) that Claude Code operates in. This defaults to the user's home directory.

## Security

### Intended Use: Personal Tool

**sprite-mobile is designed as a personal tool for individual use, not for shared or public deployment.** Each person should run their own instance(s) on their own Sprite(s). This significantly simplifies the security model:

- No multi-user authentication needed
- No per-user permissions or isolation
- Tailscale network membership IS the authentication

### Important Security Considerations

⚠️ **Beware. If you wouldn't let someone into your Tailnet then you probably shouldn't let them anywhere near this app. Do not expose this app to the public internet or share your tailnet with untrusted users.** Anyone with access to the app has full control over your Claude Code sessions and can execute arbitrary commands on your Sprite. They'll also have whatever access you're scoped to for Fly, Sprites, and the GitHub cli. 😵

### Access Control

Access is controlled via Tailscale:
- **Tailnet membership is the auth** - No passwords or tokens needed
- **Public URL embeds via iframe** - The tailnet gate embeds the Tailscale URL in an iframe; if it fails to load within 4 seconds, shows "Unauthorized"
- **Not on tailnet = Unauthorized** - Users outside your tailnet see a blocked page with 👾 🚫
- **Trust model**: Anyone on your tailnet can use the app. Only add trusted devices/users to your tailnet.

### Claude Code Permissions

This app runs Claude Code with `--dangerously-skip-permissions`, which allows Claude to execute commands without confirmation prompts. This is appropriate for:
- Personal use where you trust your own prompts
- A Sprite environment where the sandbox provides isolation
- "YOLO mode" vibe-coding workflows

Be aware that Claude has full access to the Sprite's filesystem and can run arbitrary commands. This is the intended behavior for a personal coding assistant.

## Troubleshooting

### Chrome Certificate Error

If Chrome shows `ERR_CERTIFICATE_TRANSPARENCY_REQUIRED` when accessing the Tailscale URL:
- Wait a few minutes for certificate propagation
- Try hard refresh (Cmd+Shift+R)
- Clear site data in DevTools
- Try incognito mode
- Safari is more lenient and may work immediately

### Tailscale Serve Not Working

Check the serve status:
```bash
tailscale serve status
```

Restart if needed:
```bash
tailscale serve --bg 8081
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
