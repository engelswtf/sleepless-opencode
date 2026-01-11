#!/bin/bash
set -e

echo ""
echo "sleepless-opencode Installer"
echo "============================"
echo ""

INSTALL_DIR="${SLEEPLESS_INSTALL_DIR:-$HOME/.sleepless-opencode}"

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo "Error: Node.js 18+ required (found: $(node -v))"
        exit 1
    fi
    echo "Found Node.js $(node -v)"
else
    echo "Error: Node.js not found. Please install Node.js 18+"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "Error: npm not found"
    exit 1
fi

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
    git pull origin main 2>/dev/null || true
else
    git clone https://github.com/engelswtf/sleepless-opencode.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo ""
echo "Installing dependencies..."
npm install --silent

echo ""
echo "Building..."
npm run build --silent

echo ""
echo "Installation complete!"
echo ""
echo "-------------------------------------------"
echo ""
echo "Next steps:"
echo ""
echo "1. Run the setup wizard:"
echo "   cd $INSTALL_DIR"
echo "   npm run setup"
echo ""
echo "2. Start the daemon:"
echo "   npm start"
echo ""
echo "3. Or install as a service (Linux):"
echo "   sudo cp sleepless-opencode.service /etc/systemd/system/"
echo "   sudo systemctl enable sleepless-opencode"
echo "   sudo systemctl start sleepless-opencode"
echo ""
