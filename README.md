# AuraOps Backend

Deterministic deployment layer for AI agents. Parse a Python project, detect its ML framework, and deploy to GPU infrastructure.

## What It Does

**Works standalone (no external services):**

- **`auraops init`** — Point at a Python project directory. Parses `requirements.txt` or `pyproject.toml`, detects the ML framework (PyTorch, LangChain, JAX, Transformers, TensorFlow), infers CUDA version, and generates an immutable `blueprint.json` with checksums.
- **Blueprint generation** — Selects base Docker image, estimates GPU memory, creates SHA256 hashes for reproducibility.
- **Volume mount config** — Generates Docker `-v` flags and Kubernetes `volumeMounts` specs from cached weight locations.
- **Dependency locking** — Wraps `pip-compile` to create lockfiles with hashes for byte-for-byte reproducibility.
- **Environment fingerprinting** — SHA256 hash of Python version + all dependencies for drift detection.

**Works with external services (Redis, S3, GPU cloud):**

- **Redis weight cache** — Sub-millisecond lookup of cached model weights, 30-day TTL, LRU eviction.
- **S3 weight storage** — Stream upload/download of large model files via AWS SDK.
- **Background job queue** — Bull queue on Redis for async weight pulls from HuggingFace or custom URLs.
- **GPU providers** — Real API integrations for Lambda Labs, AWS EC2 (g4dn/p3/p4d), and local Docker.
- **Health checks** — HTTP liveness/readiness probes with retry + exponential backoff.
- **REST API** — Fastify server with deploy, status, terminate, and list endpoints.

**Not yet production-ready:**

- Orchestrator GPU utilization is hardcoded (not reading real metrics).
- Deployment records are in-memory (not persisted to Redis/DB).
- `auraops logs` endpoint is not implemented server-side.
- No real end-to-end deployment has been tested against live GPU infrastructure.

## Quick Start

```bash
npm install
npm run build
npm test

# Start the API server
npm run dev

# Initialize a project
npx auraops init ./my-ml-project

# Deploy (requires server running + external services)
npx auraops deploy --blueprint .auraops/blueprint.json

# Check status
npx auraops status <deployment-id>

# View logs
npx auraops logs <deployment-id> --follow
```

## CLI Commands

| Command | What it does |
|---------|-------------|
| `auraops init [path]` | Parse manifest, detect framework, generate `.auraops/blueprint.json` |
| `auraops deploy` | Send blueprint to API, deploy agent to GPU |
| `auraops status <id>` | Query deployment status, uptime, GPU utilization |
| `auraops logs <id>` | View deployment logs (`--follow` for streaming) |

## API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/v1/blueprint/generate` | Generate blueprint from manifest |
| GET | `/api/v1/blueprint/:id` | Get blueprint details |
| POST | `/api/v1/deploy` | Deploy agent to GPU |
| GET | `/api/v1/deployment/:id` | Deployment status |
| DELETE | `/api/v1/deployment/:id` | Terminate deployment |
| GET | `/api/v1/agents` | List running agents |
| GET | `/api/v1/weights` | List cached weights |
| GET | `/api/v1/weights/:hash` | Weight details |
| POST | `/api/v1/weights/pull` | Queue weight download |
| GET | `/api/v1/weights/stats` | Cache statistics |

## Project Structure

```
src/
├── cli/                    # CLI commands (init, deploy, status, logs)
├── api/routes/             # Fastify REST API routes
├── services/
│   ├── blueprinting/       # Manifest parsing, framework detection, blueprint generation
│   ├── swr/                # Redis cache, S3 storage, volume mounting
│   ├── deterministic/      # Dependency locking, hash verification
│   ├── orchestration/      # GPU orchestrator, providers, health checks
│   └── queue/              # Background job queue (Bull)
├── types/                  # TypeScript interfaces
└── utils/                  # Logger, errors, config
```

## Requirements

- Node.js 18+
- TypeScript 5+ (strict mode)
- Redis (for weight cache + job queue)
- AWS credentials (for S3 + EC2)
- Lambda Labs API key (optional GPU provider)

## Development

```bash
npm run dev          # Start dev server
npm test             # Run tests
npm run type-check   # TypeScript strict mode check
npm run build        # Compile to dist/
npm run lint         # ESLint
```

## Tech Stack

- **Runtime**: Node.js + TypeScript (strict mode, zero `any` types)
- **API**: Fastify
- **Cache**: Redis
- **Storage**: AWS S3
- **Queue**: Bull (Redis-backed)
- **GPU Providers**: Lambda Labs API, AWS EC2, Docker (local)
- **Validation**: Zod
- **Testing**: Jest
- **Logging**: Pino
