#!/bin/bash
set -e

# ============================================
# Sprite Setup Script
# Run this once after creating a new sprite
# ============================================

# Detect which sprite API command is available
if command -v sprite-env &>/dev/null; then
    sprite_api() { sprite-env curl "$@"; }
elif command -v curl-sprite-api &>/dev/null; then
    sprite_api() { curl-sprite-api "$@"; }
else
    sprite_api() { echo "Warning: No sprite API command found" >&2; return 1; }
fi

# Configuration (set these or export before running)
GIT_USER_NAME="${GIT_USER_NAME:-}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-}"
SPRITE_MOBILE_REPO="${SPRITE_MOBILE_REPO:-https://github.com/superfly/sprite-mobile}"
SPRITE_PUBLIC_URL="${SPRITE_PUBLIC_URL:-}"
TTYD_PORT="${TTYD_PORT:-8181}"
APP_PORT="${APP_PORT:-8081}"
WAKEUP_PORT="${WAKEUP_PORT:-8080}"

echo "============================================"
echo "Sprite Setup Script"
echo "============================================"
echo ""
echo "This script will:"
echo "  1. Fix Ghostty terminal (backspace issue)"
echo "  2. Configure hostname and git user"
echo "  3. Authenticate Claude CLI"
echo "  4. Authenticate GitHub CLI"
echo "  5. Install and authenticate Fly.io CLI (flyctl)"
echo "  6. Install and authenticate Sprites CLI"
echo "  6.5. Configure Sprite Network (optional - for sprite discovery)"
echo "  7. Install and configure Tailscale"
echo "  8. Install ttyd (web terminal) on port $TTYD_PORT"
echo "  9. Clone sprite-mobile and run on port $APP_PORT"
echo "  10. Set up Tailscale Serve (HTTPS for PWA support)"
echo "  11. Start tailnet gate on port $WAKEUP_PORT (public entry point)"
echo "  12. Create CLAUDE.md with environment instructions"
echo ""
echo "Press Enter to continue or Ctrl+C to abort..."
read

# ============================================
# Step 1: Ghostty terminfo fix
# ============================================
echo ""
echo "=== Step 1: Ghostty Terminal Fix ==="

if infocmp xterm-ghostty &>/dev/null; then
    echo "Ghostty terminfo already installed, skipping..."
else
    echo "Installing Ghostty terminfo to fix backspace issue..."
    cat > /tmp/ghostty.terminfo << 'TERMINFO_EOF'
