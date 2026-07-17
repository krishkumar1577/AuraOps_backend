# AI Agent Context — AuraOps Backend

**One source of truth for AI coding assistants (Copilot / Claude / Cursor / etc.).** Keep this file lean, accurate, and the only AI context file in the repo.

---

## 🎯 Project at a Glance

| Attribute | Value |
|-----------|-------|
| **Name** | AuraOps Backend |
| **Goal** | Deterministic AI agent deployment to GPU in **<30s** (MVP), **<11s** (aspirational) |
| **Stack** | TypeScript (strict) · Node.js · Fastify · MongoDB · Redis · Bull queue · AWS SDK · Modal SDK · Zod · Pino · Commander |
| **Auth** | `@fastify/jwt` + scrypt (MongoDB user repo) |
| **Status** | Production: `https://auraops-backend-s2gw.onrender.com` |

---

## 🏗️ 5-Phase Architecture (all 5 done)

```
Phase 1 ✅ Blueprinting    → src/services/blueprinting/   (parse, detect framework, generate blueprint.json)
Phase 2 ✅ Smart Wt Reg    → src/services/swr/            (Redis cache <1ms, S3 stream, image layer dedupe, Bull jobs)
Phase 3 ✅ Deterministic   → src/services/deterministic/  (pip-compile lockfile + SHA256 env hash)
Phase 4 ✅ Orchestration   → src/services/orchestration/  (Modal default, Azure, AWS; ProviderRegistry ranks by price; Modal→Azure fallback on 429)
Phase 5 ✅ CLI & Polish    → src/cli/                     (init, deploy, status, logs, terminate, fleet)
```

---

## 📁 Source Tree (what to read first)

```
src/
├── index.ts                       # Entry: startServer()
├── app.ts                         # Fastify: JWT hook, helmet/cors/rate-limit, modal CLI detection
├── api/routes/
│   ├── auth.routes.ts             # POST /api/v1/auth/{register,login}  (Loops telemetry)
│   ├── blueprint.routes.ts        # POST /api/v1/blueprint/generate, GET /:id
│   ├── swr.routes.ts              # /api/v1/weights[/{hash,pull,stats}]
│   └── deployment.routes.ts       # /api/v1/deploy, /deployment/:id, /agents, MCP, .well-known/mcp
├── services/
│   ├── blueprinting/              # Phase 1: ManifestParser, FrameworkDetector (+ langGraphDetector), BlueprintGenerator
│   ├── swr/                       # Phase 2: RedisWeightRegistry, S3WeightManager, VolumeMounter, ImageLayerCache (KRI-19)
│   ├── queue/                     # Bull backgroundJobs (3 retries exp-backoff) + queueAutoscaler (KRI-20)
│   ├── deterministic/             # Phase 3: dependencyLocking (pip-compile) + hashVerifier (SHA256)
│   ├── orchestration/             # Phase 4: orchestrator (820 lines), defaultOrchestrator, providers/{modal,azure,aws,lambda,local}Provider, providerRegistry (KRI-21), deployProviderFallback, modalAppDeployer (generates modal_app.py + MCP ASGI stub), healthCheck, deploymentLogStore (Redis list 24h TTL, 5k cap), deployTelemetry (KRI-9), crewParser, warmWorkerPool
│   ├── auth/                      # passwordService (scrypt) + userRepository (Mongo) + jwtService
│   ├── mcp/                       # mcpCardGenerator, mcpEndpointGenerator
│   ├── fleet/                     # (alias of crew parsing)
│   └── telemetry/                 # Loops.so client (async, non-blocking)
├── cli/                           # Phase 5: commander-based init/deploy/status/logs/terminate/fleet
├── plugins/auth.ts                # requireAuth, rateLimitAuth Fastify hooks
├── utils/                         # config (Zod), errors, logger (Pino), dockerDetection
└── types/                         # blueprint.types, orchestration.types
```

Full deep dives: [`docs/architecture/code-map.md`](docs/architecture/code-map.md) · [`docs/cli/cli-code-map.md`](docs/cli/cli-code-map.md)

