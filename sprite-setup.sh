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
    if [ -f "$HOME/.sprite-mobile/.tailscale-auth-key" ]; then
        tailscale_auth_key=$(cat "$HOME/.sprite-mobile/.tailscale-auth-key")
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
# Load Configuration
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

step_1_ghostty() {
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
}

step_2_hostname() {
    echo ""
    echo "=== Step 2: Hostname and Git Configuration ==="

    # Prompt for public URL and set hostname (skip prompt in non-interactive mode)
    if [ "$NON_INTERACTIVE" != "true" ]; then
        read -p "Sprite public URL (optional) [$SPRITE_PUBLIC_URL]: " input_url
        SPRITE_PUBLIC_URL="${input_url:-$SPRITE_PUBLIC_URL}"
    fi

    # Determine hostname: prefer SPRITE_NAME, then extract from URL
    local target_hostname=""
    if [ -n "$SPRITE_NAME" ]; then
        target_hostname="$SPRITE_NAME"
    elif [ -n "$SPRITE_PUBLIC_URL" ]; then
        # Extract subdomain from URL (e.g., https://my-sprite.fly.dev -> my-sprite)
        target_hostname=$(echo "$SPRITE_PUBLIC_URL" | sed -E 's|^https?://||' | cut -d'.' -f1)
    fi

    if [ -n "$target_hostname" ]; then
        CURRENT_HOSTNAME=$(hostname)
        if [ "$CURRENT_HOSTNAME" = "$target_hostname" ]; then
            echo "Hostname already set to: $target_hostname"
        else
            echo "Setting hostname to: $target_hostname"
            echo "$target_hostname" | sudo tee /etc/hostname > /dev/null
            sudo hostname "$target_hostname"
            # Add to /etc/hosts so sudo can resolve it
            if ! grep -q "127.0.0.1.*$target_hostname" /etc/hosts 2>/dev/null; then
                echo "127.0.0.1 $target_hostname" | sudo tee -a /etc/hosts > /dev/null
                echo "  Added $target_hostname to /etc/hosts"
            fi
            echo "Hostname changed from '$CURRENT_HOSTNAME' to '$target_hostname'"
        fi
    fi

    if [ -n "$SPRITE_PUBLIC_URL" ]; then

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

    if [ "$NON_INTERACTIVE" = "true" ]; then
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

    if claude auth status &>/dev/null; then
        echo "Claude CLI already authenticated, skipping..."
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        if [ -f "$HOME/.claude/.credentials.json" ]; then
            echo "Claude credentials file installed (will be validated on first use)"
        else
            echo "Warning: Claude not authenticated and no credentials provided"
            echo "  Run interactively or provide credentials in config"
        fi
    else
        echo "Starting Claude CLI authentication..."
        echo "Follow the prompts to authenticate:"
        claude
    fi
}

step_4_github() {
    echo ""
    echo "=== Step 4: GitHub CLI Authentication ==="

    if gh auth status &>/dev/null; then
        echo "GitHub CLI already authenticated, skipping..."
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        if [ -f "$HOME/.config/gh/hosts.yml" ]; then
            echo "GitHub credentials file installed (verifying...)"
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
        echo "Starting GitHub CLI authentication..."
        echo "Follow the prompts to authenticate:"
        gh auth login
    fi
}

step_5_flyctl() {
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
            echo "  Run interactively or provide credentials in config"
        fi
    else
        echo "Authenticating Fly.io..."
        echo "Follow the prompts to authenticate:"
        flyctl auth login
    fi
}

step_6_sprites() {
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
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        echo "Warning: Sprites CLI not authenticated"
        echo "  Run interactively to authenticate"
    else
        echo "Logging in to Sprites CLI..."
        echo "Follow the prompts to authenticate:"
        sprite login
    fi
}

step_6_5_network() {
    echo ""
    echo "=== Step 6.5: Sprite Network (Optional) ==="

    SPRITE_NETWORK_DIR="$HOME/.sprite-network"
    SPRITE_NETWORK_CREDS="$SPRITE_NETWORK_DIR/credentials.json"

    if [ -f "$SPRITE_NETWORK_CREDS" ]; then
        echo "Sprite network credentials already configured"
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
}