xterm-ghostty|Ghostty,
        am, bce, bw, ccc, hs, km, mc5i, mir, msgr, npc, xenl,
        colors#0x100, cols#80, it#8, lines#24, pairs#0x7fff,
        acsc=``aaffggiijjkkllmmnnooppqqrrssttuuvvwwxxyyzz{{||}}~~,
        bel=^G, blink=\E[5m, bold=\E[1m, cbt=\E[Z,
        civis=\E[?25l, clear=\E[H\E[2J, cnorm=\E[?12h\E[?25h,
        cr=\r, csr=\E[%i%p1%d;%p2%dr, cub=\E[%p1%dD, cub1=^H,
        cud=\E[%p1%dB, cud1=\n, cuf=\E[%p1%dC, cuf1=\E[C,
        cup=\E[%i%p1%d;%p2%dH, cuu=\E[%p1%dA, cuu1=\E[A,
        cvvis=\E[?12;25h, dch=\E[%p1%dP, dch1=\E[P, dim=\E[2m,
        dl=\E[%p1%dM, dl1=\E[M, dsl=\E]2;\E\\, ech=\E[%p1%dX,
        ed=\E[J, el=\E[K, el1=\E[1K, flash=\E[?5h$<100/>\E[?5l,
        fsl=^G, home=\E[H, hpa=\E[%i%p1%dG, ht=^I, hts=\EH,
        ich=\E[%p1%d@, il=\E[%p1%dL, il1=\E[L, ind=\n,
        initc=\E]4;%p1%d;rgb\:%p2%{255}%*%{1000}%/%2.2X/%p3%{255}%*%{1000}%/%2.2X/%p4%{255}%*%{1000}%/%2.2X\E\\,
        invis=\E[8m, is2=\E[!p\E[?3;4l\E[4l\E>, kDC=\E[3;2~,
        kEND=\E[1;2F, kHOM=\E[1;2H, kIC=\E[2;2~, kLFT=\E[1;2D,
        kNXT=\E[6;2~, kPRV=\E[5;2~, kRIT=\E[1;2C, kbs=^?,
        kcbt=\E[Z, kcub1=\EOD, kcud1=\EOB, kcuf1=\EOC,
        kcuu1=\EOA, kdch1=\E[3~, kend=\EOF, kent=\EOM, kf1=\EOP,
        kf10=\E[21~, kf11=\E[23~, kf12=\E[24~, kf13=\E[1;2P,
        kf14=\E[1;2Q, kf15=\E[1;2R, kf16=\E[1;2S, kf17=\E[15;2~,
        kf18=\E[17;2~, kf19=\E[18;2~, kf2=\EOQ, kf20=\E[19;2~,
        kf21=\E[20;2~, kf22=\E[21;2~, kf23=\E[23;2~,
        kf24=\E[24;2~, kf25=\E[1;5P, kf26=\E[1;5Q, kf27=\E[1;5R,
        kf28=\E[1;5S, kf29=\E[15;5~, kf3=\EOR, kf30=\E[17;5~,
        kf31=\E[18;5~, kf32=\E[19;5~, kf33=\E[20;5~,
        kf34=\E[21;5~, kf35=\E[23;5~, kf36=\E[24;5~,
        kf37=\E[1;6P, kf38=\E[1;6Q, kf39=\E[1;6R, kf4=\EOS,
        kf40=\E[1;6S, kf41=\E[15;6~, kf42=\E[17;6~,
        kf43=\E[18;6~, kf44=\E[19;6~, kf45=\E[20;6~,
        kf46=\E[21;6~, kf47=\E[23;6~, kf48=\E[24;6~, kf5=\E[15~,
        kf6=\E[17~, kf7=\E[18~, kf8=\E[19~, kf9=\E[20~,
        khome=\EOH, kich1=\E[2~, kmous=\E[M, knp=\E[6~,
        kpp=\E[5~, mc0=\E[i, mc4=\E[4i, mc5=\E[5i, meml=\El,
        memu=\Em, oc=\E]104\E\\, op=\E[39;49m, rc=\E8,
        rep=%p1%c\E[%p2%{1}%-%db, rev=\E[7m, ri=\EM,
        ritm=\E[23m, rmacs=\E(B, rmam=\E[?7l, rmcup=\E[?1049l,
        rmir=\E[4l, rmkx=\E[?1l, rmso=\E[27m, rmul=\E[24m,
        rs1=\Ec,
        rs2=\E[!p\E[?3;4l\E[4l\E>, sc=\E7, setab=\E[%?%p1%{8}%<%t4%p1%d%e%p1%{16}%<%t10%p1%{8}%-%d%e48;5;%p1%d%;m,
        setaf=\E[%?%p1%{8}%<%t3%p1%d%e%p1%{16}%<%t9%p1%{8}%-%d%e38;5;%p1%d%;m,
        sgr=%?%p9%t\E(0%e\E(B%;\E[0%?%p6%t;1%;%?%p5%t;2%;%?%p2%t;4%;%?%p1%p3%|%t;7%;%?%p4%t;5%;%?%p7%t;8%;m,
        sgr0=\E(B\E[m, sitm=\E[3m, smacs=\E(0, smam=\E[?7h,
        smcup=\E[?1049h, smir=\E[4h, smkx=\E[?1h, smso=\E[7m,
        smul=\E[4m, tbc=\E[3g, tsl=\E]2;, u6=\E[%i%d;%dR,
        u7=\E[6n, u8=\E[?%[;0123456789]c, u9=\E[c, vpa=\E[%i%p1%dd,
TERMINFO_EOF
    tic -x /tmp/ghostty.terminfo
    rm /tmp/ghostty.terminfo
    echo "Ghostty terminfo installed successfully"
fi

# ============================================
# Step 2: Hostname and Git Configuration
# ============================================
echo ""
echo "=== Step 2: Hostname and Git Configuration ==="

# Prompt for public URL and set hostname
read -p "Sprite public URL (optional) [$SPRITE_PUBLIC_URL]: " input_url
SPRITE_PUBLIC_URL="${input_url:-$SPRITE_PUBLIC_URL}"

if [ -n "$SPRITE_PUBLIC_URL" ]; then
    # Extract subdomain from URL (e.g., https://my-sprite.fly.dev -> my-sprite)
    SUBDOMAIN=$(echo "$SPRITE_PUBLIC_URL" | sed -E 's|^https?://||' | cut -d'.' -f1)
    if [ -n "$SUBDOMAIN" ]; then
        CURRENT_HOSTNAME=$(hostname)
        if [ "$CURRENT_HOSTNAME" = "$SUBDOMAIN" ]; then
            echo "Hostname already set to: $SUBDOMAIN"
        else
            echo "Setting hostname to: $SUBDOMAIN"
            echo "$SUBDOMAIN" | sudo tee /etc/hostname > /dev/null
            sudo hostname "$SUBDOMAIN"
            # Add to /etc/hosts so sudo can resolve it
            if ! grep -q "127.0.0.1.*$SUBDOMAIN" /etc/hosts 2>/dev/null; then
                echo "127.0.0.1 $SUBDOMAIN" | sudo tee -a /etc/hosts > /dev/null
                echo "  Added $SUBDOMAIN to /etc/hosts"
            fi
            echo "Hostname changed from '$CURRENT_HOSTNAME' to '$SUBDOMAIN'"
        fi
    fi

    # Add to ~/.zshrc for CLI access
    echo "Adding SPRITE_PUBLIC_URL to ~/.zshrc..."
    if grep -q "^export SPRITE_PUBLIC_URL=" ~/.zshrc 2>/dev/null; then
        sed -i "s|^export SPRITE_PUBLIC_URL=.*|export SPRITE_PUBLIC_URL=$SPRITE_PUBLIC_URL|" ~/.zshrc
        echo "  Updated existing SPRITE_PUBLIC_URL in ~/.zshrc"
    else
        echo "" >> ~/.zshrc
        echo "# Sprite public URL" >> ~/.zshrc
        echo "export SPRITE_PUBLIC_URL=$SPRITE_PUBLIC_URL" >> ~/.zshrc
        echo "  Added SPRITE_PUBLIC_URL to ~/.zshrc"
    fi
    # Export for current session
    export SPRITE_PUBLIC_URL
fi

# Git user configuration
CURRENT_GIT_NAME=$(git config --global user.name 2>/dev/null || echo "")
CURRENT_GIT_EMAIL=$(git config --global user.email 2>/dev/null || echo "")

if [ -n "$CURRENT_GIT_NAME" ] && [ -n "$CURRENT_GIT_EMAIL" ]; then
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

# ============================================
# Step 3: Claude CLI Authentication
# ============================================
echo ""
echo "=== Step 3: Claude CLI Authentication ==="

if claude auth status &>/dev/null; then
    echo "Claude CLI already authenticated, skipping..."
else
    echo "Starting Claude CLI authentication..."
    echo "Follow the prompts to authenticate:"
    claude
fi

# ============================================
# Step 4: GitHub CLI Authentication
# ============================================
echo ""
echo "=== Step 4: GitHub CLI Authentication ==="

if gh auth status &>/dev/null; then
    echo "GitHub CLI already authenticated, skipping..."
else
    echo "Starting GitHub CLI authentication..."
    echo "Follow the prompts to authenticate:"
    gh auth login
fi

# ============================================
# Step 5: Fly.io CLI Installation
# ============================================
echo ""
echo "=== Step 5: Fly.io CLI Installation ==="

# Ensure flyctl is in PATH if installed
export FLYCTL_INSTALL="/home/sprite/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"

if command -v flyctl &>/dev/null; then
    echo "flyctl already installed"
else
    echo "Installing flyctl..."
    curl -L https://fly.io/install.sh | sh
fi

# Authenticate Fly.io if not already logged in
if flyctl auth whoami &>/dev/null; then
    echo "Fly.io already authenticated"
else
    echo "Authenticating Fly.io..."
    echo "Follow the prompts to authenticate:"
    flyctl auth login
fi

# ============================================
# Step 6: Sprites CLI Installation
# ============================================
echo ""
echo "=== Step 6: Sprites CLI Installation ==="

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

# Authenticate Sprites CLI and org
if [ -d "$HOME/.sprite" ]; then
    echo "Sprites CLI already authenticated"
else
    echo "Logging in to Sprites CLI..."
    echo "Follow the prompts to authenticate:"
    sprite login
fi

# ============================================
# Step 6.5: Sprite Network (Optional)
# ============================================
echo ""
echo "=== Step 6.5: Sprite Network (Optional) ==="
echo "Sprite Network enables automatic discovery of other sprites in your organization."
echo "It uses a shared Tigris S3 bucket to register and discover sprites."
echo ""

SPRITE_NETWORK_DIR="$HOME/.sprite-network"
SPRITE_NETWORK_CREDS="$SPRITE_NETWORK_DIR/credentials.json"

if [ -f "$SPRITE_NETWORK_CREDS" ]; then
    echo "Sprite network credentials already configured"
else
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
                echo "Enter Tigris bucket credentials:"
                read -p "AWS_ACCESS_KEY_ID: " AWS_ACCESS_KEY_ID
                read -p "AWS_SECRET_ACCESS_KEY: " AWS_SECRET_ACCESS_KEY
                read -p "BUCKET_NAME: " BUCKET_NAME
                read -p "AWS_ENDPOINT_URL_S3 [https://fly.storage.tigris.dev]: " AWS_ENDPOINT_URL_S3
                AWS_ENDPOINT_URL_S3="${AWS_ENDPOINT_URL_S3:-https://fly.storage.tigris.dev}"
                read -p "ORG (Fly.io org name): " FLY_ORG

                mkdir -p "$SPRITE_NETWORK_DIR"
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
                ;;
            *)
                echo "Skipping Sprite Network setup"
                ;;
        esac
    else
        echo "Skipping Sprite Network setup"
    fi
fi

# ============================================
# Step 7: Tailscale Installation
# ============================================
echo ""
echo "=== Step 7: Tailscale Installation ==="

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

# Authenticate Tailscale if not already connected
if tailscale status &>/dev/null; then
    echo "Tailscale already connected"
else
    echo "Authenticating Tailscale..."
    echo "Visit the URL shown to add this sprite to your tailnet:"
    sudo tailscale up
fi

TAILSCALE_IP=$(tailscale ip -4)
echo "Tailscale IP: $TAILSCALE_IP"

# ============================================
# Step 8: ttyd Installation
# ============================================
echo ""
echo "=== Step 8: ttyd Installation ==="

if command -v ttyd &>/dev/null; then
    echo "ttyd already installed"
else
    echo "Installing ttyd..."
    sudo apt-get update
    sudo apt-get install -y ttyd
fi

# Check if ttyd service is running
if sprite_api /v1/services 2>/dev/null | grep -q '"ttyd"'; then
    echo "ttyd service already running"
else
    echo "Starting ttyd service on port $TTYD_PORT..."
    sprite_api -X PUT '/v1/services/ttyd?duration=3s' -d "{
      \"cmd\": \"ttyd\",
      \"args\": [\"-W\", \"-p\", \"$TTYD_PORT\", \"-t\", \"fontSize=28\", \"zsh\"]
    }"
fi

# ============================================
# Step 9: sprite-mobile Setup
# ============================================
echo ""
echo "=== Step 9: sprite-mobile Setup ==="

SPRITE_MOBILE_DIR="$HOME/.sprite-mobile"

if [ -d "$SPRITE_MOBILE_DIR" ]; then
    echo "sprite-mobile already exists, pulling latest..."
    cd "$SPRITE_MOBILE_DIR"
    git pull
else
    echo "Cloning sprite-mobile..."
    gh repo clone "$SPRITE_MOBILE_REPO" "$SPRITE_MOBILE_DIR"
fi

# Install dependencies
echo "Installing sprite-mobile dependencies..."
cd "$SPRITE_MOBILE_DIR"
bun install

# Write SPRITE_PUBLIC_URL to sprite-mobile/.env
if [ -n "$SPRITE_PUBLIC_URL" ]; then
    echo "Writing SPRITE_PUBLIC_URL to sprite-mobile/.env..."
    echo "SPRITE_PUBLIC_URL=$SPRITE_PUBLIC_URL" > "$SPRITE_MOBILE_DIR/.env"
    echo "  Created $SPRITE_MOBILE_DIR/.env"
fi

# Check if sprite-mobile service is running
if sprite_api /v1/services 2>/dev/null | grep -q '"sprite-mobile"'; then
    echo "sprite-mobile service already running"
else
    echo "Starting sprite-mobile service on port $APP_PORT..."
    sprite_api -X PUT '/v1/services/sprite-mobile?duration=3s' -d "{
      \"cmd\": \"bun\",
      \"args\": [\"--hot\", \"run\", \"$SPRITE_MOBILE_DIR/server.ts\"]
    }"
fi

# ============================================
# Step 10: Tailscale Serve (HTTPS for PWA)
# ============================================
echo ""
echo "=== Step 10: Tailscale Serve ==="
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

    # Add to ~/.zshrc for CLI access
    if grep -q "^export TAILSCALE_SERVE_URL=" ~/.zshrc 2>/dev/null; then
        sed -i "s|^export TAILSCALE_SERVE_URL=.*|export TAILSCALE_SERVE_URL=$TAILSCALE_SERVE_URL|" ~/.zshrc
        echo "  Updated TAILSCALE_SERVE_URL in ~/.zshrc"
    else
        echo "" >> ~/.zshrc
        echo "# Tailscale serve URL (HTTPS)" >> ~/.zshrc
        echo "export TAILSCALE_SERVE_URL=$TAILSCALE_SERVE_URL" >> ~/.zshrc
        echo "  Added TAILSCALE_SERVE_URL to ~/.zshrc"
    fi
    # Export for current session
    export TAILSCALE_SERVE_URL

    # Add to sprite-mobile .env
    if [ -f "$SPRITE_MOBILE_DIR/.env" ]; then
        if grep -q "^TAILSCALE_SERVE_URL=" "$SPRITE_MOBILE_DIR/.env"; then
            sed -i "s|^TAILSCALE_SERVE_URL=.*|TAILSCALE_SERVE_URL=$TAILSCALE_SERVE_URL|" "$SPRITE_MOBILE_DIR/.env"
        else
            echo "TAILSCALE_SERVE_URL=$TAILSCALE_SERVE_URL" >> "$SPRITE_MOBILE_DIR/.env"
        fi
    else
        echo "TAILSCALE_SERVE_URL=$TAILSCALE_SERVE_URL" > "$SPRITE_MOBILE_DIR/.env"
    fi
    echo "  Added TAILSCALE_SERVE_URL to $SPRITE_MOBILE_DIR/.env"
else
    TAILSCALE_SERVE_URL=""
    echo "Could not determine Tailscale serve URL (check 'tailscale serve status')"
fi

# ============================================
# Step 11: Tailnet Gate (Public Entry Point)
# ============================================
echo ""
echo "=== Step 11: Tailnet Gate ==="
echo "Public endpoint that redirects to Tailscale URL if on tailnet"

GATE_DIR="$HOME/.tailnet-gate"

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

    if (!tailscaleUrl) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('blocked').style.display = 'block';
    } else {
      fetch(tailscaleUrl + '/api/config', {
        mode: 'cors',
        signal: AbortSignal.timeout(5000)
      })
      .then(r => {
        if (r.ok) window.location.href = tailscaleUrl;
        else throw new Error('not ok');
      })
      .catch(() => {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('blocked').style.display = 'block';
      });
    }
  </script>
</body>
</html>\`;

const server = Bun.serve({
  port: PORT,
  fetch() {
    return new Response(html, {
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

# ============================================
# Step 12: Create CLAUDE.md
# ============================================
echo ""
echo "=== Step 12: CLAUDE.md Setup ==="

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
- `ttyd` (port 8181) - Web terminal interface
CLAUDE_EOF

echo "Created $CLAUDE_MD_PATH"

# ============================================
# Setup Complete
# ============================================
echo ""
echo "============================================"
echo "Setup Complete!"
echo "============================================"
echo ""
echo "Services running:"
echo "  - tailnet-gate (public): Port $WAKEUP_PORT - redirects to Tailscale URL"
echo "  - sprite-mobile:         http://$TAILSCALE_IP:$APP_PORT (Tailscale HTTP)"
echo "  - ttyd (web terminal):   http://$TAILSCALE_IP:$TTYD_PORT (Tailscale HTTP)"
echo ""
if [ -n "$TAILSCALE_SERVE_URL" ]; then
    echo "Tailscale HTTPS (PWA-ready):"
    echo "  - sprite-mobile: $TAILSCALE_SERVE_URL"
    echo ""
fi
if [ -n "$SPRITE_PUBLIC_URL" ]; then
    echo "Public URL: $SPRITE_PUBLIC_URL"
    echo "  - Wakes sprite and redirects to Tailscale URL if on tailnet"
    echo "  - Shows 'Unauthorized' if not on tailnet"
fi
echo ""
echo "To check service status:"
echo "  sprite_api /v1/services"
echo ""
echo "NOTE: Log out and back in for environment variables to be available in new sessions."
echo ""
