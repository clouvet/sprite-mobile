#!/bin/bash
# Wrapper script to start sprite-mobile with environment from ~/.sprite-config
# This avoids logging sensitive tokens in service creation commands

# Source sprite config (single source of truth for environment variables)
if [ -f "$HOME/.sprite-config" ]; then
    set -a  # Export all variables
    source "$HOME/.sprite-config"
    set +a  # Stop exporting
fi

# Ensure .env file has secure permissions
if [ -f "$HOME/.sprite-mobile/.env" ]; then
    chmod 600 "$HOME/.sprite-mobile/.env"
fi

# Enable Go hub for multi-client sync
export USE_GO_HUB=true

# Start the service without hot-reload to prevent refreshes during conversations
exec bun "$HOME/.sprite-mobile/server.ts"
