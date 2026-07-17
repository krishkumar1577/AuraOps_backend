# AuraOps CLI — Deep Code Map

**Entry point:** `src/cli/index.ts` (25 lines) — Commander program `auraops` v0.1.0.
**Source files (973 lines total):** `index.ts` · `init.ts` · `deploy.ts` · `status.ts` · `logs.ts` · `terminate.ts` · `fleet.ts` · `localGpuCheck.ts` · `utils.ts`.
**Shared helper:** `utils.ts` — colour-coded stdout/stderr, formatters, auth header resolver, default API URL, error handler.
**Auth env:** `AURAOPS_API_TOKEN` (or `--token <jwt>`) → `Authorization: Bearer <token>`.
**Default API URL:** `https://auraops-backend-s2gw.onrender.com` (overridable via `AURAOPS_API_URL`).

---

## 1. Command Tree (Commander surface)

```
auraops (v0.1.0)
├── init          [path]                                   Initialize AuraOps for a project
│     └ -o, --output <dir>                                Output dir for blueprint.json (default: <project>/.auraops)
│
├── deploy                                                  Deploy AI agent to GPU
│     ├ -b, --blueprint <path>                             blueprint.json (default: .auraops/blueprint.json)
│     ├ -p, --provider <name>                              auto | modal | azure | aws       (default: auto)
│     ├ -g, --gpu   <type>                                 a100 | h100 | rtx4090
│     ├ --gpus      <count>                                1–8                              (parsed → parseGpuCount)
│     ├ --token     <jwt>                                  (or AURAOPS_API_TOKEN env)
│     ├ --fleet     <path>                                 crew.yaml → multi-agent deploy
│     └ --mcp                                               Auto-generate MCP server endpoint
│
├── status        <deploymentId>                           Check deployment status
│     └ --token <jwt>
│
├── logs          <deploymentId>                           View deployment logs
│     ├ -f, --follow                                        Follow log output (2s poll)
│     ├ -t, --tail   <lines>                                Number of lines from end
│     └ --token  <jwt>
│
├── terminate     <deploymentId>                           Stop deployment, free GPU
│     └ --force                                            Skip confirmation prompt
│
├── fleet         <crew-file>                              Deploy multi-agent crew from crew.yaml
│     ├ --token <jwt>
│     └ --gpus  <count>                                     1–8 (per agent)
│
└── (external: check-local-gpu run via `node dist/cli/localGpuCheck.js`)
```

`deploy --fleet <path>` is an alias branch that delegates to `runFleetDeploy()` from `fleet.ts`.

---

## 2. Mermaid — Full CLI Mind Map

