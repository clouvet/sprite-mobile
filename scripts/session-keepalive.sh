#!/bin/bash
# Session keepalive - keeps sprite awake while Claude Code is actively generating
# This runs as a detached session and generates output to keep the sprite active

echo "[$(date)] Session keepalive started"

while true; do
  # Query claude-hub health endpoint to check if any sessions are actively generating
  HEALTH=$(curl -s http://localhost:9090/health 2>/dev/null)

  if [ -z "$HEALTH" ]; then
    echo "[$(date)] Could not reach claude-hub, exiting"
    exit 0
  fi

  # Extract keep_sprite_awake field from JSON
  KEEP_AWAKE=$(echo "$HEALTH" | grep -o '"keep_sprite_awake":[^,}]*' | grep -o 'true\|false')
  GENERATING=$(echo "$HEALTH" | grep -o '"generating":[0-9]*' | grep -o '[0-9]*')

  if [ "$KEEP_AWAKE" = "true" ]; then
    echo "[$(date)] Claude generating ($GENERATING active), keeping sprite awake"
    sleep 30
  else
    echo "[$(date)] No active generation, exiting"
    exit 0
  fi
done
