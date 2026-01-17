#!/bin/bash
set -e

# Handle Ctrl+C gracefully
trap 'echo ""; echo "Aborted."; exit 130' INT

# ============================================
# Sprite Setup Script
# Run this once after creating a new sprite
# ============================================

# Non-interactive mode flag
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"
CONFIG_FILE=""

# Sprite API helper
sprite_api() { sprite-env curl "$@"; }

# Configuration (set these or export before running)
GIT_USER_NAME="${GIT_USER_NAME:-}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-}"
# Load saved SPRITE_MOBILE_REPO from ~/.zshrc if not already set
if [ -z "$SPRITE_MOBILE_REPO" ] && [ -f "$HOME/.zshrc" ]; then
    SPRITE_MOBILE_REPO=$(grep "^export SPRITE_MOBILE_REPO=" "$HOME/.zshrc" 2>/dev/null | sed 's/^export SPRITE_MOBILE_REPO=//' | tail -1)
fi
SPRITE_MOBILE_REPO="${SPRITE_MOBILE_REPO:-https://github.com/clouvet/sprite-mobile}"

# Load saved SPRITE_PUBLIC_URL from ~/.zshrc if not already set
if [ -z "$SPRITE_PUBLIC_URL" ] && [ -f "$HOME/.zshrc" ]; then
    SPRITE_PUBLIC_URL=$(grep "^export SPRITE_PUBLIC_URL=" "$HOME/.zshrc" 2>/dev/null | sed 's/^export SPRITE_PUBLIC_URL=//' | tail -1)
fi
SPRITE_PUBLIC_URL="${SPRITE_PUBLIC_URL:-}"
APP_PORT="${APP_PORT:-8081}"
WAKEUP_PORT="${WAKEUP_PORT:-8080}"
TAILSCALE_AUTH_KEY="${TAILSCALE_AUTH_KEY:-}"

# ============================================
# JSON Helper Functions (no jq dependency)
# ============================================

# Extract a simple string value from JSON
json_get() {
    local json="$1"
    local key="$2"
    echo "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | sed 's/.*: *"\([^"]*\)".*/\1/' | head -1
}

# Extract a nested value like credentials.claude
json_get_nested() {
    local json="$1"
    local parent="$2"
    local key="$3"
    # Find the parent object and extract the key
    local section=$(echo "$json" | tr '\n' ' ' | grep -o "\"$parent\"[[:space:]]*:[[:space:]]*{[^}]*}" | head -1)
    json_get "$section" "$key"
}

# Strip bracketed paste escape sequences from input
# Fixes issue where pasting tokens includes ^[[200~ and ^[[201~ markers
strip_bracketed_paste() {
    local input="$1"
    # Remove bracketed paste start (ESC[200~) and end (ESC[201~) sequences
    input="${input#$'\e[200~'}"
    input="${input%$'\e[201~'}"
    echo "$input"
}

# ============================================
# Sprite Config Management
# ============================================

SPRITE_CONFIG_FILE="$HOME/.sprite-config"

# Update or add a variable in ~/.sprite-config
update_sprite_config() {
    local key="$1"
    local value="$2"

    # Create file if it doesn't exist
    if [ ! -f "$SPRITE_CONFIG_FILE" ]; then
        cat > "$SPRITE_CONFIG_FILE" << 'CONFIG_HEADER'
# Sprite Config - reusable across sprites
# This file is sourced by both bash and zsh

CONFIG_HEADER
        chmod 600 "$SPRITE_CONFIG_FILE"
    fi

    # Update or append the key
    if grep -q "^${key}=" "$SPRITE_CONFIG_FILE" 2>/dev/null; then
        # Escape special characters in value for sed
        local escaped_value=$(printf '%s\n' "$value" | sed 's/[&/\]/\\&/g')
        sed -i "s|^${key}=.*|${key}=${escaped_value}|" "$SPRITE_CONFIG_FILE"
    else
        echo "${key}=${value}" >> "$SPRITE_CONFIG_FILE"
    fi

    # Export for current session
    export "${key}=${value}"
}

# Ensure both bash and zsh source ~/.sprite-config
ensure_shell_config_sourcing() {
    local bashrc="$HOME/.bashrc"
    local zshrc="$HOME/.zshrc"

    # Bash configuration
    if [ -f "$bashrc" ]; then
        if ! grep -q "\.sprite-config" "$bashrc" 2>/dev/null; then
            cat >> "$bashrc" << 'BASH_CONFIG'

# Source sprite config (single source of truth for environment variables)
if [ -f "$HOME/.sprite-config" ]; then
    set -a  # Export all variables
    source "$HOME/.sprite-config"
    set +a  # Stop exporting
fi

# Add flyctl to PATH if installed
if [ -n "$FLYCTL_INSTALL" ] && [ -d "$FLYCTL_INSTALL/bin" ]; then
    export PATH="$FLYCTL_INSTALL/bin:$PATH"
fi
BASH_CONFIG
            echo "Configured .bashrc to source ~/.sprite-config"
        fi
    fi

    # Zsh configuration
    if [ -f "$zshrc" ]; then
        if ! grep -q "\.sprite-config" "$zshrc" 2>/dev/null; then
            cat >> "$zshrc" << 'ZSH_CONFIG'

# Source sprite config (single source of truth for environment variables)
if [ -f "$HOME/.sprite-config" ]; then
    set -a  # Export all variables
    source "$HOME/.sprite-config"
    set +a  # Stop exporting
fi

# Add flyctl to PATH if installed
if [ -n "$FLYCTL_INSTALL" ] && [ -d "$FLYCTL_INSTALL/bin" ]; then
    export PATH="$FLYCTL_INSTALL/bin:$PATH"
fi
ZSH_CONFIG
            echo "Configured .zshrc to source ~/.sprite-config"
        fi
    fi
}

# ============================================
# Export Configuration
# ============================================

export_config() {
    echo "Exporting current sprite configuration..." >&2

    # Gather current values
    # NOTE: hostname and public_url are intentionally NOT exported
    # as they are unique per sprite
    local git_name=$(git config --global user.name 2>/dev/null || echo "")
    local git_email=$(git config --global user.email 2>/dev/null || echo "")

    # Read credential files and base64 encode
    local claude_creds=""
    if [ -f "$HOME/.claude/.credentials.json" ]; then
        claude_creds=$(base64 -w0 "$HOME/.claude/.credentials.json" 2>/dev/null || base64 "$HOME/.claude/.credentials.json" | tr -d '\n')
    fi

    local github_creds=""
    if [ -f "$HOME/.config/gh/hosts.yml" ]; then
        github_creds=$(base64 -w0 "$HOME/.config/gh/hosts.yml" 2>/dev/null || base64 "$HOME/.config/gh/hosts.yml" | tr -d '\n')
    fi

    local flyctl_creds=""
    if [ -f "$HOME/.fly/config.yml" ]; then
        # Only export config files, not binaries
        flyctl_creds=$(tar -czf - -C "$HOME/.fly" config.yml state.yml 2>/dev/null | base64 -w0 2>/dev/null || tar -czf - -C "$HOME/.fly" config.yml state.yml 2>/dev/null | base64 | tr -d '\n')
    fi

    local sprite_network_creds=""
    if [ -f "$HOME/.sprite-network/credentials.json" ]; then
        sprite_network_creds=$(base64 -w0 "$HOME/.sprite-network/credentials.json" 2>/dev/null || base64 "$HOME/.sprite-network/credentials.json" | tr -d '\n')
    fi

    # Read saved Tailscale reusable auth key if available
    local tailscale_auth_key=""
    if [ -f "$HOME/.config/sprite/tailscale-auth-key" ]; then
        tailscale_auth_key=$(cat "$HOME/.config/sprite/tailscale-auth-key")
    fi

    # Read Claude token file if available (from token-based auth)
    local claude_token=""
    if [ -f "$HOME/.config/claude-code/token" ]; then
        claude_token=$(base64 -w0 "$HOME/.config/claude-code/token" 2>/dev/null || base64 "$HOME/.config/claude-code/token" | tr -d '\n')
    fi

    # Output JSON
    # NOTE: hostname and public_url are NOT included - they are unique per sprite
    cat << EXPORT_EOF
{
  "git": {
    "user_name": "$git_name",
    "user_email": "$git_email"
  },
  "credentials": {
    "claude": "$claude_creds",
    "claude_token": "$claude_token",
    "github": "$github_creds",
    "flyctl": "$flyctl_creds",
    "sprite_network": "$sprite_network_creds"
  },
  "tailscale": {
    "auth_key": "$tailscale_auth_key"
  },
  "ports": {
    "app": $APP_PORT,
    "wakeup": $WAKEUP_PORT
  },
  "skip_steps": []
}
EXPORT_EOF
}

# ============================================
# Paste Configuration (interactive token input)
# ============================================

SPRITE_CONFIG_FILE="$HOME/.sprite-config"

# Parse pasted config (env-var style: KEY=value)
parse_pasted_config() {
    local config="$1"

    while IFS= read -r line; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

        # Parse KEY=value (handle values with = in them)
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            local key="${BASH_REMATCH[1]}"
            local value="${BASH_REMATCH[2]}"
            # Remove surrounding quotes if present
            value="${value#\"}"
            value="${value%\"}"
            value="${value#\'}"
            value="${value%\'}"

            case "$key" in
                GH_TOKEN)
                    export GH_TOKEN="$value"
                    echo "  GH_TOKEN: [set]"
                    ;;
                CLAUDE_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)
                    export CLAUDE_CODE_OAUTH_TOKEN="$value"
                    echo "  CLAUDE_CODE_OAUTH_TOKEN: [set]"
                    ;;
                ANTHROPIC_API_KEY)
                    export ANTHROPIC_API_KEY="$value"
                    echo "  ANTHROPIC_API_KEY: [set]"
                    ;;
                TAILSCALE_AUTH_KEY)
                    export TAILSCALE_AUTH_KEY="$value"
                    echo "  TAILSCALE_AUTH_KEY: [set]"
                    ;;
                GIT_USER_NAME)
                    GIT_USER_NAME="$value"
                    echo "  GIT_USER_NAME: $value"
                    ;;
                GIT_USER_EMAIL)
                    GIT_USER_EMAIL="$value"
                    echo "  GIT_USER_EMAIL: $value"
                    ;;
                SPRITE_MOBILE_REPO)
                    SPRITE_MOBILE_REPO="$value"
                    echo "  SPRITE_MOBILE_REPO: $value"
                    ;;
                # Sprite network S3 credentials
                SPRITE_NETWORK_S3_BUCKET|BUCKET_NAME)
                    export SPRITE_NETWORK_S3_BUCKET="$value"
                    echo "  SPRITE_NETWORK_S3_BUCKET: [set]"
                    ;;
                SPRITE_NETWORK_S3_ACCESS_KEY|AWS_ACCESS_KEY_ID)
                    export SPRITE_NETWORK_S3_ACCESS_KEY="$value"
                    echo "  SPRITE_NETWORK_S3_ACCESS_KEY: [set]"
                    ;;
                SPRITE_NETWORK_S3_SECRET_KEY|AWS_SECRET_ACCESS_KEY)
                    export SPRITE_NETWORK_S3_SECRET_KEY="$value"
                    echo "  SPRITE_NETWORK_S3_SECRET_KEY: [set]"
                    ;;
                SPRITE_NETWORK_S3_ENDPOINT|AWS_ENDPOINT_URL_S3)
                    export SPRITE_NETWORK_S3_ENDPOINT="$value"
                    echo "  SPRITE_NETWORK_S3_ENDPOINT: [set]"
                    ;;
                SPRITE_NETWORK_ORG|ORG)
                    export SPRITE_NETWORK_ORG="$value"
                    echo "  SPRITE_NETWORK_ORG: $value"
                    ;;
                FLY_API_TOKEN)
                    export FLY_API_TOKEN="$value"
                    echo "  FLY_API_TOKEN: [set]"
                    ;;
                SPRITE_API_TOKEN)
                    export SPRITE_API_TOKEN="$value"
                    echo "  SPRITE_API_TOKEN: [set]"
                    ;;
                *)
                    # Unknown key, export anyway
                    export "$key"="$value"
                    echo "  $key: [set]"
                    ;;
            esac
        fi
    done <<< "$config"
}

