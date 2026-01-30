#!/bin/bash
# Update and restart sprite-mobile on all other sprite-mobile sprites
# This script:
# 1. Pulls latest code from git for sprite-mobile
# 2. Pulls latest code and rebuilds claude-hub
# 3. Restarts sprite-mobile service (re-registers with new path if needed)
# 4. Restarts claude-hub service
# 5. Regenerates and restarts tailnet-gate service

set -e

HOSTNAME=$(hostname)
# Sprite names don't have the -bio2f suffix, so extract base name
SELF=${HOSTNAME%-bio2f}

echo "Updating and restarting sprite-mobile on other sprites..."
echo "Current sprite: $SELF"
echo ""

# Get list of all sprites
SPRITES=$(sprite list 2>/dev/null || echo "")

if [ -z "$SPRITES" ]; then
  echo "Error: Could not get sprite list. Is sprite CLI configured?"
  exit 1
fi

# Track success/failure
SUCCESS_COUNT=0
FAIL_COUNT=0
FAILED_SPRITES=""

for sprite_name in $SPRITES; do
  # Skip self
  if [[ "$sprite_name" == "$SELF" ]]; then
    echo "[$sprite_name] Skipping (self)"
    echo ""
    continue
  fi

  echo "[$sprite_name] Updating sprite-mobile..."

  # Pull latest code
  if sprite -s "$sprite_name" exec -- bash -c "
    set -a && source ~/.sprite-config && set +a
    cd ~/.sprite-mobile 2>/dev/null || exit 1

    # Check if this sprite has sprite-mobile
    if [ ! -f server.ts ]; then
      echo 'No sprite-mobile installation found'
      exit 1
    fi

    # Pull latest code with auth if needed
    git remote set-url origin https://\$GH_TOKEN@github.com/clouvet/sprite-mobile.git 2>/dev/null || true
    git pull
    git remote set-url origin https://github.com/clouvet/sprite-mobile.git 2>/dev/null || true

    echo 'Code updated successfully'
  " 2>&1; then
    echo "  ✓ sprite-mobile code pulled"
  else
    echo "  ✗ Failed to pull code (sprite may not have sprite-mobile)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_SPRITES="$FAILED_SPRITES $sprite_name"
    echo ""
    continue
  fi

  # Update claude-hub
  echo "  Updating claude-hub..."
  if sprite -s "$sprite_name" exec -- bash -c "
    set -a && source ~/.sprite-config && set +a
    cd ~/.claude-hub 2>/dev/null || exit 1

    # Pull latest code with auth if needed
    git remote set-url origin https://\$GH_TOKEN@github.com/clouvet/claude-hub.git 2>/dev/null || true
    git pull
    git remote set-url origin https://github.com/clouvet/claude-hub.git 2>/dev/null || true

    # Rebuild
    go build -o bin/claude-hub main.go

    echo 'claude-hub updated and rebuilt'
  " 2>&1; then
    echo "  ✓ claude-hub code pulled and rebuilt"
  else
    echo "  ✗ Failed to update claude-hub (may not be installed)"
    # Don't fail the whole update if claude-hub isn't there
  fi

  # Restart claude-hub service
  echo "  Restarting claude-hub service..."
  if sprite -s "$sprite_name" exec -- bash -c "
    set -a && source ~/.sprite-config && set +a
    cd ~/.sprite-mobile
    ./scripts/sprite-setup.sh 12
  " >/dev/null 2>&1; then
    echo "  ✓ claude-hub service restarted"
  else
    echo "  ✗ Failed to restart claude-hub (may not be installed)"
    # Don't fail the whole update if claude-hub isn't there
  fi

  # Re-register and restart sprite-mobile service
  echo "  Restarting sprite-mobile service..."
  if sprite -s "$sprite_name" exec -- bash -c "
    set -a && source ~/.sprite-config && set +a
    cd ~/.sprite-mobile
    ./scripts/sprite-setup.sh 8
  " >/dev/null 2>&1; then
    echo "  ✓ sprite-mobile service restarted"
  else
    echo "  ✗ Failed to restart service"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_SPRITES="$FAILED_SPRITES $sprite_name"
    echo ""
    continue
  fi

  # Regenerate and restart tailnet-gate
  echo "  Regenerating tailnet-gate..."
  if sprite -s "$sprite_name" exec -- bash -c "
    set -a && source ~/.sprite-config && set +a
    cd ~/.sprite-mobile
    ./scripts/sprite-setup.sh 10
  " >/dev/null 2>&1; then
    echo "  ✓ Tailnet-gate updated"
  else
    echo "  ✗ Failed to update tailnet-gate"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_SPRITES="$FAILED_SPRITES $sprite_name"
    echo ""
    continue
  fi

  SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
  echo "  ✓ Complete"
  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Update complete!"
echo "  Success: $SUCCESS_COUNT"
echo "  Failed: $FAIL_COUNT"
if [ $FAIL_COUNT -gt 0 ]; then
  echo "  Failed sprites:$FAILED_SPRITES"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
