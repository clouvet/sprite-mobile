#!/bin/bash
# Restart sprite-mobile on all other network sprites (not this one)

HOSTNAME=$(hostname)
# Sprite names don't have the -bio2f suffix, so extract base name
SELF=${HOSTNAME%-bio2f}

echo "Restarting sprite-mobile on other sprites (I am $SELF)..."

for sprite in $(sprite list 2>/dev/null); do
  if [[ "$sprite" == "$SELF" ]]; then
    echo "  $sprite - skipping (self)"
  else
    echo -n "  $sprite - "
    if sprite exec -s "$sprite" sprite-env services signal sprite-mobile TERM 2>/dev/null; then
      echo "restarted"
    else
      echo "failed or no sprite-mobile"
    fi
  fi
done

echo "Done."