# Save current config (tokens only, no sprite-specific values)
save_config() {
    echo "Saving reusable config to $SPRITE_CONFIG_FILE..."

    cat > "$SPRITE_CONFIG_FILE" << EOF
# Sprite Config - reusable across sprites
# Generated: $(date -Iseconds)
# NOTE: SPRITE_PUBLIC_URL is intentionally omitted (unique per sprite)

# Git configuration
GIT_USER_NAME=$GIT_USER_NAME
GIT_USER_EMAIL=$GIT_USER_EMAIL

# Repository
SPRITE_MOBILE_REPO=$SPRITE_MOBILE_REPO

# Authentication tokens
EOF

    [ -n "$GH_TOKEN" ] && echo "GH_TOKEN=$GH_TOKEN" >> "$SPRITE_CONFIG_FILE"
    [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN" >> "$SPRITE_CONFIG_FILE"
    [ -n "$ANTHROPIC_API_KEY" ] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >> "$SPRITE_CONFIG_FILE"
    [ -n "$TAILSCALE_AUTH_KEY" ] && echo "TAILSCALE_AUTH_KEY=$TAILSCALE_AUTH_KEY" >> "$SPRITE_CONFIG_FILE"
    [ -n "$FLY_API_TOKEN" ] && echo "FLY_API_TOKEN=$FLY_API_TOKEN" >> "$SPRITE_CONFIG_FILE"
    [ -n "$SPRITE_API_TOKEN" ] && echo "SPRITE_API_TOKEN=$SPRITE_API_TOKEN" >> "$SPRITE_CONFIG_FILE"

    # Sprite network credentials
    if [ -n "$SPRITE_NETWORK_S3_BUCKET" ]; then
        echo "" >> "$SPRITE_CONFIG_FILE"
        echo "# Sprite Network" >> "$SPRITE_CONFIG_FILE"
        echo "SPRITE_NETWORK_S3_BUCKET=$SPRITE_NETWORK_S3_BUCKET" >> "$SPRITE_CONFIG_FILE"
        [ -n "$SPRITE_NETWORK_S3_ACCESS_KEY" ] && echo "SPRITE_NETWORK_S3_ACCESS_KEY=$SPRITE_NETWORK_S3_ACCESS_KEY" >> "$SPRITE_CONFIG_FILE"
        [ -n "$SPRITE_NETWORK_S3_SECRET_KEY" ] && echo "SPRITE_NETWORK_S3_SECRET_KEY=$SPRITE_NETWORK_S3_SECRET_KEY" >> "$SPRITE_CONFIG_FILE"
        [ -n "$SPRITE_NETWORK_S3_ENDPOINT" ] && echo "SPRITE_NETWORK_S3_ENDPOINT=$SPRITE_NETWORK_S3_ENDPOINT" >> "$SPRITE_CONFIG_FILE"
        [ -n "$SPRITE_NETWORK_ORG" ] && echo "SPRITE_NETWORK_ORG=$SPRITE_NETWORK_ORG" >> "$SPRITE_CONFIG_FILE"
    fi

    chmod 600 "$SPRITE_CONFIG_FILE"
    echo "Config saved to $SPRITE_CONFIG_FILE"
}

# Prompt user to paste config or load from file
prompt_for_config() {
    echo ""
    echo "============================================"
    echo "Quick Config (optional)"
    echo "============================================"
    echo ""

    # Check for saved config file
    if [ -f "$SPRITE_CONFIG_FILE" ]; then
        echo "Found saved config at $SPRITE_CONFIG_FILE"
        read -p "Use saved config? [Y/n]: " use_saved </dev/tty
        if [ "$use_saved" != "n" ] && [ "$use_saved" != "N" ]; then
            echo ""
            echo "Loading saved config..."
            parse_pasted_config "$(cat "$SPRITE_CONFIG_FILE")"
            echo ""
            return
        fi
    fi

    echo "Paste your config below to pre-fill values."
    echo "Any missing values will be prompted interactively."
    echo ""
    echo "Example format:"
    echo "  GH_TOKEN=ghp_xxx"
    echo "  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx"
    echo "  TAILSCALE_AUTH_KEY=tskey-auth-xxx"
    echo "  GIT_USER_NAME=Your Name"
    echo "  GIT_USER_EMAIL=you@example.com"
    echo ""
    echo "Paste config (end with an empty line), or just press Enter to skip:"
    echo ""

    local config=""

    # Read from /dev/tty to avoid consuming stdin
    while IFS= read -r line </dev/tty; do
        [ -z "$line" ] && break
        config+="$line"$'\n'
    done

    if [ -n "$config" ]; then
        echo ""
        echo "Parsing config..."
        parse_pasted_config "$config"
        echo ""

        # Offer to save for future use
        read -p "Save this config for future sprites? [y/N]: " save_config_choice </dev/tty
        if [ "$save_config_choice" = "y" ] || [ "$save_config_choice" = "Y" ]; then
            save_config
        fi
    fi
}

# ============================================
# Load Configuration (JSON format, for --config)
# ============================================

load_config() {
    local config_file="$1"

    if [ ! -f "$config_file" ]; then
        echo "Error: Config file not found: $config_file" >&2
        exit 1
    fi

    echo "Loading configuration from: $config_file" >&2

    local config=$(cat "$config_file")

    # Load simple values
    # NOTE: hostname and public_url are NOT loaded from config - they are unique per sprite
    local cfg_git_name=$(json_get_nested "$config" "git" "user_name")
    local cfg_git_email=$(json_get_nested "$config" "git" "user_email")
    local cfg_tailscale_key=$(json_get_nested "$config" "tailscale" "auth_key")

    # Set global variables (hostname/public_url not set - unique per sprite)
    [ -n "$cfg_git_name" ] && GIT_USER_NAME="$cfg_git_name"
    [ -n "$cfg_git_email" ] && GIT_USER_EMAIL="$cfg_git_email"
    [ -n "$cfg_tailscale_key" ] && TAILSCALE_AUTH_KEY="$cfg_tailscale_key"

    # Extract and install credentials
    local claude_creds=$(json_get_nested "$config" "credentials" "claude")
    if [ -n "$claude_creds" ]; then
        echo "  Installing Claude credentials..." >&2
        mkdir -p "$HOME/.claude"
        echo "$claude_creds" | base64 -d > "$HOME/.claude/.credentials.json"
        chmod 600 "$HOME/.claude/.credentials.json"
    fi

    local claude_token=$(json_get_nested "$config" "credentials" "claude_token")
    if [ -n "$claude_token" ]; then
        echo "  Installing Claude token..." >&2
        mkdir -p "$HOME/.config/claude-code"
        echo "$claude_token" | base64 -d > "$HOME/.config/claude-code/token"
        chmod 600 "$HOME/.config/claude-code/token"
        # Add source line to zshrc if not present
        if ! grep -q "source.*claude-code/token" ~/.zshrc 2>/dev/null; then
            echo "" >> ~/.zshrc
            echo "# Claude Code token" >> ~/.zshrc
            echo "[ -f \"\$HOME/.config/claude-code/token\" ] && source \"\$HOME/.config/claude-code/token\"" >> ~/.zshrc
        fi
    fi

    local github_creds=$(json_get_nested "$config" "credentials" "github")
    if [ -n "$github_creds" ]; then
        echo "  Installing GitHub credentials..." >&2
        mkdir -p "$HOME/.config/gh"
        echo "$github_creds" | base64 -d > "$HOME/.config/gh/hosts.yml"
        chmod 600 "$HOME/.config/gh/hosts.yml"
    fi

    local flyctl_creds=$(json_get_nested "$config" "credentials" "flyctl")
    if [ -n "$flyctl_creds" ]; then
        echo "  Installing flyctl credentials..." >&2
        mkdir -p "$HOME/.fly"
        echo "$flyctl_creds" | base64 -d | tar -xzf - -C "$HOME/.fly" 2>/dev/null || true
    fi

    local sprite_network_creds=$(json_get_nested "$config" "credentials" "sprite_network")
    if [ -n "$sprite_network_creds" ]; then
        echo "  Installing sprite-network credentials..." >&2
        mkdir -p "$HOME/.sprite-network"
        echo "$sprite_network_creds" | base64 -d > "$HOME/.sprite-network/credentials.json"
        chmod 600 "$HOME/.sprite-network/credentials.json"
    fi

    echo "Configuration loaded successfully" >&2
}

# ============================================
# Step Functions
# ============================================

step_2_configuration() {
    echo ""
    echo "=== Step 2: Configuration ==="

    # Ensure shell configs source ~/.sprite-config
    ensure_shell_config_sourcing

    # Auto-detect sprite public URL if not already set
    URL_AUTO_DETECTED=false
    if [ -z "$SPRITE_PUBLIC_URL" ]; then
        CURRENT_HOSTNAME=$(hostname)

        # Only auto-detect if hostname is not "sprite"
        if [ "$CURRENT_HOSTNAME" != "sprite" ]; then
            echo "Attempting to auto-detect sprite public URL..."

            # Try to get public URL from sprite API
            API_RESPONSE=$(sprite api /v1/sprites/"$CURRENT_HOSTNAME" 2>/dev/null || echo "")

            if [ -n "$API_RESPONSE" ]; then
                # Extract url from JSON response (simple grep/sed approach)
                AUTO_DETECTED_URL=$(echo "$API_RESPONSE" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*: *"\([^"]*\)".*/\1/' | head -1)

                if [ -n "$AUTO_DETECTED_URL" ]; then
                    SPRITE_PUBLIC_URL="$AUTO_DETECTED_URL"
                    echo "Auto-detected public URL: $SPRITE_PUBLIC_URL"
                    URL_AUTO_DETECTED=true

                    # Make the URL public
                    echo "Setting URL to public access..."
                    if sprite url update --auth public -s "$CURRENT_HOSTNAME" 2>/dev/null; then
                        echo "URL access set to public"
                    else
                        echo "Warning: Could not set URL to public (may require permissions)"
                    fi
                else
                    echo "Could not parse public URL from API response"
                fi
            else
                echo "Could not fetch sprite information from API"
            fi
        fi
    fi

    # Prompt for URLs and repo (skip prompts in non-interactive mode)
    if [ "$NON_INTERACTIVE" != "true" ]; then
        # Only prompt for URL if it wasn't auto-detected
        if [ "$URL_AUTO_DETECTED" != "true" ]; then
            read -p "Sprite public URL (optional) [$SPRITE_PUBLIC_URL]: " input_url
            SPRITE_PUBLIC_URL="${input_url:-$SPRITE_PUBLIC_URL}"
        fi

        read -p "sprite-mobile GitHub repo [$SPRITE_MOBILE_REPO]: " input_repo
        SPRITE_MOBILE_REPO="${input_repo:-$SPRITE_MOBILE_REPO}"
    fi

    # Save to ~/.sprite-config
    if [ -n "$SPRITE_PUBLIC_URL" ]; then
        update_sprite_config "SPRITE_PUBLIC_URL" "$SPRITE_PUBLIC_URL"
        echo "Saved SPRITE_PUBLIC_URL to ~/.sprite-config"
    fi

    if [ -n "$SPRITE_MOBILE_REPO" ]; then
        update_sprite_config "SPRITE_MOBILE_REPO" "$SPRITE_MOBILE_REPO"
        echo "Saved SPRITE_MOBILE_REPO to ~/.sprite-config"
    fi

    # Git user configuration
    CURRENT_GIT_NAME=$(git config --global user.name 2>/dev/null || echo "")
    CURRENT_GIT_EMAIL=$(git config --global user.email 2>/dev/null || echo "")

    # If git config provided via paste and not already set
    if [ -n "$GIT_USER_NAME" ] && [ -n "$GIT_USER_EMAIL" ] && \
       [ "$GIT_USER_NAME" != "$CURRENT_GIT_NAME" -o "$GIT_USER_EMAIL" != "$CURRENT_GIT_EMAIL" ]; then
        git config --global user.name "$GIT_USER_NAME"
        git config --global user.email "$GIT_USER_EMAIL"
        echo "Set git user.name: $GIT_USER_NAME"
        echo "Set git user.email: $GIT_USER_EMAIL"
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        # Non-interactive: use provided values or keep existing
        if [ -n "$GIT_USER_NAME" ]; then
            git config --global user.name "$GIT_USER_NAME"
            echo "Set git user.name: $GIT_USER_NAME"
        fi
        if [ -n "$GIT_USER_EMAIL" ]; then
            git config --global user.email "$GIT_USER_EMAIL"
            echo "Set git user.email: $GIT_USER_EMAIL"
        fi
        if [ -z "$GIT_USER_NAME" ] && [ -z "$GIT_USER_EMAIL" ]; then
            echo "Git configuration unchanged (no values provided)"
        fi
    elif [ -n "$CURRENT_GIT_NAME" ] && [ -n "$CURRENT_GIT_EMAIL" ]; then
        echo "Git already configured:"
        echo "  user.name: $CURRENT_GIT_NAME"
        echo "  user.email: $CURRENT_GIT_EMAIL"
        read -p "Reconfigure? [y/N]: " reconfigure
        if [ "$reconfigure" != "y" ] && [ "$reconfigure" != "Y" ]; then
            echo "Keeping existing git configuration"
        else
            read -p "Git user.name [$CURRENT_GIT_NAME]: " input_name
            GIT_USER_NAME="${input_name:-$CURRENT_GIT_NAME}"
            read -p "Git user.email [$CURRENT_GIT_EMAIL]: " input_email
            GIT_USER_EMAIL="${input_email:-$CURRENT_GIT_EMAIL}"
            git config --global user.name "$GIT_USER_NAME"
            git config --global user.email "$GIT_USER_EMAIL"
            echo "Git configuration updated"
        fi
    else
        read -p "Git user.name [$GIT_USER_NAME]: " input_name
        GIT_USER_NAME="${input_name:-$GIT_USER_NAME}"
        read -p "Git user.email [$GIT_USER_EMAIL]: " input_email
        GIT_USER_EMAIL="${input_email:-$GIT_USER_EMAIL}"
        git config --global user.name "$GIT_USER_NAME"
        git config --global user.email "$GIT_USER_EMAIL"
        echo "Git configuration complete"
    fi
}

