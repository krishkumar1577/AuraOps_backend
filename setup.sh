#!/bin/bash

# AuraOps Backend Setup Script for macOS
# This script initializes the AuraOps backend project

set -e

PROJECT_DIR="/Users/krish.dev/dev/projects/auraops-backend"

echo "🚀 AuraOps Backend MVP - Setup"
echo "================================"
echo ""

if [ ! -d "$PROJECT_DIR" ]; then
  echo "❌ Project directory not found at $PROJECT_DIR"
  exit 1
fi

cd "$PROJECT_DIR"

echo "📦 Installing npm dependencies..."
npm install

echo ""
echo "🏗️ Building TypeScript..."
npm run build

echo ""
echo "✅ Setup Complete!"
echo ""
echo "To run the development server:"
echo "  cd $PROJECT_DIR"
echo "  npm run dev"
echo ""
echo "To run tests:"
echo "  npm test"
echo ""
echo "Server will be available at: http://localhost:3000"
