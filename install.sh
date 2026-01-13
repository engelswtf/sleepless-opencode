#!/bin/bash
set -e

echo ""
echo "sleepless-opencode Installer"
echo "============================"
echo ""

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo "Error: Node.js 18+ required (found: $(node -v))"
        exit 1
    fi
    echo "[OK] Node.js $(node -v)"
else
    echo "Error: Node.js not found. Please install Node.js 18+"
    echo ""
    echo "Install with:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
fi

# Check npm
if ! command -v npm &> /dev/null; then
    echo "Error: npm not found"
    exit 1
fi
echo "[OK] npm $(npm -v)"

# Check git
if ! command -v git &> /dev/null; then
    echo "Error: git not found. Please install git first."
    echo ""
    echo "Install with:"
    echo "  sudo apt-get install git"
    exit 1
fi
echo "[OK] git $(git --version | cut -d' ' -f3)"

INSTALL_DIR="${SLEEPLESS_INSTALL_DIR:-$HOME/.sleepless-opencode}"

echo ""
echo "Installing to: $INSTALL_DIR"
echo ""

if [ -d "$INSTALL_DIR" ]; then
    read -p "Directory exists. Update? (Y/n): " UPDATE
    if [ "$UPDATE" = "n" ] || [ "$UPDATE" = "N" ]; then
        echo "Aborted."
        exit 0
    fi
    cd "$INSTALL_DIR"
    echo "Pulling latest changes..."
    git pull origin main || {
        echo "Warning: Could not pull updates. Continuing with existing code."
    }
else
    echo "Cloning repository..."
    git clone https://github.com/engelswtf/sleepless-opencode.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo ""
echo "Installing dependencies..."
npm install --loglevel warn

echo ""
echo "Building..."
npm run build

echo ""
echo "============================================"
echo "  Installation complete!"
echo "============================================"
echo ""

# Offer to run setup
read -p "Run setup wizard now? (Y/n): " RUN_SETUP
if [ "$RUN_SETUP" != "n" ] && [ "$RUN_SETUP" != "N" ]; then
    echo ""
    npm run setup
else
    echo ""
    echo "To configure later, run:"
    echo "  cd $INSTALL_DIR"
    echo "  npm run setup"
    echo ""
    echo "Then start the daemon:"
    echo "  npm start"
    echo ""
fi
