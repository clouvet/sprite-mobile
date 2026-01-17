# Creating New Sprites

This guide explains how to create and configure new sprites with sprite-mobile from an existing sprite.

## Quick Start

From any sprite with sprite-mobile installed:

```bash
~/.sprite-mobile/create-sprite.sh <sprite-name>
```

This single command will:
1. Create a new sprite with the given name
2. Make its URL public
3. Transfer your `.sprite-config` to the new sprite
4. Run the full setup script non-interactively
5. Verify all services are running

## Example

```bash
~/.sprite-mobile/create-sprite.sh my-test-sprite
```

## What Gets Transferred

The script transfers your `~/.sprite-config` which includes:
- Git configuration (user.name, user.email)
- Claude CLI OAuth token
- GitHub CLI token
- Fly.io API token
- Sprite API token
- Tailscale auth key
- Sprite Network credentials

The following are **unique per sprite** and NOT transferred:
- Hostname (set via sprite name parameter)
- Public URL (auto-generated from sprite name)
- Tailscale Serve URL (generated during setup)

## How It Works

### 1. Auto-Detection

The setup script now automatically detects `~/.sprite-config` and enables non-interactive mode:

```bash
# Old way (manual)
set -a && source ~/.sprite-config && set +a && export NON_INTERACTIVE=true && ~/sprite-setup.sh all

# New way (automatic)
~/sprite-setup.sh all
```

If `~/.sprite-config` exists, the script will:
- Source it automatically
- Enable non-interactive mode
- Use all credentials without prompting

### 2. Create Script Flow

The `create-sprite.sh` script follows this flow:

```
1. Check prerequisites
   - Verify ~/.sprite-config exists
   - Determine current organization

2. Create sprite
   - Run: sprite create -o <org> <name>
   - Skip if sprite already exists

3. Make URL public
   - Run: sprite url update --auth public
   - Extract and display public URL

4. Transfer config
   - cat ~/.sprite-config | sprite exec -- cat > ~/.sprite-config
   - Clean up any control characters

5. Download setup script
   - curl sprite-setup.sh to new sprite

6. Run setup
   - sprite exec -- ./sprite-setup.sh all
   - Auto-detects ~/.sprite-config
   - Runs completely non-interactively

7. Verify
   - List running services
   - Display access URLs
```

## Requirements

### On Source Sprite
- sprite-mobile installed at `~/.sprite-mobile/`
- Valid `~/.sprite-config` file
- Sprite CLI authenticated
- Tailscale reusable auth key in config

### For Non-Interactive Setup

The following must be in your `~/.sprite-config`:

```bash
# Git configuration
GIT_USER_NAME=your-name
GIT_USER_EMAIL=your@email.com

# Authentication tokens
GH_TOKEN=ghp_xxx
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx
TAILSCALE_AUTH_KEY=tskey-auth-xxx  # Must be reusable!
FLY_API_TOKEN=fm2_xxx
SPRITE_API_TOKEN=org/id/token/value

# Sprite Network (optional)
SPRITE_NETWORK_S3_BUCKET=sprites-network-org
SPRITE_NETWORK_S3_ACCESS_KEY=tid_xxx
SPRITE_NETWORK_S3_SECRET_KEY=tsec_xxx
SPRITE_NETWORK_S3_ENDPOINT=https://fly.storage.tigris.dev
SPRITE_NETWORK_ORG=your-org

# Repository
SPRITE_MOBILE_REPO=https://github.com/user/sprite-mobile
```

**Important:** The Tailscale auth key MUST be reusable. Create one at:
https://login.tailscale.com/admin/settings/keys

## Troubleshooting

### "Authentication failed"

Ensure your Sprite CLI is authenticated:
```bash
sprite org list
```

If not authenticated:
```bash
sprite login
# or
sprite auth setup --token "org/id/token/value"
```

### "No ~/.sprite-config found"

Create it from scratch:
```bash
~/.sprite-mobile/sprite-setup.sh --export > ~/.sprite-config
```

Or copy from another sprite:
```bash
scp other-sprite:~/.sprite-config ~/.sprite-config
```

### Setup hangs or prompts for input

This means `~/.sprite-config` is missing required credentials. Check:
```bash
grep -E 'CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|TAILSCALE_AUTH_KEY|FLY_API_TOKEN' ~/.sprite-config
```

Add any missing tokens to the file.

### "Tailscale auth key is not reusable"

The auth key in your config must be a reusable key. Create a new one:
1. Visit https://login.tailscale.com/admin/settings/keys
2. Click "Generate auth key"
3. Check "Reusable"
4. Copy the key
5. Update `~/.sprite-config`: `TAILSCALE_AUTH_KEY=tskey-auth-xxx`

## Manual Alternative

If you prefer manual control:

```bash
# 1. Create sprite
sprite create my-sprite

# 2. Make URL public
sprite url update --auth public -s my-sprite

# 3. Transfer config
cat ~/.sprite-config | sprite -s my-sprite exec -- cat > ~/.sprite-config

# 4. Download and run setup
sprite -s my-sprite exec -- bash -c "
  curl -fsSL https://gist.githubusercontent.com/clouvet/901dabc09e62648fa394af65ad004d04/raw/sprite-setup.sh -o ~/sprite-setup.sh
  chmod +x ~/sprite-setup.sh
  ~/sprite-setup.sh all
"
```

## Testing

The `create-sprite.sh` script is safe to test repeatedly:
- Creating an existing sprite just skips creation
- Setup steps are idempotent (safe to re-run)
- Services are restarted if already running

Test by creating a few sprites:
```bash
~/.sprite-mobile/create-sprite.sh test-1
~/.sprite-mobile/create-sprite.sh test-2
~/.sprite-mobile/create-sprite.sh test-3
```

All sprites will appear in your sprite network automatically!