```mermaid
mindmap
  root((auraops CLI v0.1.0))
    Entry
      src/cli/index.ts
        program = new Command
        addCommand init
        addCommand deploy
        addCommand status
        addCommand logs
        addCommand terminate
        addCommand fleet
        program.parse
    utils.ts
      COLORS reset bold dim red green yellow blue cyan white
      success check green
      fail cross red
      info i cyan
      warn triangle yellow
      step check dim timing
      header bold cyan
      label dim key value
      blank newline
      formatMs ms to s
      formatBytes B KB MB GB
      formatUptime s m h
      getAuthHeaders AURAOPS_API_TOKEN
        warn if missing
        return Bearer
      resolveApiUrl env AURAOPS_API_URL
        default https render
      handleError AuraOpsError
        fail details cause
        process exit 1
    init
      argument path default
      option o output dir
      runInit
        ui header AuraOps Init
        fs access resolvedPath
        ManifestParser parse
        LangGraphDetector analyze
        FrameworkDetector detect
        BlueprintGenerator generate
        fs mkdir outputDir
        fs writeFile blueprint json pretty 2
        ui summary framework python cuda baseImage gpuMemory gpuTier stateSize useCase
    deploy
      option b blueprint
      option p provider auto modal azure aws
      option g gpu type
      option gpus 1 to 8
      option token jwt
      option fleet path
      option mcp
      parseGpuCount validation 1 to 8
      runDeploy
        loadBlueprint fs readFile JSON parse
        resolveProjectRoot dirname .auraops
        fileExists requirements.lock else requirements.txt
        resolveApiUrl getAuthHeaders
        build deployPayload
          blueprintId blueprintJson lockfilePath environmentHash gpuRequirements gpuCount enableMcp provider auto
        axios POST /api/v1/deploy timeout 60s
        poll status 10x 3s
          GET /api/v1/deployment id
        ui deploy summary endpoint curl MCP
      runFleetDeploy
        CrewParser parse crew yaml
        for each agent
          loadBlueprint resolveBlueprintPath
          resolveProjectRoot lockfile
          axios POST /api/v1/deploy
          ui step agent deployed
        ui fleet summary
    status
      argument deploymentId
      option token jwt
      runStatus
        axios GET /api/v1/deployment id timeout 10s
        ui label deployment status agentId workerId
        endpointUrl appName startTime uptime
        gpuUtilization latency
        error if any
        color status running green failed red else yellow
    logs
      argument deploymentId
      option f follow false
      option t tail lines
      option token jwt
      formatLogLine levelColors
        info cyan warn yellow error red debug dim
        timestamp level message
      fetchLogs GET /api/v1/deployment id logs
        404 to not found
        ECONNREFUSED to cannot connect
      runLogs
        if not follow
          print all or tail
        if follow
          ui info following
          poll every 2s
            filter new by lastTimestamp
            not found to ended
          SIGINT to stopped following
    terminate
      argument deploymentId
      option force
      runTerminate
        validate id regex a-f0-9 dash
        ui info terminating freeing GPU
        fetch DELETE /api/v1/deployment id stop-modal
        ui success duration
        ui label deploymentId status modal_app_name
        ui info GPU freed billing stopped
    fleet
      argument crew-file
      option token jwt
      option gpus count 1 to 8
      loadBlueprint
      fileExists
      resolveBlueprintPath agentBlueprint or .auraops blueprint.json
      resolveProjectRoot
      runFleetDeploy
        CrewParser parse fleet path
        for each agent in crew.agents
          POST /api/v1/deploy
        ui header step blank success
    localGpuCheck
      checkLocalGpuSetup
        detectAndInitializeDocker
          canConnect true to ready
        else askUser options
          1 manual start instructions
          2 host port validateCustomDockerConnection
          3 skip
        run if require.main === module
        catch error message process exit 1
```

---

## 3. CLI Internal Call Graph

```mermaid
graph TD
  IDX[cli/index.ts<br/>program.parse] --> INIT[initCommand]
  IDX --> DEP[deployCommand]
  IDX --> STA[statusCommand]
  IDX --> LOG[logsCommand]
  IDX --> TER[terminateCommand]
  IDX --> FLE[fleetCommand]

  INIT --> RINIT[runInit]
  RINIT --> MP[ManifestParser.parse]
  RINIT --> LG[LangGraphDetector.analyze]
  RINIT --> FD[FrameworkDetector.detect]
  RINIT --> BG[BlueprintGenerator.generate]
  RINIT --> UI[utils.ts]

  DEP --> RDEP[runDeploy]
  DEP --> RFLE[runFleetDeploy]
  RDEP --> UI
  RDEP --> AX1[axios POST /api/v1/deploy]
  RDEP --> AX2[axios GET /api/v1/deployment id]
  RFLE --> CP[CrewParser.parse]
  RFLE --> AX1
  RFLE --> UI

  STA --> RSTA[runStatus]
  RSTA --> AX3[axios GET /api/v1/deployment id]
  RSTA --> UI

  LOG --> RLOG[runLogs]
  RLOG --> FLOG[fetchLogs<br/>axios GET /api/v1/deployment id logs]
  RLOG --> POLL[poll loop 2s]
  RLOG --> UI

  TER --> RTER[runTerminate]
  RTER --> FTCH[fetch DELETE /api/v1/deployment id stop-modal]
  RTER --> UI

  FLE --> RFLE

  LGPU[localGpuCheck.ts<br/>checkLocalGpuSetup] --> DD[utils/dockerDetection.ts<br/>detectAndInitializeDocker]
  LGPU --> VD[utils/dockerDetection.ts<br/>validateCustomDockerConnection]
  LGPU --> RL[readline question]

  classDef ext fill:#222,stroke:#888,color:#fff;
  class AX1,AX2,AX3,FLOG,FTCH ext;
```

---