step_3_claude() {
    echo ""
    echo "=== Step 3: Claude CLI Authentication ==="

    CLAUDE_TOKEN_FILE="$HOME/.config/claude-code/token"

    # Helper to save token to ~/.sprite-config
    save_claude_token() {
        local token_type="$1"  # "oauth" or "apikey"
        local token_value="$2"

        if [ "$token_type" = "oauth" ]; then
            update_sprite_config "CLAUDE_CODE_OAUTH_TOKEN" "$token_value"
            echo "Saved CLAUDE_CODE_OAUTH_TOKEN to ~/.sprite-config"

            # Set required flags in ~/.claude.json to skip onboarding and permissions
            mkdir -p ~/.claude
            if [ -f ~/.claude.json ]; then
                # Update existing file
                if command -v jq &>/dev/null; then
                    tmp=$(mktemp)
                    jq '.hasCompletedOnboarding = true | .bypassPermissionsModeAccepted = true' ~/.claude.json > "$tmp" && mv "$tmp" ~/.claude.json
                    echo "Updated hasCompletedOnboarding and bypassPermissionsModeAccepted in ~/.claude.json"
                else
                    # Fallback if jq not available - use sed
                    if ! grep -q '"hasCompletedOnboarding"' ~/.claude.json; then
                        sed -i 's/{/{\"hasCompletedOnboarding\": true, /' ~/.claude.json
                    else
                        sed -i 's/"hasCompletedOnboarding"[[:space:]]*:[[:space:]]*[^,}]*/"hasCompletedOnboarding": true/' ~/.claude.json
                    fi
                    if ! grep -q '"bypassPermissionsModeAccepted"' ~/.claude.json; then
                        sed -i 's/{/{\"bypassPermissionsModeAccepted\": true, /' ~/.claude.json
                    else
                        sed -i 's/"bypassPermissionsModeAccepted"[[:space:]]*:[[:space:]]*[^,}]*/"bypassPermissionsModeAccepted": true/' ~/.claude.json
                    fi
                    echo "Updated hasCompletedOnboarding and bypassPermissionsModeAccepted in ~/.claude.json (via sed)"
                fi
            else
                # Create minimal file
                cat > ~/.claude.json << CLAUDE_EOF
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true,
  "installMethod": "global",
  "autoUpdates": true
}
CLAUDE_EOF
                echo "Created ~/.claude.json with required flags"
            fi
        else
            update_sprite_config "ANTHROPIC_API_KEY" "$token_value"
            echo "Saved ANTHROPIC_API_KEY to ~/.sprite-config"
        fi
    }

    # Save tokens to ~/.sprite-config if provided (regardless of current auth status)
    if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
        echo "Claude OAuth token provided, saving to ~/.sprite-config..."
        save_claude_token "oauth" "$CLAUDE_CODE_OAUTH_TOKEN"
        echo "Claude CLI authentication configured (will be validated on first use)"
        return
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        echo "Anthropic API key provided, saving to ~/.sprite-config..."
        echo "  Note: This uses API billing, not your subscription"
        save_claude_token "apikey" "$ANTHROPIC_API_KEY"
        echo "Claude CLI authentication configured (will be validated on first use)"
        return
    fi

    # No token provided, prompt for authentication
    if [ "$NON_INTERACTIVE" = "true" ]; then
        if [ -f "$HOME/.claude/.credentials.json" ]; then
            echo "Claude credentials file installed (will be validated on first use)"
        else
            echo "Warning: Claude not authenticated and no credentials provided"
            echo "  Run interactively or provide credentials in config"
        fi
    else
        echo ""
        echo "Authentication options:"
        echo "  1) OAuth token (preserves Pro/Max subscription, recommended)"
        echo "  2) API key (uses direct API billing)"
        echo "  3) Interactive login (opens browser)"
        echo ""
        read -p "Choice [1/2/3]: " claude_choice

        case "$claude_choice" in
            1)
                echo ""
                echo "To generate an OAuth token, run 'claude setup-token' on a machine"
                echo "where you're already logged in, then paste the token here."
                echo ""
                read -p "OAuth token: " input_token
                input_token=$(strip_bracketed_paste "$input_token")
                if [ -n "$input_token" ]; then
                    export CLAUDE_CODE_OAUTH_TOKEN="$input_token"
                    save_claude_token "oauth" "$input_token"
                else
                    echo "No token provided, falling back to interactive login..."
                    claude
                fi
                ;;
            2)
                echo ""
                echo "Enter your Anthropic API key (starts with sk-ant-):"
                read -p "API key: " input_key
                input_key=$(strip_bracketed_paste "$input_key")
                if [ -n "$input_key" ]; then
                    export ANTHROPIC_API_KEY="$input_key"
                    save_claude_token "apikey" "$input_key"
                    echo "Note: This uses direct API billing, not your subscription"
                else
                    echo "No key provided, falling back to interactive login..."
                    claude
                fi
                ;;
            *)
                echo "Starting Claude CLI authentication..."
                echo "Follow the prompts to authenticate:"
                claude
                ;;
        esac
    fi
}

