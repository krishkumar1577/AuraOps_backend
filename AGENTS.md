# 🤖 AuraOps Backend - GitHub Copilot Instructions (MASTER)

**AUTO-DETECTED**: GitHub Copilot automatically reads this file for code generation rules.

---

## 📋 HOW COPILOT USES THIS FILE

1. **Auto-Detection**: Copilot reads `.github/copilot-instructions.md` automatically
2. **Every Prompt**: These standards apply to ALL code generation in this project
3. **Reference**: All generated code MUST follow these standards
4. **Context**: Used to understand architecture and maintain consistency

---

## 🎯 PROJECT AT A GLANCE

| Attribute | Value |
|-----------|-------|
| **Project Name** | AuraOps Backend MVP |
| **Goal** | Deterministic AI agent deployment in <30s (MVP), <11s (aspirational) |
| **Language** | TypeScript (strict mode MANDATORY) |
| **Current Phase** | Phase 1 ✅ COMPLETE (7/7 tests passing) |
| **Next Phase** | Phase 2: Smart Weight Registry (Weeks 3-5) |
| **Timeline** | 13 weeks total (5 sequential phases) |
| **Testing** | Jest with >90% coverage required |
| **Status** | Ready for Phase 2 implementation |

---

## 🏗️ 5-PHASE ARCHITECTURE

```
Phase 1 ✅         Phase 2 ⏳         Phase 3 ⏳         Phase 4 ⏳         Phase 5 ⏳
Blueprinting       Weight Cache      Deterministic     Orchestration     CLI & Polish
(Weeks 1-2)        (Weeks 3-5)       (Weeks 6-7)       (Weeks 8-11)      (Weeks 12-13)
✅ COMPLETE        NEXT              PLANNED           PLANNED           PLANNED

Deliverable:       Deliverable:      Deliverable:      Deliverable:      Deliverable:
Blueprint JSON     Cached Weights    Locked Envs       GPU Deploy        CLI Commands
```

### How Phases Connect

```
User Project
    ↓
Phase 1: Parse & Detect frameworks → Blueprint JSON ✅
    ↓
Phase 2: Cache model weights → Fast model availability ⏳
    ↓
Phase 3: Lock dependencies → Guarantee reproducibility ⏳
    ↓
Phase 4: Deploy to live GPU → Running agent ⏳
    ↓
Phase 5: CLI interface → User experience ⏳
```

---

## 🔑 NON-NEGOTIABLE CODE STANDARDS

### 1. TypeScript Strict Mode (MANDATORY)

```typescript
// ✅ REQUIRED: Strict types everywhere
export class RedisWeightRegistry {
  async lookup(modelHash: string): Promise<CachedWeight | null> { }
  async register(weight: CachedWeight): Promise<void> { }
  constructor(client: RedisClient) { }
}

// ❌ FORBIDDEN: Any types
async function process(data: any): Promise<any> { }  // NEVER!
const result = await api.call();                    // NO! Must have return type
function handle(x) { return x; }                    // NO! Must type parameters
```

### 2. Error Handling (MANDATORY)

```typescript
// ✅ USE CUSTOM ERRORS
import { DeploymentError, WeightNotFoundError } from '../../utils/errors';

try {
  const weight = await registry.lookup(hash);
  if (!weight) throw new WeightNotFoundError(hash);
} catch (error) {
  throw new DeploymentError('Lookup failed', { cause: error });
}

// ❌ NEVER
throw new Error('Failed');        // FORBIDDEN
console.error('Error:', error);   // FORBIDDEN
```

### 3. Logging (MANDATORY)

```typescript
// ✅ USE LOGGER WITH TIMING
import { logger } from '../../utils/logger';

const start = Date.now();
const result = await operation();
logger.info(`✓ Operation complete in ${Date.now() - start}ms`);

// ❌ NEVER
console.log('Done');      // FORBIDDEN
console.error('Error');   // FORBIDDEN
```

### 4. Testing (MANDATORY - >90% coverage)

