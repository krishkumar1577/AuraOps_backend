#!/bin/bash
# Build script for PyTorch 2.0 + CUDA 11.8 base image
# Deterministic Docker build with SHA tagging

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
IMAGE_NAME="auraops/pytorch-2.0-cuda-11.8"
BUILD_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

echo "🐳 Building $IMAGE_NAME:latest"
echo "📝 Build time: $BUILD_TIME"

# Build the image
docker build \
    --tag "$IMAGE_NAME:latest" \
    --build-arg "BUILD_TIME=$BUILD_TIME" \
    --label "build.time=$BUILD_TIME" \
    "$SCRIPT_DIR"

echo "✅ Build completed successfully"

# Get short SHA for tagging
cd "$SCRIPT_DIR/../../../.."
SHORT_SHA=$(git rev-parse --short HEAD)
FULL_SHA=$(git rev-parse HEAD)

# Tag with SHA for reproducibility
docker tag "$IMAGE_NAME:latest" "$IMAGE_NAME:$SHORT_SHA"
echo "🏷️  Tagged as $IMAGE_NAME:$SHORT_SHA"

# Optional: Display image info
docker images "$IMAGE_NAME" --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.Created}}"

# Get image size
IMAGE_SIZE=$(docker images "$IMAGE_NAME:latest" --format "{{.Size}}")
echo ""
echo "📊 Image Info:"
echo "  Name: $IMAGE_NAME:latest"
echo "  SHA:  $SHORT_SHA"
echo "  Size: $IMAGE_SIZE"
echo ""
echo "💡 To push to registry, run:"
echo "  docker push $IMAGE_NAME:latest"
echo "  docker push $IMAGE_NAME:$SHORT_SHA"
