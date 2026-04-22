# AuraOps Backend MVP

Infrastructure as Invisible Code - Deterministic deployment layer for AI agents.

## 🎯 Project Overview

AuraOps is a backend orchestration layer that eliminates the 60% velocity loss developers experience deploying AI models to production. It guarantees byte-for-byte reproducibility and deploys agents to live GPUs in under 30 seconds (MVP target: <11 seconds).

### Core Components
1. **Blueprinting Engine** - Parse manifests, detect frameworks, generate deterministic specs
2. **Smart Weight Registry** - Global caching of model weights to eliminate 15GB downloads
3. **Deterministic Builder** - Lock environments, guarantee reproducibility
4. **Orchestrator** - Deploy to GPU clouds (Lambda Labs, Together AI, Vast.ai)

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- TypeScript 5+
- npm or yarn

### Installation

```bash
# Navigate to project directory
cd /Users/krish.dev/dev/projects/auraops-backend

# Install dependencies
npm install

# Set up environment
cp .env.example .env

# Build TypeScript
npm run build

# Run development server
npm run dev
```

### Development

```bash
# Start development server with hot reload
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm test:watch

# Type check
npm run type-check

# Lint
npm run lint
```

## 📁 Project Structure

```
auraops-backend/
├── src/
│   ├── services/
│   │   ├── blueprinting/        # Phase 1: Manifest parsing + framework detection
│   │   ├── swr/                 # Phase 2: Weight caching
│   │   ├── deterministic/       # Phase 3: Reproducibility
│   │   ├── orchestration/       # Phase 4: GPU deployment
│   │   └── queue/               # Background jobs
│   ├── api/
│   │   ├── routes/              # API endpoints
│   │   └── middleware/          # Express middleware
│   ├── models/                  # Data models
│   ├── types/                   # TypeScript type definitions
│   ├── utils/                   # Utilities (logger, config, errors)
│   ├── app.ts                   # Fastify app setup
│   └── index.ts                 # Entry point
├── tests/
│   ├── integration/             # Integration tests
│   └── __tests__/               # Unit tests
├── tsconfig.json                # TypeScript config
├── jest.config.js               # Jest config
├── package.json
└── README.md                    # This file
```

## 🏗️ Architecture

### Phase 1: Blueprinting Engine (Weeks 1-2)
Parse Python manifests → Detect framework → Generate immutable blueprint spec

**API Endpoints**:
- `POST /api/v1/blueprint/generate` - Generate blueprint from project
- `GET /api/v1/blueprint/:id` - Get blueprint details (stub)

**Success Criteria**:
- Parse manifest in <100ms
- Framework detection 95%+ accurate
- Blueprint generation <1s total

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- frameworkDetector.test.ts

# Run with coverage
npm test -- --coverage
```

### Test Coverage Targets
- Unit tests: 95%+ coverage
- Integration tests: 100% of critical paths
- E2E tests: Happy path + error scenarios

## 📊 Performance Targets

| Operation | Target | Current |
|-----------|--------|---------|
| Manifest parsing | <100ms | TBD |
| Framework detection | <50ms | TBD |
| Blueprint generation | <1.0s | TBD |
| Redis lookup | <1ms | TBD |
| S3 upload (15GB) | <20s | TBD |
| Deploy pipeline | <30s MVP | TBD |
| Aspirational | <11s | TBD |

## 🔧 Configuration

Create a `.env` file (copy from `.env.example`):

```env
NODE_ENV=development
PORT=3000
MONGODB_URI=mongodb://localhost:27017
REDIS_URL=redis://localhost:6379
AWS_REGION=us-east-1
LAMBDA_LABS_API_KEY=your-api-key
```

## 📚 API Endpoints

### Blueprint Generation
```bash
curl -X POST http://localhost:3000/api/v1/blueprint/generate \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/path/to/project"}'
```

Response:
```json
{
  "success": true,
  "blueprint": {
    "id": "uuid",
    "framework": "pytorch",
    "frameworkVersion": "2.1.0",
    "baseImage": "aura-pytorch-2.1-cuda-12.1",
    "cudaVersion": "12.1",
    "pythonVersion": "3.11",
    "dependencyCount": 42
  },
  "timing": {
    "manifestParse": 45,
    "frameworkDetect": 15,
    "blueprintGenerate": 20,
    "total": 80
  }
}
```

## 🎯 Development Roadmap

**Week 1-2**: Phase 1 (Blueprinting) ✅  
**Week 3-5**: Phase 2 (SWR) ⏳  
**Week 6-7**: Phase 3 (Deterministic) ⏳  
**Week 8-11**: Phase 4 (Orchestrator) ⏳  
**Week 12-13**: Phase 5 (CLI & Polish) ⏳  

## 🚀 Next Steps

1. ✅ Project initialized
2. ✅ Phase 1 core services built
3. ⏳ Unit tests (all services)
4. ⏳ API integration tests
5. ⏳ CLI implementation
6. ⏳ Docker base images
7. ⏳ Phase 2-5 implementation

---

**Status**: Phase 1 MVP (Core services implemented)  
**Last Updated**: 2024-04-20