```typescript
// ✅ COMPREHENSIVE TESTS
describe('ServiceName', () => {
  it('should handle happy path', () => {
    expect(await service.method()).toBeDefined();
  });

  it('should handle error case', () => {
    expect(() => service.invalid()).toThrow();
  });

  it('should meet performance target', () => {
    const start = Date.now();
    await service.lookup();
    expect(Date.now() - start).toBeLessThan(1);  // <1ms target
  });
});

// ❌ NEVER
// - Minimal tests
// - No error testing
// - No performance assertions
// - Coverage <90%
```

### 5. API Validation (MANDATORY)

```typescript
// ✅ VALIDATE ALL INPUTS
import { z } from 'zod';

const WeightSchema = z.object({
  modelHash: z.string().min(1),
  sizeGB: z.number().positive(),
  storagePath: z.string().url(),
});

fastify.post('/weights', async (request) => {
  const validated = WeightSchema.parse(request.body);
  // Use validated...
});

// ❌ NEVER
const { modelHash } = request.body;  // No validation
if (!modelHash) throw new Error();     // Generic error
```

---

## 📊 PERFORMANCE TARGETS (MEASURE & VERIFY)

| Operation | Target | Phase | How to Test |
|-----------|--------|-------|------------|
| Manifest parsing | <100ms | 1 ✅ | Add timing assertion in tests |
| Framework detection | <50ms | 1 ✅ | Measure in tests |
| Blueprint generation | <1s | 1 ✅ | Profile output |
| **Redis lookup** | **<1ms** | **2 ⏳** | **CRITICAL: Verify in tests** |
| **S3 upload 15GB** | **<20s** | **2 ⏳** | **Integration test** |
| **S3 download 15GB** | **<15s** | **2 ⏳** | **Integration test** |
| Dependency locking | <2s | 3 | Time execution |
| Hash verification | <1s | 3 | Benchmark |
| Worker acquisition | <1s | 4 | Measure |
| Deploy total (MVP) | <30s | 4 | End-to-end test |
| Deploy (aspirational) | <11s | 4 | Optimize |

**TEST PERFORMANCE**:
```typescript
it('should lookup weight in <1ms', async () => {
  const start = Date.now();
  const weight = await redis.lookup(hash);
  expect(Date.now() - start).toBeLessThan(1);  // MUST BE <1ms!
});
```

---

## 📁 PHASE 1: BLUEPRINTING ENGINE ✅ (COMPLETE)

### Completed Services

**Location**: `src/services/blueprinting/`

| File | Purpose | Status | Tests |
|------|---------|--------|-------|
| `manifestParser.ts` | Parse requirements.txt, pyproject.toml | ✅ Complete | ✅ Pass |
| `frameworkDetector.ts` | Detect PyTorch, LangChain, JAX, Transformers | ✅ Complete | ✅ 7/7 pass |
| `blueprintGenerator.ts` | Generate immutable blueprint JSON specs | ✅ Complete | ✅ Pass |
| `index.ts` | Service exports | ✅ Complete | ✅ Pass |

**API Routes**: `src/api/routes/blueprint.routes.ts`
- POST `/api/v1/blueprint/generate` - Generate blueprint from manifest
- GET `/api/v1/blueprint/:id` - Get blueprint details

**Verify Phase 1**:
```bash
npm test -- frameworkDetector.test.ts  # ✅ 7/7 tests passing
npm run build                           # ✅ No errors
npm run type-check                      # ✅ Strict TypeScript
```

---

## 📁 PHASE 2: SMART WEIGHT REGISTRY ⏳ (IMPLEMENT NEXT)

**Timeline**: 3 weeks (Days 15-35)  
**Purpose**: Cache weights globally to enable <30s total deploy time

### Services to Build (6 files)

**1. RedisWeightRegistry** - `src/services/swr/redisClient.ts`

Methods:
- `lookup(modelHash): Promise<CachedWeight | null>` - Returns weight in <1ms ⚡
- `register(weight): Promise<void>` - Store with 30-day TTL
- `stats(): Promise<{totalWeights, totalSizeGB, cacheHitRate}>` - Cache metrics
- `evictLRU(maxSizeGB): Promise<void>` - Remove least-used weights

**Performance Target**: <1ms lookup (MANDATORY)

---

**2. S3WeightManager** - `src/services/swr/s3Manager.ts`

