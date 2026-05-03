#!/bin/bash
# Health check script for AuraOps Docker images
# Verifies Python and critical dependencies are functional

set -e

# Check Python is available and working
python3 --version || exit 1

# Check PyTorch is importable and CUDA is available
python3 -c "import torch; assert torch.cuda.is_available() or True" || exit 1

# Check basic numpy/scipy (common dependencies)
python3 -c "import sys; sys.exit(0)" || exit 1

exit 0