step_4_github() {
    echo ""
    echo "=== Step 4: GitHub CLI Authentication ==="

    # Save GH_TOKEN to ~/.sprite-config if provided (regardless of current auth status)
    if [ -n "$GH_TOKEN" ]; then
        update_sprite_config "GH_TOKEN" "$GH_TOKEN"
        echo "Saved GH_TOKEN to ~/.sprite-config"
    fi

    # Check authentication and authenticate if needed
    if gh auth status &>/dev/null; then
        echo "GitHub CLI already authenticated"
        # Ensure git credential helper is configured
        gh auth setup-git 2>/dev/null || true
        echo "Git credential helper configured"
    elif [ -n "$GH_TOKEN" ]; then
        # Token provided via config paste or environment
        echo "GitHub token provided, authenticating with gh CLI..."
        echo "$GH_TOKEN" | gh auth login --with-token
        gh auth setup-git 2>/dev/null || true
        if gh auth status &>/dev/null; then
            echo "GitHub CLI authenticated successfully"
            echo "Git credential helper configured"
        else
            echo "Warning: GitHub authentication failed with provided token"
        fi
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        if [ -f "$HOME/.config/gh/hosts.yml" ]; then
            echo "GitHub credentials file installed (verifying...)"
            # Setup git credential helper first
            gh auth setup-git 2>/dev/null || true
            if gh auth status &>/dev/null; then
                echo "GitHub CLI authenticated successfully"
            else
                echo "Warning: GitHub credentials installed but validation failed"
            fi
        else
            echo "Warning: GitHub not authenticated and no credentials provided"
            echo "  Run interactively or provide credentials in config"
        fi
    else
        echo ""
        echo "Authentication options:"
        echo "  1) Personal Access Token (non-interactive, recommended)"
        echo "  2) Interactive login (opens browser)"
        echo ""
        read -p "Choice [1/2]: " gh_choice

        case "$gh_choice" in
            1)
                echo ""
                echo "Create a Personal Access Token at:"
                echo "  https://github.com/settings/tokens"
                echo ""
                echo "Required scopes: repo, read:org, gist"
                echo "(For fine-grained tokens, grant Repository and Organization read access)"
                echo ""
                read -p "GitHub token: " input_token
                input_token=$(strip_bracketed_paste "$input_token")
                if [ -n "$input_token" ]; then
                    echo "$input_token" | gh auth login --with-token
                    gh auth setup-git 2>/dev/null || true
                    if gh auth status &>/dev/null; then
                        echo "GitHub CLI authenticated successfully"
                        echo "Git credential helper configured"
                    else
                        echo "Authentication failed. Token may be invalid or missing scopes."
                        echo "Falling back to interactive login..."
                        gh auth login </dev/tty
                        gh auth setup-git 2>/dev/null || true
                    fi
                else
                    echo "No token provided, falling back to interactive login..."
                    gh auth login </dev/tty
                    gh auth setup-git 2>/dev/null || true
                fi
                ;;
            *)
                echo "Starting GitHub CLI authentication..."
                # Clear any stale state that might interfere
                rm -f "$HOME/.config/gh/hosts.yml" 2>/dev/null
                mkdir -p "$HOME/.config/gh"

                # Flush any leftover stdin from previous steps
                read -t 0.1 -n 10000 discard 2>/dev/null || true

                echo "Follow the prompts to authenticate:"
                gh auth login </dev/tty

                # Setup git credential helper after auth
                gh auth setup-git 2>/dev/null || true
                echo "Git credential helper configured"
                ;;
        esac
    fi
}