Methods:
- `upload(localPath, modelName, hash): Promise<{path, size}>` - Stream upload
- `download(s3Path, localPath): Promise<void>` - Stream download
- `exists(s3Path): Promise<boolean>` - Check existence

**Performance Targets**: 
- Upload 15GB in <20s (MANDATORY)
- Download 15GB in <15s (MANDATORY)

---

**3. VolumeMounter** - `src/services/swr/volumeMounter.ts`

Methods:
- `generateDockerMounts(weights): string` - Docker -v flags
- `generateK8sMounts(weights): any[]` - Kubernetes spec

---

**4. BackgroundJobQueue** - `src/services/queue/backgroundJobs.ts`

Methods:
- `queueWeightPull(modelName, hash, source): Promise<void>` - Queue job (non-blocking)

Features:
- Bull queue on Redis
- 3 retries with exponential backoff
- Download from HuggingFace or custom URL
- Upload to S3 + register in Redis

---

**5. SWR API Routes** - `src/api/routes/swr.routes.ts`

Endpoints:
- GET `/api/v1/weights` - List all cached weights
- GET `/api/v1/weights/:hash` - Get weight details
- POST `/api/v1/weights/pull` - Queue background pull
- GET `/api/v1/weights/stats` - Cache statistics

---

**6. Integration Tests** - `tests/integration/swr.integration.test.ts`

Coverage: >90%  
Scope: Full workflow tests (cache → S3 → queue)

---

## 📁 PHASE 3: DETERMINISTIC BUILDER ⏳ (PLANNED)

**Timeline**: 2 weeks (Days 36-49)  
**Purpose**: Lock dependencies and guarantee reproducibility

### Components

**Location**: `src/services/deterministic/`
- `dependencyLocking.ts` - pip-compile integration
- `hashVerifier.ts` - SHA256 environment hashing

**Location**: `infra/docker/base-images/`
- PyTorch 2.1 + CUDA 12.1
- PyTorch 2.0 + CUDA 11.8
- LangChain 0.1 + Torch 2.1
- (+ 2-5 more framework variants)

---

## 📁 PHASE 4: ORCHESTRATOR ⏳ (PLANNED)

**Timeline**: 4 weeks (Days 50-77)  
**Purpose**: Deploy agents to live GPUs in <30s (MVP), <11s (aspirational)

### Components

**Location**: `src/services/orchestration/`
- `lambdaLabsAdapter.ts` - GPU provider API integration
- `warmWorkerPool.ts` - Worker pool management
- `healthCheck.ts` - Agent health verification
- `deploymentExecutor.ts` - Full deployment pipeline

**Location**: `src/api/routes/`
- `deployment.routes.ts` - Deploy REST endpoints

---

## 📁 PHASE 5: CLI & POLISH ⏳ (PLANNED)

**Timeline**: 2 weeks (Days 78-91)  
**Purpose**: CLI interface and final polish

### Components

**Location**: `src/cli/`
- `init.ts` - `auraops init` command
- `deploy.ts` - `auraops deploy` command
- `status.ts` - `auraops status` command
- `logs.ts` - `auraops logs` command

---

## 🤖 HOW TO PROMPT COPILOT (Templates)

### Template 1: Implement Service

```
Based on .github/copilot/PLANNING.md lines [X-Y], implement [SERVICE_NAME]
in [FILE_PATH]

Requirements from plan:
- Methods: [list all methods]
- Performance target: [target with unit]
- Error handling: Use custom errors from src/utils/errors.ts
- Logging: Use logger from src/utils/logger.ts with timing
- Testing: >90% coverage in __tests__/[file].test.ts
- TypeScript: Strict mode, NO 'any' types, all parameters typed

Use src/services/blueprinting/frameworkDetector.ts as reference for code style.
Follow all CODE STANDARDS in this file (.github/copilot-instructions.md).
```

### Template 2: Generate Tests

```
Generate comprehensive Jest tests for [SERVICE_NAME] in [TEST_FILE_PATH]

Test coverage:
- Happy path: All methods working correctly
- Error cases: Connection failures, invalid input
- Performance: [service performance target] with timing assertions
- Edge cases: Boundary conditions

Target: >90% code coverage
Use Jest fixtures from tests/fixtures/
```

