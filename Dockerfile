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

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built source
COPY dist/ ./dist/

# Start server
CMD ["node", "dist/index.js"]