step_5_flyctl() {
    echo ""
    echo "=== Step 5: Fly.io CLI Installation ==="

    # Set flyctl install location (constant path, handled by shell configs)
    export FLYCTL_INSTALL="/home/sprite/.fly"
    export PATH="$FLYCTL_INSTALL/bin:$PATH"

    if command -v flyctl &>/dev/null; then
        echo "flyctl already installed"
    else
        echo "Installing flyctl..."
        curl -L https://fly.io/install.sh | sh
    fi

    # Save FLY_API_TOKEN to ~/.sprite-config if provided (regardless of current auth status)
    if [ -n "$FLY_API_TOKEN" ]; then
        update_sprite_config "FLY_API_TOKEN" "$FLY_API_TOKEN"
        echo "Saved FLY_API_TOKEN to ~/.sprite-config"
    fi

    # Authenticate Fly.io if not already logged in
    if flyctl auth whoami &>/dev/null; then
        echo "Fly.io already authenticated"
    elif [ -n "$FLY_API_TOKEN" ]; then
        # Token provided via config paste or environment
        echo "Fly.io API token provided (already saved to ~/.sprite-config)"
        # FLY_API_TOKEN is already exported, flyctl will use it automatically
        if ! flyctl auth whoami &>/dev/null; then
            echo "Warning: FLY_API_TOKEN provided but authentication failed"
        fi
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        if [ -d "$HOME/.fly" ]; then
            echo "Fly.io credentials installed (verifying...)"
            if flyctl auth whoami &>/dev/null; then
                echo "Fly.io authenticated successfully"
            else
                echo "Warning: Fly.io credentials installed but validation failed"
            fi
        else
            echo "Warning: Fly.io not authenticated and no credentials provided"
            echo "  Run interactively or provide FLY_API_TOKEN in config"
        fi
    else
        echo "Authenticating Fly.io..."
        echo "Follow the prompts to authenticate:"
        flyctl auth login
    fi
}

step_6_sprites() {
    echo ""
    echo "=== Step 1: Sprites CLI Installation ==="

    if command -v sprite &>/dev/null; then
        echo "Sprites CLI already installed"
    else
        echo "Installing Sprites CLI..."
        curl -L https://sprites-binaries.t3.storage.dev/client/v0.0.1-rc28/sprite-linux-amd64.tar.gz -o /tmp/sprite.tar.gz
        tar -xzf /tmp/sprite.tar.gz -C /tmp
        sudo mv /tmp/sprite /usr/local/bin/sprite
        sudo chmod +x /usr/local/bin/sprite
        rm /tmp/sprite.tar.gz
        echo "Sprites CLI installed to /usr/local/bin/sprite"
    fi

    # Save SPRITE_API_TOKEN to ~/.sprite-config if provided (regardless of current auth status)
    if [ -n "$SPRITE_API_TOKEN" ]; then
        update_sprite_config "SPRITE_API_TOKEN" "$SPRITE_API_TOKEN"
        echo "Saved SPRITE_API_TOKEN to ~/.sprite-config"
    fi

    # Authenticate Sprites CLI and org
    if [ -d "$HOME/.sprite" ]; then
        echo "Sprites CLI already authenticated"
    elif [ -n "$SPRITE_API_TOKEN" ]; then
        # Token provided via config paste or environment
        echo "Sprite API token provided, setting up authentication (already saved to .zshrc)..."
        sprite auth setup --token "$SPRITE_API_TOKEN"
        if [ $? -eq 0 ]; then
            echo "Sprites CLI authenticated successfully with token"
        else
            echo "Warning: Failed to authenticate with provided token"
            echo "  Token format should be: org-slug/org-id/token-id/token-value"
        fi
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        echo "Warning: Sprites CLI not authenticated"
        echo "  Run interactively or provide SPRITE_API_TOKEN in config"
        echo "  Token format: org-slug/org-id/token-id/token-value"
    else
        echo "Logging in to Sprites CLI..."
        echo "Follow the prompts to authenticate:"
        sprite login
    fi
}

step_6_5_network() {
    echo ""
    echo "=== Step 9: Sprite Network (Optional) ==="
    echo "Note: Credentials are configured here, and sprite-mobile was restarted"
    echo "      in step 7 to pick up TAILSCALE_SERVE_URL for network registration"

    SPRITE_NETWORK_DIR="$HOME/.sprite-network"
    SPRITE_NETWORK_CREDS="$SPRITE_NETWORK_DIR/credentials.json"

    if [ -f "$SPRITE_NETWORK_CREDS" ]; then
        echo "Sprite network credentials already configured"
        return
    fi

    # Check if credentials were provided via config paste or environment
    if [ -n "$SPRITE_NETWORK_S3_BUCKET" ] && [ -n "$SPRITE_NETWORK_S3_ACCESS_KEY" ] && [ -n "$SPRITE_NETWORK_S3_SECRET_KEY" ]; then
        echo "Sprite network credentials provided, saving..."
        mkdir -p "$SPRITE_NETWORK_DIR"
        cat > "$SPRITE_NETWORK_CREDS" << CREDS_EOF
{
  "AWS_ACCESS_KEY_ID": "$SPRITE_NETWORK_S3_ACCESS_KEY",
  "AWS_SECRET_ACCESS_KEY": "$SPRITE_NETWORK_S3_SECRET_KEY",
  "AWS_ENDPOINT_URL_S3": "${SPRITE_NETWORK_S3_ENDPOINT:-https://fly.storage.tigris.dev}",
  "BUCKET_NAME": "$SPRITE_NETWORK_S3_BUCKET",
  "ORG": "${SPRITE_NETWORK_ORG:-}"
}
CREDS_EOF
        chmod 600 "$SPRITE_NETWORK_CREDS"
        echo "Credentials saved to $SPRITE_NETWORK_CREDS"
        return
    fi

    if [ "$NON_INTERACTIVE" = "true" ]; then
        echo "Skipping Sprite Network setup (non-interactive, no credentials provided)"
        return
    fi

    echo "Sprite Network enables automatic discovery of other sprites in your organization."
    echo "It uses a shared Tigris S3 bucket to register and discover sprites."
    echo ""

    read -p "Set up Sprite Network? [y/N]: " setup_network
    if [ "$setup_network" = "y" ] || [ "$setup_network" = "Y" ]; then
        echo ""
        echo "Options:"
        echo "  1) Create new Tigris bucket (requires flyctl)"
        echo "  2) Enter existing credentials"
        echo "  3) Skip"
        read -p "Choice [1/2/3]: " network_choice

        case "$network_choice" in
            1)
                if ! command -v flyctl &>/dev/null; then
                    echo "flyctl not found. Please install it first or use option 2."
                else
                    read -p "Fly.io org name: " FLY_ORG
                    BUCKET_NAME="sprite-network-${FLY_ORG}"
                    echo "Creating Tigris bucket: $BUCKET_NAME"

                    # Create the bucket
                    if flyctl storage create -o "$FLY_ORG" -n "$BUCKET_NAME" --public; then
                        echo "Bucket created successfully"

                        # Get credentials
                        echo "Fetching credentials..."
                        CREDS_OUTPUT=$(flyctl storage dashboard -o "$FLY_ORG" "$BUCKET_NAME" --json 2>/dev/null || echo "{}")

                        if echo "$CREDS_OUTPUT" | grep -q "AWS_ACCESS_KEY_ID"; then
                            mkdir -p "$SPRITE_NETWORK_DIR"
                            # Extract credentials from flyctl output
                            AWS_ACCESS_KEY_ID=$(echo "$CREDS_OUTPUT" | grep -o '"AWS_ACCESS_KEY_ID":"[^"]*"' | cut -d'"' -f4)
                            AWS_SECRET_ACCESS_KEY=$(echo "$CREDS_OUTPUT" | grep -o '"AWS_SECRET_ACCESS_KEY":"[^"]*"' | cut -d'"' -f4)
                            AWS_ENDPOINT_URL_S3=$(echo "$CREDS_OUTPUT" | grep -o '"AWS_ENDPOINT_URL_S3":"[^"]*"' | cut -d'"' -f4)

                            cat > "$SPRITE_NETWORK_CREDS" << CREDS_EOF
{
  "AWS_ACCESS_KEY_ID": "$AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY": "$AWS_SECRET_ACCESS_KEY",
  "AWS_ENDPOINT_URL_S3": "$AWS_ENDPOINT_URL_S3",
  "BUCKET_NAME": "$BUCKET_NAME",
  "ORG": "$FLY_ORG"
}
CREDS_EOF
                            chmod 600 "$SPRITE_NETWORK_CREDS"
                            echo "Credentials saved to $SPRITE_NETWORK_CREDS"
                        else
                            echo "Could not fetch credentials automatically."
                            echo "Run: flyctl storage dashboard -o $FLY_ORG $BUCKET_NAME"
                            echo "Then use option 2 to enter credentials manually."
                        fi
                    else
                        echo "Failed to create bucket. It may already exist - try option 2."
                    fi
                fi
                ;;
            2)
                echo ""
                echo "Paste JSON credentials (end with an empty line):"
                echo "Example format:"
                echo '  {"AWS_ACCESS_KEY_ID": "...", "AWS_SECRET_ACCESS_KEY": "...", ...}'
                echo ""

                # Read multi-line JSON input
                json_input=""
                while IFS= read -r line; do
                    [ -z "$line" ] && break
                    json_input+="$line"
                done

                # Validate it looks like JSON with required fields
                if echo "$json_input" | grep -q "AWS_ACCESS_KEY_ID" && \
                   echo "$json_input" | grep -q "AWS_SECRET_ACCESS_KEY" && \
                   echo "$json_input" | grep -q "BUCKET_NAME"; then
                    mkdir -p "$SPRITE_NETWORK_DIR"
                    echo "$json_input" > "$SPRITE_NETWORK_CREDS"
                    chmod 600 "$SPRITE_NETWORK_CREDS"
                    echo "Credentials saved to $SPRITE_NETWORK_CREDS"
                else
                    echo "Error: JSON must contain AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and BUCKET_NAME"
                fi
                ;;
            *)
                echo "Skipping Sprite Network setup"
                ;;
        esac
    else
        echo "Skipping Sprite Network setup"
    fi
}

