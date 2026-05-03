# Deterministic LangChain 0.1 + PyTorch 2.1 Base Image
# Stage 1: Builder
FROM nvidia/cuda:12.1.1-devel-ubuntu22.04 as builder

LABEL org.opencontainers.image.version="0.1.0"
LABEL org.opencontainers.image.created="2024-04-22"
LABEL org.opencontainers.image.description="Deterministic LangChain 0.1 + PyTorch 2.1 + CUDA 12.1 + Python 3.10.12"
LABEL org.opencontainers.image.vendor="AuraOps"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install build essentials and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    curl \
    g++ \
    gcc \
    git \
    make \
    software-properties-common \
    wget \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
    python3.10 \
    python3.10-dev \
    python3.10-distutils \
    && rm -rf /var/lib/apt/lists/*

# Set Python 3.10 as default
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.10 1 && \
    update-alternatives --install /usr/bin/python python /usr/bin/python3.10 1

# Install pip and upgrade to exact version
RUN curl -sSL https://bootstrap.pypa.io/get-pip.py | python3.10 && \
    python3 -m pip install --upgrade pip==24.0

# Stage 2: Runtime
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04

LABEL org.opencontainers.image.version="0.1.0"
LABEL org.opencontainers.image.created="2024-04-22"
LABEL org.opencontainers.image.description="Deterministic LangChain 0.1 + PyTorch 2.1 + CUDA 12.1 + Python 3.10.12"
LABEL org.opencontainers.image.vendor="AuraOps"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CUDA_HOME=/usr/local/cuda \
    PATH=/usr/local/cuda/bin:$PATH \
    LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    libgomp1 \
    software-properties-common \
    wget \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
    python3.10 \
    python3.10-distutils \
    && rm -rf /var/lib/apt/lists/*

# Set Python 3.10 as default
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.10 1 && \
    update-alternatives --install /usr/bin/python python /usr/bin/python3.10 1

# Copy pip from builder
COPY --from=builder /usr/local/bin/pip* /usr/local/bin/
COPY --from=builder /usr/lib/python3.10/site-packages/pip* /usr/lib/python3.10/site-packages/

# Upgrade pip to exact version
RUN python3 -m pip install --upgrade pip==24.0

# Install pinned base dependencies
RUN pip install \
    pip-tools==7.3.0 \
    wheel==0.42.0 \
    setuptools==69.1.0 \
    packaging==24.0

# Install PyTorch 2.1.0 with CUDA 12.1 support
RUN pip install --no-cache-dir \
    torch==2.1.0 \
    torchvision==0.16.0 \
    torchaudio==2.1.0 \
    --index-url https://download.pytorch.org/whl/cu121

# Install LangChain and related dependencies
RUN pip install --no-cache-dir \
    langchain==0.1.0 \
    langchain-community==0.0.10 \
    pydantic==2.5.0 \
    pydantic-settings==2.1.0 \
    python-dotenv==1.0.0 \
    openai==1.3.6 \
    requests==2.31.0

# Create non-root user
RUN groupadd -r auraops && useradd -r -g auraops auraops

# Set up working directory
WORKDIR /app
RUN chown -R auraops:auraops /app

# Create health check script
RUN mkdir -p /usr/local/bin && \
    chmod 755 /usr/local/bin

COPY health-check.sh /usr/local/bin/health-check.sh
RUN chmod +x /usr/local/bin/health-check.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD /usr/local/bin/health-check.sh

# Switch to non-root user
USER auraops

# Verify installations
RUN python3 --version && \
    python3 -c "import torch; print(f'PyTorch {torch.__version__}')" && \
    python3 -c "import langchain; print(f'LangChain {langchain.__version__}')" && \
    python3 -c "import sys; print(f'Python {sys.version}')"

CMD ["/bin/bash"]