---

## 🔑 Non-Negotiable Code Standards

### 1. TypeScript strict mode — no `any`
```ts
export class RedisWeightRegistry {
  async lookup(modelHash: string): Promise<CachedWeight | null> {}
}
```

### 2. Custom errors only
```ts
import { DeploymentError, WeightNotFoundError } from '../../utils/errors';
throw new WeightNotFoundError(hash);
```

### 3. Logger with timing — no `console.log`
```ts
import { logger } from '../../utils/logger';
const start = Date.now();
await op();
logger.info(`✓ done in ${Date.now() - start}ms`);
```

### 4. Zod-validate all API input
```ts
const Schema = z.object({ modelHash: z.string().min(1), sizeGB: z.number().positive() });
fastify.post('/x', async (req) => Schema.parse(req.body));
```

### 5. Tests >90% coverage with perf assertions
```ts
it('lookup <1ms', async () => {
  const s = Date.now();
  await redis.lookup(h);
  expect(Date.now() - s).toBeLessThan(1);
});
```

---

## 📊 Performance Targets (asserted in tests)

| Op | Target | Phase |
|---|---|---|
| Manifest parse | <100ms | 1 |
| Framework detect | <50ms | 1 |
| Blueprint gen | <1s | 1 |
| **Redis lookup** | **<1ms** | 2 |
| S3 upload 15GB | <20s | 2 |
| S3 download 15GB | <15s | 2 |
| Dep lock | <2s | 3 |
| Hash verify | <1s | 3 |
| Worker acquire | <1s | 4 |
| **Deploy (MVP)** | **<30s** | 4 |
| **Deploy (aspirational)** | **<11s** | 4 |

---

## 🔄 Key Request Flows

**Deploy (POST /api/v1/deploy)**: JWT auth → SWR cache lookup → `ImageLayerCache` (KRI-19) sha256 dedupe → `Orchestrator.deployPersistentWithFallback` → `ProviderRegistry` (KRI-21) ranks by price → default `ModalProvider.deployPersistent` → `ModalAppDeployer` writes `modal_app.py` (cached/non-cached path) → spawns `modal deploy` CLI (120s) → parses `*.modal.run` URL → `DeploymentRecord` in Redis → `DeploymentLogStore` appends lifecycle → `deployTelemetry` (KRI-9) ships to Loops async. On Modal 429 → fallback to Azure. MCP: if `enableMcp`, mount FastAPI ASGI stub on same URL exposing `/mcp/{health,tools,tools/call}`.

**Auth**: scrypt hash → MongoDB → JWT 7-day. All protected routes gated by `requireAuth` from `plugins/auth.ts`.

**Weight pull (POST /api/v1/weights/pull)**: Bull job (3 retries, exp backoff) → HF/URL → stream S3 → Redis 30-day TTL. `QueueAutoscaler` (KRI-20) adjusts concurrency.

**CLI**: `auraops init|deploy|status|logs|terminate|fleet` — all hit the same 4 endpoints (POST /deploy, GET /deployment/:id, GET /deployment/:id/logs, DELETE /deployment/:id/stop-modal). See `docs/cli/cli-code-map.md` for full breakdown.

---

## 🐛 Known issues to fix when touching

- `src/cli/terminate.ts` reads `AURAOPS_TOKEN` env var; every other command reads `AURAOPS_API_TOKEN` — almost certainly a bug. Auth header is built inline (not via `getAuthHeaders`).
- `.env` (not committed) contains a real MongoDB connection string and real Modal tokens — rotate before public sharing.
- `.gitignore` lists `infra/` as ignored but `infra/` is fully tracked — fix the inconsistency.

---

## 📚 Reference docs (in `docs/`)

- `docs/architecture/code-map.md` — full workflow code map / Mermaid mind map
- `docs/cli/cli-code-map.md` — deep CLI breakdown (16 sections)

---

**Version**: 1.0 · One file only · No other `AGENTS.md` / `CLAUDE.md` / `*_INSTRUCTIONS.md` files in the repo.