step_7_tailscale() {
    echo ""
    echo "=== Step 6: Tailscale Installation ==="

    TAILSCALE_AUTH_KEY_FILE="$HOME/.config/sprite/tailscale-auth-key"

    if command -v tailscale &>/dev/null; then
        echo "Tailscale already installed"
    else
        echo "Installing Tailscale..."
        curl -fsSL https://tailscale.com/install.sh | sh
    fi

    # Check if tailscaled service is running
    if sprite_api /v1/services 2>/dev/null | grep -q '"tailscaled"'; then
        echo "Tailscaled service already running"
    else
        echo "Starting tailscaled service..."
        sprite_api -X PUT '/v1/services/tailscaled?duration=3s' -d '{
          "cmd": "tailscaled",
          "args": ["--state=/var/lib/tailscale/tailscaled.state", "--socket=/var/run/tailscale/tailscaled.sock"]
        }'
        sleep 3
    fi

    # Load saved auth key if available and not already set
    if [ -z "$TAILSCALE_AUTH_KEY" ] && [ -f "$TAILSCALE_AUTH_KEY_FILE" ]; then
        TAILSCALE_AUTH_KEY=$(cat "$TAILSCALE_AUTH_KEY_FILE")
    fi

    # Authenticate Tailscale if not already connected
    if tailscale status &>/dev/null; then
        echo "Tailscale already connected"
    elif [ -n "$TAILSCALE_AUTH_KEY" ]; then
        # Auth key provided via config paste or environment
        echo "Authenticating Tailscale with provided auth key..."
        # Save for future exports
        mkdir -p "$(dirname "$TAILSCALE_AUTH_KEY_FILE")"
        echo "$TAILSCALE_AUTH_KEY" > "$TAILSCALE_AUTH_KEY_FILE"
        chmod 600 "$TAILSCALE_AUTH_KEY_FILE"
        sudo tailscale up --authkey="$TAILSCALE_AUTH_KEY"
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        echo "Warning: Tailscale not connected and no auth key provided"
        echo "  Tailscale requires interactive authentication or an auth key"
        echo "  Generate a reusable auth key at: https://login.tailscale.com/admin/settings/keys"
        echo "  Then add it to your config as TAILSCALE_AUTH_KEY"
        return
    else
        # Interactive mode - ask about reusable auth key for future automation
        echo ""
        echo "Tailscale authentication options:"
        echo "  1) Interactive login (opens browser URL)"
        echo "  2) Use a reusable auth key (enables automated setup of future sprites)"
        echo ""
        read -p "Choice [1/2]: " ts_choice

        if [ "$ts_choice" = "2" ]; then
            echo ""
            echo "To create a reusable auth key:"
            echo "  1. Go to: https://login.tailscale.com/admin/settings/keys"
            echo "  2. Click 'Generate auth key'"
            echo "  3. Check 'Reusable' (important for automating multiple sprites)"
            echo "  4. Optionally set expiry and tags"
            echo "  5. Copy the generated key"
            echo ""
            read -p "Paste your reusable auth key: " input_key
            input_key=$(strip_bracketed_paste "$input_key")

            if [ -n "$input_key" ]; then
                TAILSCALE_AUTH_KEY="$input_key"
                # Save for future exports
                mkdir -p "$(dirname "$TAILSCALE_AUTH_KEY_FILE")"
                echo "$TAILSCALE_AUTH_KEY" > "$TAILSCALE_AUTH_KEY_FILE"
                chmod 600 "$TAILSCALE_AUTH_KEY_FILE"
                echo "Auth key saved for future sprite setups"
                echo ""
                echo "Authenticating Tailscale with auth key..."
                sudo tailscale up --authkey="$TAILSCALE_AUTH_KEY"
            else
                echo "No key provided, falling back to interactive login..."
                sudo tailscale up
            fi
        else
            echo "Authenticating Tailscale..."
            echo "Visit the URL shown to add this sprite to your tailnet:"
            sudo tailscale up
        fi
    fi

    TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")
    if [ -n "$TAILSCALE_IP" ]; then
        echo "Tailscale IP: $TAILSCALE_IP"
    fi

    # Save auth key if provided via config (for future exports)
    if [ -n "$TAILSCALE_AUTH_KEY" ] && [ ! -f "$TAILSCALE_AUTH_KEY_FILE" ]; then
        mkdir -p "$(dirname "$TAILSCALE_AUTH_KEY_FILE")"
        echo "$TAILSCALE_AUTH_KEY" > "$TAILSCALE_AUTH_KEY_FILE"
        chmod 600 "$TAILSCALE_AUTH_KEY_FILE"
    fi
}

step_8_sprite_mobile() {
    echo ""
    echo "=== Step 8: sprite-mobile Setup ==="

    SPRITE_MOBILE_DIR="$HOME/.sprite-mobile"

    if [ -d "$SPRITE_MOBILE_DIR/.git" ]; then
        # It's a git repo, pull latest
        echo "sprite-mobile already exists, pulling latest..."
        cd "$SPRITE_MOBILE_DIR"
        git pull
    elif [ -d "$SPRITE_MOBILE_DIR" ]; then
        # Directory exists but not a git repo - remove and clone fresh
        echo "sprite-mobile directory exists but is not a git repo, cloning..."
        rm -rf "$SPRITE_MOBILE_DIR"
        gh repo clone "$SPRITE_MOBILE_REPO" "$SPRITE_MOBILE_DIR"
    else
        echo "Cloning sprite-mobile..."
        gh repo clone "$SPRITE_MOBILE_REPO" "$SPRITE_MOBILE_DIR"
    fi

    # Install dependencies
    echo "Installing sprite-mobile dependencies..."
    cd "$SPRITE_MOBILE_DIR"
    bun install

    # Environment variables are sourced from ~/.sprite-config via start-service.sh
    # No need to write .env file

    # Check if sprite-mobile service is running
    if sprite_api /v1/services 2>/dev/null | grep -q '"sprite-mobile"'; then
        echo "sprite-mobile service already running, restarting to pick up new environment..."
        sprite_api -X DELETE '/v1/services/sprite-mobile' 2>/dev/null || true
        sleep 1
    fi

    echo "Starting sprite-mobile service on port $APP_PORT..."
    # Use wrapper script that sources .zshrc to avoid logging tokens
    sprite_api -X PUT '/v1/services/sprite-mobile?duration=3s' -d "{
      \"cmd\": \"$SPRITE_MOBILE_DIR/start-service.sh\"
    }"
}

