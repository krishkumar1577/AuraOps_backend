FROM node:22-slim

# Install Python and pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install Modal CLI globally
RUN pip3 install modal --break-system-packages

# Verify modal is on PATH
RUN modal --version

WORKDIR /app

# Install ALL dependencies (including dev for build)
COPY package*.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Start server
CMD ["node", "dist/index.js"]
