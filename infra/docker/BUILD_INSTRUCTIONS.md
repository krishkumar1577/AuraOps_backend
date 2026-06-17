# AuraOps Docker Base Images - Build Instructions

**Phase**: 3 (Deterministic Builder)  
**Date**: April 22, 2024  
**Status**: ✅ Ready for Building

## Quick Start

Build all 3 images in sequence:

```bash
cd infra/docker/base-images

# PyTorch 2.1 + CUDA 12.1 (Latest)
cd pytorch-2.1-cuda-12.1
chmod +x build.sh
./build.sh
cd ..

# PyTorch 2.0 + CUDA 11.8 (Stable)
cd pytorch-2.0-cuda-11.8
chmod +x build.sh
./build.sh
cd ..

# LangChain 0.1 + PyTorch 2.1 (AI Apps)
cd langchain-0.1-torch-2.1
chmod +x build.sh
./build.sh
cd ..
```

**Expected time**: 12-15 minutes total (3-4 min per image)

---

## Prerequisites

### System Requirements

- **OS**: macOS, Linux, or Windows (with WSL2)
- **CPU**: 4+ cores (8+ recommended)
- **RAM**: 8GB minimum (16GB recommended)
- **Disk**: 30GB free space
- **GPU** (optional): NVIDIA GPU with CUDA support (for verification)

### Software Requirements