step_9_tailscale_serve() {
    echo ""
    echo "=== Step 7: Tailscale Serve ==="
    echo "Exposing sprite-mobile via HTTPS on your tailnet (enables PWA/service worker)"

    # Check if already serving
    if tailscale serve status 2>/dev/null | grep -q ":$APP_PORT"; then
        echo "Tailscale serve already configured for port $APP_PORT"
    else
        echo "Setting up Tailscale serve for sprite-mobile..."
        tailscale serve --bg $APP_PORT
    fi

    # Get the Tailscale serve URL from serve status output
    TAILSCALE_SERVE_URL=$(tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)
    if [ -n "$TAILSCALE_SERVE_URL" ]; then
        echo "Tailscale HTTPS URL: $TAILSCALE_SERVE_URL"

        # Save to ~/.sprite-config (sprite-mobile will read via start-service.sh)
        update_sprite_config "TAILSCALE_SERVE_URL" "$TAILSCALE_SERVE_URL"
        echo "  Saved TAILSCALE_SERVE_URL to ~/.sprite-config"

        # Restart sprite-mobile if running to pick up new TAILSCALE_SERVE_URL
        SPRITE_MOBILE_DIR="$HOME/.sprite-mobile"
        if sprite_api /v1/services 2>/dev/null | grep -q '"sprite-mobile"'; then
            echo "  Restarting sprite-mobile to pick up TAILSCALE_SERVE_URL..."
            sprite_api -X DELETE '/v1/services/sprite-mobile' 2>/dev/null || true
            sleep 2
            sprite_api -X PUT '/v1/services/sprite-mobile?duration=3s' -d "{
              \"cmd\": \"$SPRITE_MOBILE_DIR/start-service.sh\"
            }"
            echo "  sprite-mobile restarted"
        fi
    else
        TAILSCALE_SERVE_URL=""
        echo "Could not determine Tailscale serve URL (check 'tailscale serve status')"
    fi
}

step_10_tailnet_gate() {
    echo ""
    echo "=== Step 10: Tailnet Gate ==="
    echo "Public endpoint that redirects to Tailscale URL if on tailnet"

    GATE_DIR="$HOME/.tailnet-gate"

    # Get TAILSCALE_SERVE_URL if not already set
    if [ -z "$TAILSCALE_SERVE_URL" ]; then
        TAILSCALE_SERVE_URL=$(tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)
    fi

    # Always recreate the gate server (in case TAILSCALE_SERVE_URL changed)
    echo "Creating tailnet gate server..."
    mkdir -p "$GATE_DIR"

    cat > "$GATE_DIR/server.ts" << GATE_EOF
const PORT = 8080;
const TAILSCALE_URL = "${TAILSCALE_SERVE_URL}";

const html = \`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connecting...</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1a1a2e;
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .emoji {
      font-size: 4rem;
      margin-bottom: 1rem;
      filter: sepia(1) saturate(5) hue-rotate(70deg) brightness(1.1);
    }
    .blocked { display: none; }
    .blocked .emoji { filter: none; }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid #333;
      border-top-color: #39ff14;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 1rem auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container" id="loading">
    <div class="emoji">👾</div>
    <h1>Connecting...</h1>
    <div class="spinner"></div>
  </div>
  <div class="container blocked" id="blocked">
    <div class="emoji">👾 🚫</div>
    <h1>Unauthorized</h1>
  </div>
  <script>
    const tailscaleUrl = "\${TAILSCALE_URL}";
    const maxRetries = 10;
    const retryDelay = 2000;

    async function tryConnect(attempt) {
      try {
        const r = await fetch(tailscaleUrl + '/api/config', {
          mode: 'cors',
          signal: AbortSignal.timeout(5000)
        });
        if (r.ok) {
          window.location.href = tailscaleUrl;
        } else {
          throw new Error('not ok');
        }
      } catch (e) {
        if (attempt < maxRetries) {
          setTimeout(() => tryConnect(attempt + 1), retryDelay);
        } else {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('blocked').style.display = 'block';
        }
      }
    }

    if (!tailscaleUrl) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('blocked').style.display = 'block';
    } else {
      tryConnect(1);
    }
  </script>
</body>
</html>\`;

const server = Bun.serve({
  port: PORT,
  async fetch() {
    // Return streaming response to keep HTTP connection open
    // This keeps the sprite awake for 30 minutes
    const stream = new ReadableStream({
      async start(controller) {
        // Send the HTML immediately
        controller.enqueue(new TextEncoder().encode(html));

        // Keep connection open for 30 minutes with periodic chunks
        const endTime = Date.now() + 30 * 60 * 1000; // 30 minutes
        const keepAlive = setInterval(() => {
          if (Date.now() >= endTime) {
            clearInterval(keepAlive);
            controller.close();
            console.log("[gate] Keep-alive timeout, closing connection");
          } else {
            // Send invisible HTML comment to keep connection alive
            controller.enqueue(new TextEncoder().encode("<!-- keepalive -->"));
          }
        }, 10000); // Every 10 seconds

        console.log("[gate] Started streaming keep-alive (30min timeout)");
      }
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/html" },
    });
  },
});

console.log("Tailnet gate running on http://localhost:" + PORT);
console.log("Redirects to: " + (TAILSCALE_URL || "(not configured)"));
GATE_EOF

    # Check if gate service is running
    if sprite_api /v1/services 2>/dev/null | grep -q '"tailnet-gate"'; then
        echo "Restarting tailnet-gate service..."
        sprite_api -X DELETE '/v1/services/tailnet-gate' 2>/dev/null || true
        sleep 1
    fi

    echo "Starting tailnet-gate service on port $WAKEUP_PORT..."
    sprite_api -X PUT '/v1/services/tailnet-gate?duration=3s' -d "{
      \"cmd\": \"bun\",
      \"args\": [\"run\", \"$GATE_DIR/server.ts\"],
      \"http_port\": $WAKEUP_PORT
    }"
}

step_11_claude_md() {
    echo ""
    echo "=== Step 11: CLAUDE.md Setup ==="

    CLAUDE_MD_PATH="$HOME/CLAUDE.md"

    echo "Creating CLAUDE.md with environment instructions..."
    cat > "$CLAUDE_MD_PATH" << 'CLAUDE_EOF'
# Claude Instructions

## First Steps

Always read `/.sprite/llm.txt` at the start of a session to understand the Sprite environment, available services, checkpoints, and network policy.

## Checkpointing

Claude should proactively manage checkpoints using the `/sprite` skill or `sprite-env checkpoint` commands:
- Create checkpoints after significant changes or successful implementations
- Before risky operations, create a checkpoint as a restore point
- Use `sprite-env checkpoint list` to view available checkpoints
- Use `sprite-env checkpoint restore <name>` to restore if needed

## Services

### sprite-mobile (port 8081)
Mobile-friendly web interface for chatting with Claude Code. Located at `~/.sprite-mobile/`.

- Auto-updates on service start via `git pull`
- Supports multiple concurrent chat sessions with persistent history
- Uses WebSocket for real-time streaming
- Data stored in `~/.sprite-mobile/data/`

Service command:
```bash
sprite-env services list  # View status
sprite-env services logs sprite-mobile  # View logs
```

### tailnet-gate (port 8080)
Public entry point that gates access via Tailscale. Located at `~/.tailnet-gate/`.

**How it works:**
1. User visits public URL (e.g., `https://sprite.fly.dev`)
2. Gate serves a page that attempts to reach the Tailscale URL
3. If reachable (user on tailnet) → redirects to Tailscale HTTPS URL
4. If unreachable → shows "Unauthorized" page

This ensures only users on the tailnet can access the sprite without requiring passwords or tokens.

### Other Services
- `tailscaled` - Tailscale daemon

## Git Commits

Do NOT add "Co-Authored-By" lines to commit messages. Just write normal commit messages without any co-author attribution.
CLAUDE_EOF

    echo "Created $CLAUDE_MD_PATH"
}

show_summary() {
    TAILSCALE_SERVE_URL=$(tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)

    echo ""
    echo "============================================"
    echo "Setup Complete!"
    echo "============================================"
    echo ""
    if [ -n "$SPRITE_PUBLIC_URL" ]; then
        echo "Public URL: $SPRITE_PUBLIC_URL"
        echo "  - Wakes sprite and redirects to Tailscale URL if on tailnet"
        echo "  - Shows 'Unauthorized' if not on tailnet"
        echo ""
    fi
    if [ -n "$TAILSCALE_SERVE_URL" ]; then
        echo "Tailscale HTTPS (PWA-ready):"
        echo "  - sprite-mobile: $TAILSCALE_SERVE_URL"
        echo ""
    fi
    echo "To check service status:"
    echo "  sprite-env services list"
    echo ""
    echo "Note: If you configured Claude or GitHub tokens, log out and back in"
    echo "      to use 'claude' and 'gh' commands in new terminal sessions."
    echo ""
}

