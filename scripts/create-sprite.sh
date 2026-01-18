#!/bin/bash
set -e

# Helper script to create and configure a new sprite with sprite-mobile
# Usage: ./create-sprite.sh <sprite-name>

# Handle Ctrl+C gracefully
trap 'echo ""; echo "Aborted."; exit 130' INT

if [ $# -ne 1 ]; then
    echo "Usage: $0 <sprite-name>"
    echo ""
    echo "Example: $0 my-new-sprite"
    echo ""
    echo "This script will:"
    echo "  1. Create a new sprite with the given name"
    echo "  2. Make its URL public"
    echo "  3. Transfer .sprite-config from current sprite"
    echo "  4. Run sprite-setup.sh non-interactively"
    exit 1
fi

SPRITE_NAME="$1"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "============================================"
echo "Creating and Configuring Sprite"
echo "============================================"
echo ""
echo "Target sprite: $SPRITE_NAME"
echo ""

# Check if .sprite-config exists
if [ ! -f "$HOME/.sprite-config" ]; then
    echo "Error: ~/.sprite-config not found"
    echo "This file is required to transfer configuration to the new sprite"
    exit 1
fi

# Determine the organization
ORG=$(sprite org list 2>/dev/null | grep "Currently selected org:" | awk '{print $NF}' || echo "")
if [ -z "$ORG" ]; then
    echo "Error: Could not determine current sprite organization"
    echo "Run 'sprite org list' to check your authentication"
    exit 1
fi

echo "Using organization: $ORG"
echo ""

# Step 1: Create sprite (skip if already exists)
echo "Step 1: Creating sprite..."
if sprite list -o "$ORG" 2>/dev/null | grep -q "^${SPRITE_NAME}$"; then
    echo "  Sprite '$SPRITE_NAME' already exists, skipping creation"
else
    if sprite create -o "$ORG" --skip-console "$SPRITE_NAME" 2>&1 | grep -q "Error"; then
        echo "  Warning: Sprite creation failed, but it may already exist"
    else
        echo "  Created sprite: $SPRITE_NAME"
    fi
fi
echo ""

# Step 2: Make URL public
echo "Step 2: Making URL public..."
sprite url update --auth public -s "$SPRITE_NAME" -o "$ORG"
PUBLIC_URL=$(sprite api /v1/sprites/"$SPRITE_NAME" 2>/dev/null | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/' | head -1)
if [ -n "$PUBLIC_URL" ]; then
    echo "  Public URL: $PUBLIC_URL"
fi
echo ""

# Step 3: Transfer .sprite-config
echo "Step 3: Transferring configuration..."
# Create a temporary file with the config, excluding sprite-specific values
TEMP_CONFIG=$(mktemp)
# Strip SPRITE_PUBLIC_URL and TAILSCALE_SERVE_URL (unique per sprite)
grep -v '^SPRITE_PUBLIC_URL=' "$HOME/.sprite-config" 2>/dev/null | grep -v '^TAILSCALE_SERVE_URL=' > "$TEMP_CONFIG" || cat "$HOME/.sprite-config" > "$TEMP_CONFIG"
# Encode as base64 to avoid shell escaping issues
CONFIG_B64=$(base64 -w0 "$TEMP_CONFIG" 2>/dev/null || base64 "$TEMP_CONFIG" | tr -d '\n')
rm "$TEMP_CONFIG"
# Transfer and decode on target
sprite -s "$SPRITE_NAME" -o "$ORG" exec -- bash -c "echo '$CONFIG_B64' | base64 -d > ~/.sprite-config && chmod 600 ~/.sprite-config"
echo "  Transferred ~/.sprite-config (excluded sprite-specific URLs)"
echo ""

# Step 4: Download setup script
echo "Step 4: Downloading setup script..."
sprite -s "$SPRITE_NAME" -o "$ORG" exec -- bash -c "curl -fsSL https://gist.githubusercontent.com/clouvet/901dabc09e62648fa394af65ad004d04/raw/sprite-setup.sh -o ~/sprite-setup.sh && chmod +x ~/sprite-setup.sh"
echo "  Downloaded sprite-setup.sh"
echo ""

# Step 5: Run setup script
echo "Step 5: Running setup script (this may take 3-5 minutes)..."
echo ""
sprite -s "$SPRITE_NAME" -o "$ORG" exec -- bash -c "set -a && source ~/.sprite-config && set +a && export NON_INTERACTIVE=true && cd ~ && ./sprite-setup.sh --name '$SPRITE_NAME' --url '$PUBLIC_URL' all"
echo ""

# Step 6: Verify services
echo "============================================"
echo "Setup Complete!"
echo "============================================"
echo ""
echo "Sprite: $SPRITE_NAME"
if [ -n "$PUBLIC_URL" ]; then
    echo "Public URL: $PUBLIC_URL"
fi
echo ""
echo "Verifying services..."
sprite -s "$SPRITE_NAME" -o "$ORG" exec -- sprite-env services list | grep -o '"name":"[^"]*"' | sed 's/"name":"/  - /' | sed 's/"$//'
echo ""
echo "To access the sprite:"
if [ -n "$PUBLIC_URL" ]; then
    echo "  Public: $PUBLIC_URL"
fi
echo "  SSH: sprite -s $SPRITE_NAME shell"
echo ""
