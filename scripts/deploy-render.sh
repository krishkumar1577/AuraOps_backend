#!/usr/bin/env bash
# Deploy / redeploy AuraOps backend on Render via CLI.
# Prerequisites: brew install render && render login
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Validating render.yaml"
render blueprints validate render.yaml

echo ""
echo "==> Current services (if any)"
render services list 2>/dev/null || true

echo ""
echo "============================================================"
echo " First-time deploy (Blueprint)"
echo "============================================================"
echo " The CLI cannot fully create a Blueprint non-interactively."
echo " Open Render and apply this repo's render.yaml once:"
echo ""
echo "   https://dashboard.render.com/select-repo?type=blueprint"
echo ""
echo " 1. Select GitHub repo: AuraOps_backend"
echo " 2. Confirm blueprint services (auraops-backend)"
echo " 3. Set secrets in Dashboard → Environment:"
echo "      MONGODB_URI, REDIS_URL, MODAL_TOKEN_ID, MODAL_TOKEN_SECRET"
echo "      API_URL = https://<your-service>.onrender.com"
echo " 4. Wait for first deploy to finish"
echo ""
echo "============================================================"
echo " Redeploy existing service (CLI)"
echo "============================================================"
echo " After the service exists:"
echo ""
echo "   render deploys create --wait"
echo ""
echo " Or pick service interactively:"
echo "   render deploys create"
echo ""

if render whoami &>/dev/null; then
  echo "==> You are logged in. Starting interactive redeploy..."
  render deploys create --wait || render deploys create
else
  echo "==> Not logged in. Run:"
  echo "   render login"
  echo "   ./scripts/deploy-render.sh"
fi