### Template 3: Validate Existing Code

```
Check if [FILE_PATH] follows ALL code standards from .github/copilot-instructions.md:
- TypeScript strict mode (no 'any' types)
- Custom error handling from src/utils/errors.ts
- Structured logging with timing
- >90% test coverage
- Performance target assertions

If any issues found, provide specific fixes.
```

---

## ✅ TASK COMPLETION WORKFLOW

After implementing each service file:

### 1. Run Tests
```bash
npm test -- src/services/[module]/__tests__/[file].test.ts
# Verify: All tests pass, >90% coverage
```

### 2. Type Check
```bash
npm run type-check
# Verify: Zero TypeScript errors, strict mode
```

### 3. Lint
```bash
npm run lint -- src/services/[module]/[file].ts
# Verify: Code quality, no style issues
```

### 4. Build
```bash
npm run build
# Verify: Compilation succeeds
```

### 5. Full Validation
```bash
npm run type-check && npm run lint && npm test && npm run build
# Verify: Everything passes
```

### 6. Update Progress
- Edit `.github/copilot/PROGRESS.md`
- Find service name
- Change `⏳ TODO` to `✅ COMPLETE`
- Add timestamp
- Add test coverage %

### 7. Commit
```bash
git add .
git commit -m "✅ [ServiceName] - Phase [X] complete

- Implemented: [list of methods]
- Performance: [achieved metrics]
- Tests: [#] passing, [%] coverage
- Files: [files changed]"
```

---

## 📖 DOCUMENTATION REFERENCE

**For detailed Phase 2 specifications**: See `.github/copilot/PLANNING.md`
- Exact method signatures with types
- Detailed requirements per service
- Line-numbered references

**For daily tasks**: See `.github/copilot/auraops_execution_checklist.md`
- 100-day breakdown
- Daily deliverables
- Success criteria per day

**For quick reference**: See `.github/copilot/auraops_quick_reference.md`
- 1-sentence summaries
- Performance targets
- Success metrics

**For navigation**: See `.github/copilot/FILE_MAPPING.md`
- Cross-references between all documents
- Where to find each topic
- 80+ reference points

**For full context**: See `.github/copilot/COMPLETE_UNDERSTANDING.md`
- Complete project analysis
- How everything connects
- First-day reading

**For Codex CLI usage**: See `.github/copilot/CLAUDE_CLI_REFERENCE.md`
- Command examples
- Daily workflow template
- Troubleshooting guide

**For action plan**: See `.github/copilot/ACTION_PLAN.md`
- 24-hour to 3-week plan
- Daily routine & checklist
- Success metrics per week

---

## 🎯 SUCCESS CRITERIA

### Phase 1 ✅ (ACHIEVED)
- ✅ Manifest parsing <100ms
- ✅ Framework detection 95%+ accurate
- ✅ Blueprint generation <1s
- ✅ 7/7 tests passing
- ✅ Zero TypeScript errors

### Phase 2 (NEXT - MUST HIT)
- ⏳ Redis lookup <1ms
- ⏳ S3 upload 15GB <20s
- ⏳ S3 download 15GB <15s
- ⏳ All 6 files implemented
- ⏳ >90% test coverage
- ⏳ Zero TypeScript errors
- ⏳ All tests passing
- ⏳ npm run build succeeds

### Final MVP (Phase 5)
- Deploy to GPU <30s (MVP target)
- Deploy to GPU <11s (aspirational)
- 98%+ deployment success
- Zero manual configuration
- Full CLI interface

---

## 🚀 READY TO BUILD

**Current Status**: Phase 1 ✅ COMPLETE  
**Next**: Phase 2 implementation using Codex CLI  
**Timeline**: 3 weeks to Phase 2 complete  
**Reference**: Use this file + PLANNING.md for all implementation

**Start**: Use CLAUDE_CLI_REFERENCE.md to invoke Codex CLI for Phase 2

---

**Last Updated**: April 22, 2024  
**Version**: 2.0 (MERGED & DEDUPLICATED)  
**Status**: Ready for Phase 2 implementation with Codex CLI  
**Auto-Detected**: YES - Copilot reads this automatically
