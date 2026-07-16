import * as path from 'path';

/** Remote path where user project files are mounted inside the Modal container. */
export const PROJECT_REMOTE_ROOT = '/app';

/** Directory names / files skipped when packaging a user project for deploy. */
export const PROJECT_COPY_IGNORE = [
  'node_modules',
  '.git',
  '.auraops',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  '.env',
] as const;

export type ParsedEntrypoint =
  | { kind: 'file'; modulePath: string }
  | { kind: 'module'; moduleName: string };

/**
 * Resolve project root from a blueprint path.
 * Blueprint under `.auraops/` → parent dir; otherwise blueprint's directory.
 */
export function resolveProjectRoot(blueprintPath: string): string {
  const blueprintDir = path.dirname(path.resolve(blueprintPath));
  return path.basename(blueprintDir) === '.auraops'
    ? path.resolve(blueprintDir, '..')
    : blueprintDir;
}

/**
 * Parse blueprint.deploymentConfig.entrypoint into a loadable target.
 * Handles: `python main.py`, `python -m pkg`, `main.py`, `src/agent.py`, `pkg.mod:fn` (module only).
 */
export function parseEntrypoint(entrypoint: string): ParsedEntrypoint {
  const raw = (entrypoint || 'main.py').trim();
  if (!raw) {
    return { kind: 'file', modulePath: 'main.py' };
  }

  const tokens = raw.split(/\s+/).filter(Boolean);

  // python -m pkg[.sub]
  if (tokens.length >= 3 && tokens[0] === 'python' && tokens[1] === '-m') {
    const moduleName = tokens[2].split(':')[0];
    return { kind: 'module', moduleName };
  }

  // python main.py | python src/agent.py
  if (tokens.length >= 2 && tokens[0] === 'python') {
    const file = tokens[1].split(':')[0];
    if (file.endsWith('.py') || file.includes('/') || file.includes('\\')) {
      return { kind: 'file', modulePath: file.replace(/\\/g, '/') };
    }
    // python pkg.mod → treat as module
    return { kind: 'module', moduleName: file };
  }

  // bare: main.py | src/agent.py | pkg.mod | pkg.mod:fn
  const primary = tokens[0].split(':')[0];
  if (primary.endsWith('.py') || primary.includes('/') || primary.includes('\\')) {
    return { kind: 'file', modulePath: primary.replace(/\\/g, '/') };
  }
  return { kind: 'module', moduleName: primary };
}

/**
 * Format system packages for Modal `.apt_install([...])`.
 * Returns empty string when none.
 */
export function formatAptPackages(systemPackages: string[] | undefined): string {
  if (!systemPackages || systemPackages.length === 0) {
    return '';
  }
  return systemPackages
    .map((pkg) => pkg.trim())
    .filter(Boolean)
    .map((pkg) => `"${pkg.replace(/"/g, '\\"')}"`)
    .join(', ');
}

/**
 * Whether a path segment or basename should be skipped when copying the project.
 */
export function shouldIgnoreProjectEntry(name: string): boolean {
  if (!name) return false;
  if (name.endsWith('.pyc')) return true;
  return (PROJECT_COPY_IGNORE as readonly string[]).includes(name);
}

/**
 * fs.cp filter: return true to include the path.
 * `src` is the absolute path being considered for copy.
 */
export function projectCopyFilter(src: string): boolean {
  const base = path.basename(src);
  return !shouldIgnoreProjectEntry(base);
}

/**
 * Discovery priority for user-project entrypoints (generateUserCodeLoaderPython).
 * Named attrs first, then callables, LangChain aliases, type-name scan,
 * single __call__ instance, module_call, secondary common files,
 * entrypoint_script (runpy), then helpful error.
 */
