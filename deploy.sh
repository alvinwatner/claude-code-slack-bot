#!/bin/bash
# Deployment script for Claude Code Slack Bot
# Run this on the VPS after cloning the repo

set -e

echo "🚀 Setting up Claude Code Slack Bot..."

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
echo "📦 Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally
echo "📦 Installing PM2..."
sudo npm install -g pm2

# Install project dependencies
echo "📦 Installing project dependencies..."
npm install

# Build the project
echo "🔨 Building project..."
npm run build

# Create logs directory
mkdir -p logs

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Create .env file: nano .env"
echo "2. Start the bot: pm2 start ecosystem.config.js"
echo "3. Save PM2 config: pm2 save"
echo "4. Enable startup: pm2 startup"