## 4. `auraops init` — Pipeline Sequence

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CLI as initCommand
    participant FS as fs/promises
    participant MP as ManifestParser
    participant LG as LangGraphDetector
    participant FD as FrameworkDetector
    participant BG as BlueprintGenerator
    participant UI as utils.ts

    U->>CLI: auraops init [path] [-o dir]
    CLI->>FS: fs.access(resolvedPath)
    alt path missing
        FS-->>CLI: error
        CLI->>UI: fail(...) / process.exit(1)
    end
    CLI->>MP: parse(path)
    MP-->>CLI: Manifest (allDependencies)
    CLI->>UI: step "Manifest parsed (N deps)"
    CLI->>LG: analyze(path)
    LG-->>CLI: LangGraphAnalysis | null
    opt LangGraph found
        CLI->>UI: step "StateGraph detected (stateType state)"
    end
    CLI->>FD: detect(manifest, langGraph)
    FD-->>CLI: Fingerprint
    CLI->>UI: step "Framework detected: name ver"
    CLI->>BG: generate(fingerprint, manifest, path)
    BG-->>CLI: BlueprintJSON
    CLI->>FS: mkdir .auraops
    CLI->>FS: writeFile blueprint.json (pretty 2)
    CLI->>UI: summary labels + success "Init complete in Xms"
```

---

## 5. `auraops deploy` — Pipeline Sequence

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CLI as deployCommand
    participant FS as fs/promises
    participant API as AuraOps API
    participant UI as utils.ts

    U->>CLI: auraops deploy [-b] [-p] [--gpus] [--mcp] [--fleet]
    alt --fleet <path>
        CLI->>CLI: runFleetDeploy(crew.yaml) → see Section 6
    else single agent
        CLI->>FS: readFile blueprint.json
        CLI->>FS: locate requirements.lock | requirements.txt
        CLI->>CLI: parseGpuCount(--gpus) 1–8
        CLI->>UI: header / info / step "Blueprint validated"
        CLI->>API: POST /api/v1/deploy {blueprintId, blueprintJson, lockfilePath, environmentHash, gpuRequirements, gpuCount, enableMcp, provider}
        alt response.endpoint_url present
            API-->>CLI: 200 {deploymentId, endpoint_url, ...}
        else awaiting endpoint
            loop up to 10 × 3s
                CLI->>API: GET /api/v1/deployment/{id}
                alt endpoint ready
                    API-->>CLI: endpoint_url
                else endpoint_status === failed
                    API-->>CLI: modal_deployment_error
                    CLI->>UI: warn
                end
            end
        end
        CLI->>UI: step "Logic synced" / "Model layers attached" / "Hardware synchronized" / "Agent live"
        CLI->>UI: labels (id, framework, GPU mem, GPUs, deploy time)
        opt endpoint_url present
            CLI->>UI: success "Live endpoint ready" + curl snippet
        end
        opt --mcp && mcp_enabled
            CLI->>UI: claude_desktop_config.json + MCP card / discovery URLs
        end
    end
    CLI->>UI: success "Deployed in Xms" + next-step hint
```

---

## 6. `auraops fleet` — Multi-Agent Loop

```mermaid
flowchart TD
  A[auraops fleet crew.yaml] --> B[CrewParser.parse]
  B --> C{crew.agents}
  C -->|agent #1| D[resolveBlueprintPath<br/>agent.blueprint or .auraops/blueprint.json]
  D --> E[loadBlueprint JSON]
  E --> F[resolveProjectRoot]
  F --> G[fileExists requirements.lock else requirements.txt]
  G --> H[build deployPayload]
  H --> I[POST /api/v1/deploy timeout 60s]
  I --> J[push deploymentId + endpoint_url]
  J --> K{more agents?}
  K -->|yes| D
  K -->|no| L[ui header summary + per-agent label]
```

---

## 7. `auraops logs` — Streaming State Machine

```mermaid
stateDiagram-v2
    [*] --> ResolveConfig
    ResolveConfig --> NoFollow: !options.follow
    ResolveConfig --> FollowMode: options.follow
    NoFollow --> FetchOnce: fetchLogs GET .../logs
    FetchOnce --> TailSlice: options.tail > 0
    FetchOnce --> PrintAll: no tail
    TailSlice --> PrintAll
    PrintAll --> [*]
    FollowMode --> PollLoop
    PollLoop --> FilterNew: logs.filter(timestamp > lastTimestamp)
    FilterNew --> EmitLine: for each entry, write formatLogLine
    EmitLine --> PollLoop
    PollLoop --> Ended: error "not found" → ui.warn "Deployment ended"
    Ended --> [*]
    PollLoop --> Stopped: SIGINT → ui.info "Stopped following logs"
    Stopped --> [*]
```