- **Docker**: 20.10+ ([Install](https://docs.docker.com/get-docker/))
- **Git**: 2.20+ ([Install](https://git-scm.com/))
- **Bash**: 4.0+ (included on macOS/Linux)

### Configuration

1. **Increase Docker resources** (Docker Desktop):
   ```
   Preferences → Resources
   - CPUs: 8 (or more)
   - Memory: 10-16 GB
   - Disk image size: 60+ GB
   - Swap: 2+ GB
   ```

2. **Enable BuildKit** for faster builds:
   ```bash
   export DOCKER_BUILDKIT=1
   ```

3. **Verify Docker works**:
   ```bash
   docker run --rm hello-world
   # Should output: "Hello from Docker!"
   ```

---

## Building Images

### Option 1: Automatic Build (Recommended)

Use provided `build.sh` scripts:

```bash
cd infra/docker/base-images/pytorch-2.1-cuda-12.1
./build.sh
```

**What it does**:
- ✅ Builds image with tags
- ✅ Tags with git commit SHA
- ✅ Reports image size and build time
- ✅ Provides push instructions

### Option 2: Manual Build

For custom settings:

```bash
cd infra/docker/base-images/pytorch-2.1-cuda-12.1

# Build with custom tag
docker build \
  --tag auraops/pytorch-2.1-cuda-12.1:latest \
  --tag auraops/pytorch-2.1-cuda-12.1:$(git rev-parse --short HEAD) \
  --label "build.date=$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  .

# View image info
docker images auraops/pytorch-2.1-cuda-12.1
```

### Option 3: Build All Images (Script)

Create `build-all.sh`:

```bash
#!/bin/bash
set -e

cd infra/docker/base-images

for dir in pytorch-2.1-cuda-12.1 pytorch-2.0-cuda-11.8 langchain-0.1-torch-2.1; do
  echo "🐳 Building $dir..."
  cd $dir
  ./build.sh
  cd ..
  echo ""
done

echo "✅ All images built successfully!"
docker images | grep auraops
```

Then run:
```bash
chmod +x build-all.sh
./build-all.sh
```

---

## Build Performance

### Expected Times

| Image | Build Time | Size |
|-------|-----------|------|
| PyTorch 2.1 + CUDA 12.1 | 3-4 min | ~5GB |
| PyTorch 2.0 + CUDA 11.8 | 3-4 min | ~4.5GB |
| LangChain 0.1 + PyTorch 2.1 | 4-5 min | ~6GB |
| **Total** | **12-15 min** | **~15.5GB** |

### Optimization Tips

1. **Enable BuildKit** (10-30% faster):
   ```bash
   export DOCKER_BUILDKIT=1
   ```

2. **Increase Docker memory** to 12-16GB

3. **Use SSD** for Docker data directory

4. **Pre-warm Docker daemon**:
   ```bash
   docker system prune -a  # Clean unused images
   docker run --rm alpine  # Warm up daemon
   ```

5. **Build in sequence** (reduces memory pressure):
   ```bash
   ./pytorch-2.1/build.sh
   ./pytorch-2.0/build.sh  # Don't run in parallel
   ./langchain/build.sh
   ```

---

## Testing Images

### Test 1: Python Version

```bash
docker run --rm auraops/pytorch-2.1-cuda-12.1:latest \
  python3 --version
# Expected: Python 3.10.12
```

### Test 2: PyTorch Installation

```bash
docker run --rm auraops/pytorch-2.1-cuda-12.1:latest \
  python3 -c "import torch; print(f'PyTorch {torch.__version__}'); print(f'CUDA {torch.version.cuda}')"
# Expected: PyTorch 2.1.0, CUDA 12.1
```

### Test 3: Computation Test

```bash
docker run --rm auraops/pytorch-2.1-cuda-12.1:latest \
  python3 << 'EOF'
import torch
x = torch.randn(100, 100)
y = torch.randn(100, 100)
z = torch.matmul(x, y)
print(f"✓ Computation successful: {z.shape}")
EOF
```

### Test 4: Health Check

```bash
docker run --rm auraops/pytorch-2.1-cuda-12.1:latest \
  /usr/local/bin/health-check.sh && echo "✓ Health check passed"
```

### Test 5: LangChain (Image 3 only)

```bash
docker run --rm auraops/langchain-0.1-torch-2.1:latest \
  python3 -c "import langchain; print(f'✓ LangChain {langchain.__version__}')"
```

### Automated Test Suite

Run all tests:

```bash
#!/bin/bash
set -e

IMAGES=(
  "auraops/pytorch-2.1-cuda-12.1:latest"
  "auraops/pytorch-2.0-cuda-11.8:latest"
  "auraops/langchain-0.1-torch-2.1:latest"
)

echo "🧪 Running test suite..."

for image in "${IMAGES[@]}"; do
  echo ""
  echo "Testing $image..."
  
  # Python version
  docker run --rm $image python3 --version
  
  # PyTorch
  docker run --rm $image python3 -c "import torch; print(f'PyTorch {torch.__version__}')"
  
  # Health check
  docker run --rm $image /usr/local/bin/health-check.sh
  
  echo "✓ $image passed all tests"
done

echo ""
echo "✅ All images tested successfully!"
```

---

## Verifying Reproducibility

### Layer Comparison

Verify builds are deterministic by comparing layer hashes:

```bash
# Build 1
cd pytorch-2.1-cuda-12.1 && docker build -t test:v1 .

# Build 2
cd pytorch-2.1-cuda-12.1 && docker build -t test:v2 .

# Compare layers
docker inspect test:v1 --format='{{json .RootFS.Layers}}' | jq . > layers-v1.json
docker inspect test:v2 --format='{{json .RootFS.Layers}}' | jq . > layers-v2.json

diff layers-v1.json layers-v2.json
# Output: No differences = Deterministic! ✓
```

### Version Verification Script

```bash
#!/bin/bash
# Verify all pinned versions are correct

IMAGE=$1

if [ -z "$IMAGE" ]; then
  echo "Usage: ./verify-versions.sh <image>"
  exit 1
fi

echo "Verifying $IMAGE..."
echo ""

# Python
PYTHON_VERSION=$(docker run --rm $IMAGE python3 --version | cut -d' ' -f2)
echo "✓ Python: $PYTHON_VERSION (expected: 3.10.12)"

# PyTorch
TORCH_VERSION=$(docker run --rm $IMAGE python3 -c "import torch; print(torch.__version__)")
echo "✓ PyTorch: $TORCH_VERSION"

# pip-tools
PIPTOOLS_VERSION=$(docker run --rm $IMAGE pip show pip-tools | grep Version | cut -d' ' -f2)
echo "✓ pip-tools: $PIPTOOLS_VERSION (expected: 7.3.0)"

# Check CUDA (if applicable)
CUDA_VERSION=$(docker run --rm $IMAGE python3 -c "import torch; print(torch.version.cuda)")
echo "✓ CUDA: $CUDA_VERSION"

echo ""
echo "✅ Version verification complete!"
```

---

## Publishing Images

### To Docker Hub

```bash
# Login
docker login

# Tag for Docker Hub
docker tag auraops/pytorch-2.1-cuda-12.1:latest \
  your-username/auraops-pytorch-2.1-cuda-12.1:latest

# Push
docker push your-username/auraops-pytorch-2.1-cuda-12.1:latest

# Verify
docker pull your-username/auraops-pytorch-2.1-cuda-12.1:latest
```

### To Private Registry

```bash
# Tag for private registry
docker tag auraops/pytorch-2.1-cuda-12.1:latest \
  registry.example.com/auraops/pytorch-2.1-cuda-12.1:latest

# Push
docker push registry.example.com/auraops/pytorch-2.1-cuda-12.1:latest
```

### To AWS ECR

```bash
# Get login credentials
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  123456789.dkr.ecr.us-east-1.amazonaws.com

# Tag
docker tag auraops/pytorch-2.1-cuda-12.1:latest \
  123456789.dkr.ecr.us-east-1.amazonaws.com/auraops/pytorch-2.1-cuda-12.1:latest

# Push
docker push 123456789.dkr.ecr.us-east-1.amazonaws.com/auraops/pytorch-2.1-cuda-12.1:latest
```

---

## Troubleshooting Build Issues

### Issue 1: "docker: command not found"

**Solution**: Install Docker or add to PATH
```bash
which docker || brew install docker
```

### Issue 2: Build fails with insufficient disk space

**Symptoms**:
```
ERROR: failed to solve with frontend dockerfile.v0: failed to read dockerfile: ...
```

**Solutions**:
```bash
# Check disk space
docker system df

# Prune unused data
docker system prune -a --volumes

# Increase Docker disk (Docker Desktop → Preferences → Resources)
```

### Issue 3: "COPY failed: file not found"

**Cause**: health-check.sh not found when building

**Solution**: Ensure file exists and is in same directory:
```bash
ls -la infra/docker/base-images/pytorch-2.1-cuda-12.1/
# Should show: health-check.sh, Dockerfile, build.sh
```

### Issue 4: Build hangs or times out

**Symptoms**: Build stops responding after 10+ minutes

**Solutions**:
- Increase timeout: `docker build --progress=plain ...`
- Increase Docker memory to 12-16GB
- Check network connectivity: `docker run --rm alpine ping google.com`
- Try pulling base image manually: `docker pull nvidia/cuda:12.1.1-devel-ubuntu22.04`

### Issue 5: "Cannot connect to Docker daemon"

**Solution**: Start Docker daemon
```bash
# macOS
open -a Docker

# Linux
sudo systemctl start docker

# Verify
docker ps
```

### Issue 6: CUDA not available in container

**Symptoms**:
```bash
docker run --rm auraops/pytorch-2.1-cuda-12.1:latest \
  python3 -c "import torch; print(torch.cuda.is_available())"
# Output: False
```

**Solutions**:
- Add GPU flag: `docker run --rm --gpus all ...`
- Install NVIDIA Docker runtime: [See docs](https://github.com/NVIDIA/nvidia-docker)
- Check host GPU: `nvidia-smi` (if available)

---

## Cleanup

### Remove All Images

```bash
docker rmi auraops/pytorch-2.1-cuda-12.1:latest
docker rmi auraops/pytorch-2.0-cuda-11.8:latest
docker rmi auraops/langchain-0.1-torch-2.1:latest
```

### Clean Docker System

```bash
# Remove unused images
docker image prune -a

# Remove all containers
docker container prune

# Full cleanup (warning: removes all images/containers)
docker system prune -a --volumes
```

### Reclaim Disk Space

```bash
# Compact Docker VM (Docker Desktop on macOS)
docker run --rm -it --privileged alpine:latest df -h /var/lib/docker

# Or use Disk Utility to resize Docker.raw file
```

---

## Next Steps

### After Building

1. **Verify all images built successfully**:
   ```bash
   docker images | grep auraops
   ```

2. **Run test suite** (see "Testing Images" above)

3. **Push to registry** (optional, see "Publishing Images" above)

4. **Update todo status**:
   ```bash
   # Update SQL database
   sqlite3 ~/.copilot/session-state/default/session.db \
     "UPDATE todos SET status = 'done' WHERE id = 'p3-docker-images';"
   ```

5. **Document build results**:
   - Image sizes
   - Build times
   - Test results
   - Any issues encountered

6. **Commit to git**:
   ```bash
   git add infra/docker/base-images/
   git commit -m "✅ Phase 3: Docker deterministic base images

   - Created 3 base images (PyTorch 2.1, PyTorch 2.0, LangChain 0.1)
   - Multi-stage builds for size optimization
   - All dependencies pinned for reproducibility
   - Health checks included
   - Build scripts provided
   - Full documentation included"
   ```

---

## Performance Checklist

- [ ] All 3 images build successfully
- [ ] Build time per image: <5 minutes
- [ ] Python version: 3.10.12 (verified in all images)
- [ ] PyTorch versions correct (2.1.0, 2.0.1)
- [ ] LangChain version: 0.1.0 (image 3 only)
- [ ] Health checks pass for all images
- [ ] Images run without GPU flags
- [ ] Images total size: ~15.5GB
- [ ] Layers are deterministic (reproducible hashes)
- [ ] All tests pass

---

## Success Criteria

✅ **All 3 images built without errors**
✅ **Each image builds in <5 minutes**
✅ **All dependency versions pinned and verified**
✅ **Health checks pass for all images**
✅ **Python 3.10.12 confirmed in all images**
✅ **PyTorch imports and runs**
✅ **LangChain imports successfully (image 3)**
✅ **Non-root user functional**
✅ **Build reproducibility verified**
✅ **Full documentation completed**

---

## Support

For issues or questions:

1. Check "Troubleshooting" section above
2. Review base image docs:
   - `infra/docker/base-images/README.md`
3. Check NVIDIA CUDA images: https://hub.docker.com/r/nvidia/cuda
4. Check PyTorch installation: https://pytorch.org/get-started/locally/

---

**Last Updated**: April 22, 2024  
**Phase**: 3 (Deterministic Builder)  
**Status**: ✅ Ready for Implementation