step_7_tailscale() {
    echo ""
    echo "=== Step 7: Tailscale Installation ==="

    TAILSCALE_AUTH_KEY_FILE="$HOME/.sprite-mobile/.tailscale-auth-key"

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
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        if [ -n "$TAILSCALE_AUTH_KEY" ]; then
            echo "Authenticating Tailscale with auth key..."
            sudo tailscale up --authkey="$TAILSCALE_AUTH_KEY"
        else
            echo "Warning: Tailscale not connected and no auth key provided"
            echo "  Tailscale requires interactive authentication or an auth key"
            echo "  Generate a reusable auth key at: https://login.tailscale.com/admin/settings/keys"
            echo "  Then add it to your config as tailscale.auth_key"
            return
        fi
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
}

step_9_tailscale_serve() {
    echo ""
    echo "=== Step 9: Tailscale Serve ==="
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
        SPRITE_MOBILE_DIR="$HOME/.sprite-mobile"
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
CLAUDE_EOF

    echo "Created $CLAUDE_MD_PATH"
}

show_summary() {
    TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "unknown")
    TAILSCALE_SERVE_URL=$(tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)

    echo ""
    echo "============================================"
    echo "Setup Complete!"
    echo "============================================"
    echo ""
    echo "Services running:"
    echo "  - tailnet-gate (public): Port $WAKEUP_PORT - redirects to Tailscale URL"
    echo "  - sprite-mobile:         http://$TAILSCALE_IP:$APP_PORT (Tailscale HTTP)"
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
}

# ============================================
# Step Registry
# ============================================

STEP_NAMES=(
    "Ghostty terminal fix"
    "Hostname and git config"
    "Claude CLI auth"
    "GitHub CLI auth"
    "Fly.io CLI (flyctl)"
    "Sprites CLI"
    "Sprite Network (optional)"
    "Tailscale"
    "sprite-mobile"
    "Tailscale Serve (HTTPS)"
    "Tailnet Gate"
    "CLAUDE.md"
)

run_step() {
    local step_num="$1"
    case "$step_num" in
        1) step_1_ghostty ;;
        2) step_2_hostname ;;
        3) step_3_claude ;;
        4) step_4_github ;;
        5) step_5_flyctl ;;
        6) step_6_sprites ;;
        6.5) step_6_5_network ;;
        7) step_7_tailscale ;;
        8) step_8_sprite_mobile ;;
        9) step_9_tailscale_serve ;;
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
    echo "   1.   Ghostty terminal fix (backspace issue)"
    echo "   2.   Hostname and git configuration"
    echo "   3.   Claude CLI authentication"
    echo "   4.   GitHub CLI authentication"
    echo "   5.   Fly.io CLI (flyctl) installation"
    echo "   6.   Sprites CLI installation"
    echo "   6.5  Sprite Network (optional)"
    echo "   7.   Tailscale installation"
    echo "   8.   sprite-mobile setup"
    echo "   9.   Tailscale Serve (HTTPS for PWA)"
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
    step_1_ghostty
    step_2_hostname
    step_3_claude
    step_4_github
    step_5_flyctl
    step_6_sprites
    step_6_5_network
    step_7_tailscale
    step_8_sprite_mobile
    step_9_tailscale_serve
    step_10_tailnet_gate
    step_11_claude_md
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
    echo "  $0 --config config.json --name my-sprite --url https://my-sprite.fly.dev all"
    echo ""
    echo "Non-interactive mode:"
    echo "  Use --export on a configured sprite to generate a config file,"
    echo "  then use --config on a new sprite to apply the same configuration."
    echo "  Use --name and --url to set the target sprite's identity."
    echo "  Tailscale requires a reusable auth key for fully automated setup."
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
elif [ "$selection" = "all" ]; then
    run_all_steps
else
    steps=$(parse_step_range "$selection")
    for step in $steps; do
        run_step "$step"
    done
fi