---

## 8. `auraops status` / `terminate` — Quick Look

| Command | Endpoint | Method | Auth | Notes |
|---|---|---|---|---|
| `status <id>` | `/api/v1/deployment/{id}` | GET | Bearer | Coloured status line; uptime computed client-side from `startTime` |
| `terminate <id>` | `/api/v1/deployment/{id}/stop-modal` | DELETE | Bearer | ID validated `^[a-f0-9-]+$`; `--force` skips "freeing GPU" banner; prints `modal_app_name` on success |

`terminate` is unique: it uses native `fetch` (not `axios`) and reads `AURAOPS_TOKEN` env directly (bypasses `getAuthHeaders`).

---

## 9. Error & Exit-Code Matrix

| Source | Trigger | Behaviour |
|---|---|---|
| `init` | `fs.access` fails | `ui.fail` + `process.exit(1)` |
| `deploy` | axios 4xx/5xx with JSON error | rethrow `Error(error)` → `ui.handleError` |
| `deploy` | `ECONNREFUSED` | rethrow "Cannot connect… Is the server running? Start it with: npm run dev" |
| `deploy` | `--gpus` invalid | `parseGpuCount` throws → `ui.handleError` |
| `status` | HTTP 404 | `Error("Deployment not found: …")` → `handleError` |
| `status` | HTTP 400 | `Error("Invalid deployment ID format")` |
| `logs` | HTTP 404 | `Error("Deployment not found")` |
| `logs` | `ECONNREFUSED` | `Error("Cannot connect …")` |
| `logs` (follow) | 404 mid-poll | `ui.warn("Deployment ended")` then return |
| `logs` (follow) | `SIGINT` | `ui.info("Stopped following logs")` + `process.exit(0)` |
| `terminate` | Invalid id regex | `ui.fail` + `process.exit(1)` |
| `terminate` | HTTP 404 | `ui.fail("Deployment not found …")` + exit 1 |
| `terminate` | HTTP error | `ui.fail("Failed to terminate …")` + exit 1 |
| `fleet` | crew.yaml parse/load fail | bubbles through `ui.handleError` |
| `localGpuCheck` | runtime error | `console.error` + `process.exit(1)` |

`utils.handleError`:
- If `AuraOpsError` → `fail(message)`, print `Details:` and `Cause:`, exit 1.
- If `Error` → `fail(message)`, exit 1.
- Else → `fail(String(error))`, exit 1.

---

## 10. File-to-File Dependency Graph (imports)

```mermaid
graph LR
  index[index.ts] --> init[init.ts]
  index --> deploy[deploy.ts]
  index --> status[status.ts]
  index --> logs[logs.ts]
  index --> terminate[terminate.ts]
  index --> fleet[fleet.ts]

  init --> utils[utils.ts]
  init --> MP[blueprinting/manifestParser]
  init --> FD[blueprinting/frameworkDetector]
  init --> FD2[blueprinting/frameworkDetectors]
  init --> BG[blueprinting/blueprintGenerator]

  deploy --> utils
  deploy --> fleet
  deploy --> BP[types/blueprint.types]

  status --> utils
  logs --> utils
  terminate --> utils
  fleet --> utils
  fleet --> CP[fleet/crewParser]
  fleet --> BP

  utils --> ERR[utils/errors]

  localGpuCheck[localGpuCheck.ts] --> DD[utils/dockerDetection]
  localGpuCheck --> RL[readline]
```

---

## 11. External HTTP Surface (CLI → API)

```mermaid
sequenceDiagram
    participant CLI
    participant API as AuraOps API (Fastify)

    CLI->>API: POST /api/v1/deploy {blueprintId, blueprintJson, lockfilePath, environmentHash, gpuRequirements, gpuCount, enableMcp, provider}
    Note over CLI,API: Triggered by `auraops deploy` and `auraops fleet`

    CLI->>API: GET /api/v1/deployment/{id}
    Note over CLI,API: Triggered by `auraops status`, deploy-poll loop

    CLI->>API: GET /api/v1/deployment/{id}/logs
    Note over CLI,API: Triggered by `auraops logs` (one-shot or 2s polling)

    CLI->>API: DELETE /api/v1/deployment/{id}/stop-modal
    Note over CLI,API: Triggered by `auraops terminate` (uses native fetch)
```