export const DISCOVERY_ORDER = [
  'crew',
  'compiled_graph',
  'graph',
  'agent',
  'app', // only if .invoke (skip bare FastAPI)
  'chain',
  'model+tokenizer',
  'run|predict|infer|main|endpoint',
  'handler|invoke|call|predict_fn|pipeline',
  'llm_chain|agent_executor',
  'type-name: Crew|AgentExecutor|StateGraph|CompiledStateGraph|CompiledGraph',
  'single __call__ instance',
  'module_call(main)',
  'secondary common files (main.py|app.py|agent.py)',
  'entrypoint_script (runpy / AURAOPS_INPUT)',
  'error with public names + export hint',
] as const;

/**
 * Generate indented Python for @modal.enter load() that imports user project
 * code from PROJECT_REMOTE_ROOT and discovers a runnable artifact.
 * On success sets self.user_module and self.user_runner; raises on total failure
 * so the caller can fall back to framework scaffold.
 */
export function generateUserCodeLoaderPython(opts: {
  entrypoint: string;
  indent?: string;
}): string {
  const indent = opts.indent ?? '            ';
  const parsed = parseEntrypoint(opts.entrypoint);
  const remote = PROJECT_REMOTE_ROOT;

  const entrypointLabel =
    parsed.kind === 'file' ? parsed.modulePath : parsed.moduleName;

  const importBlock =
    parsed.kind === 'file'
      ? `${indent}entry_file = os.path.join("${remote}", ${JSON.stringify(parsed.modulePath)})
${indent}if not os.path.isfile(entry_file):
${indent}    raise FileNotFoundError(f"Entrypoint not found: {entry_file}")
${indent}spec = importlib.util.spec_from_file_location("auraops_user_entry", entry_file)
${indent}if spec is None or spec.loader is None:
${indent}    raise ImportError(f"Cannot load entrypoint: {entry_file}")
${indent}mod = importlib.util.module_from_spec(spec)
${indent}sys.modules["auraops_user_entry"] = mod
${indent}spec.loader.exec_module(mod)
${indent}self.entry_file = entry_file`
      : `${indent}mod = importlib.import_module(${JSON.stringify(parsed.moduleName)})
${indent}self.entry_file = None`;

  return `${indent}import importlib
${indent}import importlib.util
${indent}import os
${indent}import sys
${indent}import types as _auraops_types
${indent}
${indent}if "${remote}" not in sys.path:
${indent}    sys.path.insert(0, "${remote}")
${indent}
${importBlock}
${indent}
${indent}self.user_module = mod
${indent}self.user_runner = None
${indent}self._entry_label = ${JSON.stringify(entrypointLabel)}
${indent}
${indent}def _auraops_discover(mod):
${indent}    """Return (tag, obj) or None — order: DISCOVERY_ORDER in userProjectDeploy.ts"""
${indent}    if hasattr(mod, "crew") and mod.crew is not None:
${indent}        return ("crew", mod.crew)
${indent}    if hasattr(mod, "compiled_graph") and mod.compiled_graph is not None:
${indent}        return ("graph", mod.compiled_graph)
${indent}    if hasattr(mod, "graph") and mod.graph is not None:
${indent}        g = mod.graph
${indent}        if hasattr(g, "compile") and not hasattr(g, "invoke"):
${indent}            g = g.compile()
${indent}        return ("graph", g)
${indent}    if hasattr(mod, "agent") and mod.agent is not None:
${indent}        return ("invoke", mod.agent)
${indent}    if hasattr(mod, "app") and mod.app is not None and hasattr(mod.app, "invoke"):
${indent}        return ("invoke", mod.app)
${indent}    if hasattr(mod, "chain") and mod.chain is not None:
${indent}        return ("invoke", mod.chain)
${indent}    if hasattr(mod, "model") and hasattr(mod, "tokenizer") and mod.model is not None and mod.tokenizer is not None:
${indent}        return ("transformers", (mod.model, mod.tokenizer))
${indent}    for fn_name in ("run", "predict", "infer", "main", "endpoint", "handler", "invoke", "call", "predict_fn", "pipeline"):
${indent}        fn = getattr(mod, fn_name, None)
${indent}        if callable(fn):
${indent}            return ("callable", fn)
${indent}    for attr in ("llm_chain", "agent_executor"):
${indent}        obj = getattr(mod, attr, None)
${indent}        if obj is None:
${indent}            continue
${indent}        if hasattr(obj, "invoke"):
${indent}            return ("invoke", obj)
${indent}        if callable(obj):
${indent}            return ("callable", obj)
${indent}    _type_hits = []
${indent}    _GRAPH_TYPES = ("StateGraph", "CompiledStateGraph", "CompiledGraph", "Pregel")
${indent}    for _name in dir(mod):
${indent}        if _name.startswith("_"):
${indent}            continue
${indent}        _obj = getattr(mod, _name, None)
${indent}        if _obj is None:
${indent}            continue
${indent}        _tname = type(_obj).__name__
${indent}        if _tname == "Crew" or _tname == "AgentExecutor" or _tname in _GRAPH_TYPES:
${indent}            _type_hits.append((_tname, _obj))
${indent}    if len(_type_hits) == 1:
${indent}        _tname, _obj = _type_hits[0]
${indent}        if _tname == "Crew":
${indent}            return ("crew", _obj)
${indent}        if _tname == "AgentExecutor":
${indent}            return ("invoke", _obj)
${indent}        g = _obj
${indent}        if hasattr(g, "compile") and not hasattr(g, "invoke"):
${indent}            g = g.compile()
${indent}        return ("graph", g)
${indent}    _call_hits = []
${indent}    for _name in dir(mod):
${indent}        if _name.startswith("_"):
${indent}            continue
${indent}        _obj = getattr(mod, _name, None)
${indent}        if _obj is None or isinstance(_obj, type):
${indent}            continue
${indent}        if isinstance(_obj, (_auraops_types.FunctionType, _auraops_types.BuiltinFunctionType, _auraops_types.MethodType, _auraops_types.ModuleType)):
${indent}            continue
${indent}        if callable(_obj):
${indent}            _call_hits.append(_obj)
${indent}    if len(_call_hits) == 1:
${indent}        return ("callable", _call_hits[0])
${indent}    _main = getattr(mod, "main", None)
${indent}    if callable(_main):
${indent}        return ("module_call", _main)
${indent}    return None
${indent}
${indent}def _auraops_apply_runner(tag, obj, mod):
${indent}    self.user_module = mod
${indent}    self.user_runner = (tag, obj)
${indent}    if tag == "crew":
${indent}        self.crew = obj
${indent}    elif tag == "graph":
${indent}        self.compiled_graph = obj
${indent}    elif tag == "invoke" and getattr(mod, "agent", None) is obj:
${indent}        self.agent = obj
${indent}    elif tag == "transformers":
${indent}        self.model, self.tokenizer = obj
${indent}
${indent}_found = _auraops_discover(mod)
${indent}if _found is not None:
${indent}    _auraops_apply_runner(_found[0], _found[1], mod)
${indent}
${indent}# Secondary common files when primary entry has no discoverable artifact
${indent}if self.user_runner is None:
${indent}    _primary_base = os.path.basename(self.entry_file) if self.entry_file else ""
${indent}    for _sec_name in ("main.py", "app.py", "agent.py"):
${indent}        if _sec_name == _primary_base:
${indent}            continue
${indent}        _sec_path = os.path.join("${remote}", _sec_name)
${indent}        if not os.path.isfile(_sec_path):
${indent}            continue
${indent}        try:
${indent}            _sec_spec = importlib.util.spec_from_file_location("auraops_user_secondary", _sec_path)
${indent}            if _sec_spec is None or _sec_spec.loader is None:
${indent}                continue
${indent}            _sec_mod = importlib.util.module_from_spec(_sec_spec)
${indent}            sys.modules["auraops_user_secondary"] = _sec_mod
${indent}            _sec_spec.loader.exec_module(_sec_mod)
${indent}            _sec_found = _auraops_discover(_sec_mod)
${indent}            if _sec_found is not None:
${indent}                _auraops_apply_runner(_sec_found[0], _sec_found[1], _sec_mod)
${indent}                self.entry_file = _sec_path
${indent}                break
${indent}        except Exception:
${indent}            continue
${indent}
${indent}# File entry with no exports: treat as script front door (runpy at inference)
${indent}if self.user_runner is None and self.entry_file and os.path.isfile(self.entry_file):
${indent}    self.user_runner = ("entrypoint_script", self.entry_file)
${indent}
${indent}if self.user_runner is None:
${indent}    _public = [n for n in dir(mod) if not n.startswith("_")]
${indent}    raise RuntimeError(
${indent}        "User entrypoint loaded but no runnable artifact found. "
${indent}        f"entrypoint={self._entry_label!r}. Public names: {_public}. "
${indent}        "Export one of: crew, graph, agent, run, main, or ensure script prints result / reads AURAOPS_INPUT"
${indent}    )
${indent}print(f"✓ User project loaded from ${remote}: runner={self.user_runner[0]}")`;
}