# ============================================
# Step Registry
# ============================================

STEP_NAMES=(
    "Sprites CLI"
    "Configuration"
    "Claude CLI auth"
    "GitHub CLI auth"
    "Fly.io CLI (flyctl)"
    "Tailscale"
    "Tailscale Serve (HTTPS)"
    "sprite-mobile"
    "Sprite Network (optional)"
    "Tailnet Gate"
    "CLAUDE.md"
)

run_step() {
    local step_num="$1"
    case "$step_num" in
        1) step_6_sprites ;;
        2) step_2_configuration ;;
        3) step_3_claude ;;
        4) step_4_github ;;
        5) step_5_flyctl ;;
        6) step_7_tailscale ;;
        7) step_9_tailscale_serve ;;
        8) step_8_sprite_mobile ;;
        9) step_6_5_network ;;
        10) step_10_tailnet_gate ;;
        11) step_11_claude_md ;;
        *) echo "Unknown step: $step_num" >&2; return 1 ;;
    esac
}

show_menu() {
    echo "============================================"
    echo "Sprite Setup Script"
    echo "============================================"
    echo ""
    echo "Available steps:"
    echo "   1.   Sprites CLI installation"
    echo "   2.   Configuration (URLs, repo, git)"
    echo "   3.   Claude CLI authentication"
    echo "   4.   GitHub CLI authentication"
    echo "   5.   Fly.io CLI (flyctl) installation"
    echo "   6.   Tailscale installation"
    echo "   7.   Tailscale Serve (HTTPS for PWA)"
    echo "   8.   sprite-mobile setup"
    echo "   9.   Sprite Network (optional)"
    echo "  10.   Tailnet Gate (public entry point)"
    echo "  11.   CLAUDE.md creation"
    echo ""
    echo "Options:"
    echo "  all     - Run all steps sequentially"
    echo "  <nums>  - Run specific steps (e.g., '1 3 5' or '7-10')"
    echo "  q       - Quit"
    echo ""
}

parse_step_range() {
    local input="$1"
    local steps=()

    for part in $input; do
        if [[ "$part" == *-* ]]; then
            # Handle range like "8-12"
            local start="${part%-*}"
            local end="${part#*-}"
            for ((i=start; i<=end; i++)); do
                steps+=("$i")
            done
        else
            steps+=("$part")
        fi
    done

    echo "${steps[@]}"
}

run_all_steps() {
    step_6_sprites
    step_2_configuration
    step_3_claude
    step_4_github
    step_5_flyctl
    step_7_tailscale
    step_9_tailscale_serve
    step_8_sprite_mobile
    step_6_5_network
    step_10_tailnet_gate
    step_11_claude_md

    # Final restart of sprite-mobile to pick up all environment changes
    echo ""
    echo "Restarting sprite-mobile to pick up all environment changes..."
    SPRITE_MOBILE_DIR="$HOME/.sprite-mobile"
    if sprite_api /v1/services 2>/dev/null | grep -q '"sprite-mobile"'; then
        sprite_api -X DELETE '/v1/services/sprite-mobile' 2>/dev/null || true
        sleep 2
        sprite_api -X PUT '/v1/services/sprite-mobile?duration=3s' -d "{
          \"cmd\": \"$SPRITE_MOBILE_DIR/start-service.sh\"
        }"
        echo "sprite-mobile restarted"
    fi

    show_summary
}

# ============================================
# Main Entry Point
# ============================================

show_help() {
    show_menu
    echo "Usage: $0 [OPTIONS] [all | step numbers]"
    echo ""
    echo "Options:"
    echo "  --export              Export current sprite config as JSON (to stdout)"
    echo "  --config <file>       Run non-interactively using config file"
    echo "  --config -            Read config from stdin"
    echo "  --name <name>         Set sprite name/hostname (for new sprite setup)"
    echo "  --url <url>           Set sprite public URL (for new sprite setup)"
    echo "  -h, --help            Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 all                       # Run all steps interactively"
    echo "  $0 1 3 5                     # Run steps 1, 3, and 5"
    echo "  $0 8-11                      # Run steps 8 through 11"
    echo "  $0 --export > config.json    # Export config to file"
    echo "  $0 --config config.json all  # Run all steps non-interactively"
    echo "  $0 --config config.json 1-8  # Run steps 1-8 non-interactively"
    echo ""
    echo "Orchestrating new sprites from an existing sprite:"
    echo "  $0 --config config.json --name my-sprite --url https://my-sprite.sprites.app all"
    echo ""
    echo "Non-interactive mode:"
    echo "  Use --export on a configured sprite to generate a config file,"
    echo "  then use --config on a new sprite to apply the same configuration."
    echo "  Use --name and --url to set the target sprite's identity."
    echo "  Tailscale requires a reusable auth key for fully automated setup."
    echo ""
    echo "Environment variables for non-interactive auth:"
    echo "  CLAUDE_CODE_OAUTH_TOKEN  OAuth token from 'claude setup-token' (preserves subscription)"
    echo "  ANTHROPIC_API_KEY        Direct API key (uses API billing, not subscription)"
    echo "  GH_TOKEN                 GitHub Personal Access Token"
    echo "  TAILSCALE_AUTH_KEY       Tailscale reusable auth key"
    echo "  FLY_API_TOKEN            Fly.io API token (from 'flyctl auth token')"
    echo "  SPRITE_API_TOKEN         Sprite CLI API token (optional)"
    echo ""
    echo "Example with tokens:"
    echo "  GH_TOKEN=ghp_xxx CLAUDE_CODE_OAUTH_TOKEN=xxx $0 3 4"
    echo ""
    echo "Quick Config (interactive paste):"
    echo "  When running interactively, you can paste a config after selecting steps."
    echo "  See sprite-config.example for the format."
    echo "  Pasted configs can be saved to ~/.sprite-config for reuse."
    echo ""
}

# Parse arguments
POSITIONAL_ARGS=()
SPRITE_NAME=""
while [ $# -gt 0 ]; do
    case "$1" in
        --export)
            export_config
            exit 0
            ;;
        --config)
            shift
            if [ -z "$1" ]; then
                echo "Error: --config requires a file path or '-' for stdin" >&2
                exit 1
            fi
            if [ "$1" = "-" ]; then
                # Read from stdin into temp file
                CONFIG_FILE=$(mktemp)
                cat > "$CONFIG_FILE"
                trap "rm -f $CONFIG_FILE" EXIT
            else
                CONFIG_FILE="$1"
            fi
            NON_INTERACTIVE="true"
            load_config "$CONFIG_FILE"
            shift
            ;;
        --name)
            shift
            if [ -z "$1" ]; then
                echo "Error: --name requires a sprite name" >&2
                exit 1
            fi
            SPRITE_NAME="$1"
            shift
            ;;
        --url)
            shift
            if [ -z "$1" ]; then
                echo "Error: --url requires a URL" >&2
                exit 1
            fi
            SPRITE_PUBLIC_URL="$1"
            shift
            ;;
        -h|--help|help)
            show_help
            exit 0
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

# If --name provided, derive URL if not explicitly set
if [ -n "$SPRITE_NAME" ]; then
    # Default URL pattern for sprites.app
    if [ -z "$SPRITE_PUBLIC_URL" ]; then
        SPRITE_PUBLIC_URL="https://${SPRITE_NAME}.fly.dev"
        echo "Derived public URL: $SPRITE_PUBLIC_URL" >&2
    fi
fi

# Restore positional args
set -- "${POSITIONAL_ARGS[@]}"

# If arguments provided, use them directly
if [ $# -gt 0 ]; then
    if [ "$1" = "all" ] || [ "$1" = "--all" ] || [ "$1" = "-a" ]; then
        run_all_steps
    else
        # Run specified steps
        steps=$(parse_step_range "$*")
        for step in $steps; do
            run_step "$step"
        done
    fi
    exit 0
fi

# Interactive mode
show_menu
read -p "Select steps (or 'all'): " selection

if [ "$selection" = "q" ] || [ "$selection" = "quit" ]; then
    echo "Exiting."
    exit 0
fi

# Prompt for config paste before running steps
prompt_for_config

if [ "$selection" = "all" ]; then
    run_all_steps
else
    steps=$(parse_step_range "$selection")
    for step in $steps; do
        run_step "$step"
    done
fi