All four endpoints require `Authorization: Bearer <jwt>` (or 401).

---

## 12. Option Sources & Defaults (cheat-sheet)

| Flag | Type | Default | Source precedence | Validation |
|---|---|---|---|---|
| `--blueprint` / `-b` | path | `.auraops/blueprint.json` | CLI > flag | file must exist |
| `--provider` / `-p` | enum | `auto` | CLI > default | `local` → coerced to `auto` |
| `--gpu` / `-g` | string | – | CLI > default | none (passed through) |
| `--gpus` | int | `1` if not from CLI | `gpusSource === 'cli'` requires parse | **1–8** |
| `--token` | jwt | `AURAOPS_API_TOKEN` | CLI > env | none (warn if empty) |
| `--fleet` | path | – | CLI only | file must exist |
| `--mcp` | bool | `false` | CLI only | none |
| `--output` / `-o` | dir | `<project>/.auraops` | CLI > default | dir creatable |
| `--follow` / `-f` | bool | `false` | CLI only | none |
| `--tail` / `-t` | int | – | CLI only | `parseInt` (no range check) |
| `--force` | bool | `false` | CLI only | none |

Note: `parseGpuCount` only enforces range when `gpusSource === 'cli'` — defaults to 1 silently otherwise.

---

## 13. UI Helpers (utils.ts) — Mermaid classDiagram

```mermaid
classDiagram
    class CLIHelpers {
      +success(msg)
      +fail(msg)
      +info(msg)
      +warn(msg)
      +step(msg, timing?)
      +header(title)
      +label(key, value)
      +blank()
      +formatMs(ms) string
      +formatBytes(bytes) string
      +formatUptime(ms) string
      +getAuthHeaders(token?) Record
      +resolveApiUrl() string
      +handleError(error) never
    }
```

All formatters escape to either stdout (success/info/step/header/label/blank) or stderr (fail/warn) for proper shell redirection.

---

## 14. Lifecycle & UX Touch Points

- **Pre-flight (init)**: detects framework + LangGraph locally — no API call.
- **Deploy handshake**: synchronous `POST /api/v1/deploy` returns either a ready `endpoint_url` or a `deploymentId`; CLI then polls up to **10 × 3s** for the live endpoint.
- **Observe**: `status` (snapshot), `logs -f` (2s poll stream, SIGINT-safe).
- **Cleanup**: `terminate` (DELETE) — explicit; no auto-rotation.
- **Local dev**: `localGpuCheck` (Docker daemon probe, optional remote host:port) — independent entry point (`node dist/cli/localGpuCheck.js`).
- **Fleet**: dedicated subcommand, but also reachable via `deploy --fleet <path>` shortcut.

---

## 15. Edge Cases Worth Knowing

1. **`logs -f` filter logic**: when no `lastTimestamp` (first poll), CLI emits the *entire* history — a flood on long-running deployments. Use `-t` first.
2. **`status` uptime**: computed client-side from `startTime`; if `startTime` is missing, the label is omitted silently.
3. **`terminate` auth**: reads `AURAOPS_TOKEN` directly (not `AURAOPS_API_TOKEN`) — likely a bug; `getAuthHeaders` elsewhere uses `AURAOPS_API_TOKEN`.
4. **`deploy` 10×3s poll**: hard-coded; deployments that take >30s to surface a URL will not block further — CLI prints "no live endpoint" and exits 0.
5. **`fleet` lockfile fallback**: prefers `requirements.lock` → `requirements.txt` → `""` (server tolerates empty string).
6. **`init` LangGraph**: optional; if absent, step is skipped (no error).
7. **`gpusSource`**: only set to `'cli'` when `--gpus` is on the actual command line; passing it via config/env still defaults to 1.
8. **`localGpuCheck`**: not registered in `index.ts` — only runs if invoked directly via node; not part of `auraops` command tree.

---

## 16. Tiny ASCII Tree (terminal user view)

```
$ auraops
Usage: auraops [options] [command]

Commands:
  init        Initialize AuraOps for a project
  deploy      Deploy AI agent to GPU
  status      Check deployment status
  logs        View deployment logs
  terminate   Stop a running deployment and free GPU resources
  fleet       Deploy a multi-agent crew from crew.yaml
```