/**
 * Python method body for dispatching to a discovered user runner.
 * Returns indented method suitable for class AuraOpsAgent.
 */
export function generateUserInferencePython(indent = '        '): string {
  // Method uses self-relative indent for body lines
  const i = indent;
  return `${i}def _run_user_inference(self, input_text: str, metadata: dict) -> str:
${i}    """Dispatch to discovered user project artifact."""
${i}    if self.user_runner is None:
${i}        raise RuntimeError("User runner not loaded")
${i}    tag, obj = self.user_runner
${i}    if tag == "crew":
${i}        try:
${i}            result = obj.kickoff(inputs={"input": input_text, **(metadata or {})})
${i}        except Exception:
${i}            result = obj.kickoff(inputs={"query": input_text, **(metadata or {})})
${i}        if hasattr(result, "raw"):
${i}            return str(result.raw)
${i}        return str(result)
${i}    if tag == "graph":
${i}        result = obj.invoke({"input": input_text, **(metadata or {})})
${i}        if isinstance(result, dict):
${i}            return str(result.get("output", result))
${i}        return str(result)
${i}    if tag == "invoke":
${i}        response = obj.invoke({"input": input_text, **(metadata or {})})
${i}        if isinstance(response, dict):
${i}            return str(response.get("output", response))
${i}        return str(response)
${i}    if tag == "transformers":
${i}        model, tokenizer = obj
${i}        inputs = tokenizer(input_text, return_tensors="pt")
${i}        outputs = model.generate(**inputs, max_length=100)
${i}        return tokenizer.decode(outputs[0], skip_special_tokens=True)
${i}    if tag == "callable" or tag == "module_call":
${i}        try:
${i}            result = obj(input_text, metadata)
${i}        except TypeError:
${i}            try:
${i}                result = obj(input_text)
${i}            except TypeError:
${i}                result = obj()
${i}        return str(result)
${i}    if tag == "entrypoint_script":
${i}        # Prefer main() on already-loaded module if present
${i}        mod = getattr(self, "user_module", None)
${i}        _main = getattr(mod, "main", None) if mod is not None else None
${i}        if callable(_main):
${i}            try:
${i}                result = _main(input_text, metadata)
${i}            except TypeError:
${i}                try:
${i}                    result = _main(input_text)
${i}                except TypeError:
${i}                    result = _main()
${i}            return str(result)
${i}        import runpy
${i}        import io
${i}        import contextlib
${i}        import os as _os
${i}        entry_file = obj if isinstance(obj, str) else getattr(self, "entry_file", None)
${i}        if not entry_file:
${i}            raise RuntimeError("entrypoint_script runner missing entry file path")
${i}        _os.environ["AURAOPS_INPUT"] = input_text
${i}        buf = io.StringIO()
${i}        with contextlib.redirect_stdout(buf):
${i}            runpy.run_path(entry_file, run_name="__main__")
${i}        return buf.getvalue() or "ok"
${i}    raise RuntimeError(f"Unknown user runner tag: {tag}")
`;
}
