import * as path from 'path';
import {
  PROJECT_REMOTE_ROOT,
  DISCOVERY_ORDER,
  resolveProjectRoot,
  parseEntrypoint,
  formatAptPackages,
  shouldIgnoreProjectEntry,
  projectCopyFilter,
  generateUserCodeLoaderPython,
  generateUserInferencePython,
} from '../userProjectDeploy';

describe('userProjectDeploy', () => {
  describe('PROJECT_REMOTE_ROOT', () => {
    it('should equal /app', () => {
      expect(PROJECT_REMOTE_ROOT).toBe('/app');
    });
  });

  describe('resolveProjectRoot', () => {
    it('should return parent when blueprint is under .auraops', () => {
      const blueprintPath = path.join('/tmp', 'my-project', '.auraops', 'blueprint.json');
      expect(resolveProjectRoot(blueprintPath)).toBe(path.resolve('/tmp/my-project'));
    });

    it('should return blueprint directory when not under .auraops', () => {
      const blueprintPath = path.join('/tmp', 'my-project', 'configs', 'blueprint.json');
      expect(resolveProjectRoot(blueprintPath)).toBe(
        path.resolve('/tmp/my-project/configs'),
      );
    });
  });

  describe('parseEntrypoint', () => {
    it('should parse "python main.py" as file', () => {
      expect(parseEntrypoint('python main.py')).toEqual({
        kind: 'file',
        modulePath: 'main.py',
      });
    });

    it('should parse "python -m pkg" as module', () => {
      expect(parseEntrypoint('python -m pkg')).toEqual({
        kind: 'module',
        moduleName: 'pkg',
      });
    });

    it('should parse bare "main.py" as file', () => {
      expect(parseEntrypoint('main.py')).toEqual({
        kind: 'file',
        modulePath: 'main.py',
      });
    });

    it('should parse "src/agent.py" as file', () => {
      expect(parseEntrypoint('src/agent.py')).toEqual({
        kind: 'file',
        modulePath: 'src/agent.py',
      });
    });

    it('should parse dotted module "pkg.mod" as module', () => {
      expect(parseEntrypoint('pkg.mod')).toEqual({
        kind: 'module',
        moduleName: 'pkg.mod',
      });
    });

    it('should default empty/undefined entrypoint to main.py', () => {
      expect(parseEntrypoint('')).toEqual({ kind: 'file', modulePath: 'main.py' });
      expect(parseEntrypoint('   ')).toEqual({ kind: 'file', modulePath: 'main.py' });
    });

    it('should strip function suffix after colon for modules and files', () => {
      expect(parseEntrypoint('pkg.mod:fn')).toEqual({
        kind: 'module',
        moduleName: 'pkg.mod',
      });
      expect(parseEntrypoint('python -m pkg.mod:fn')).toEqual({
        kind: 'module',
        moduleName: 'pkg.mod',
      });
    });
  });

  describe('formatAptPackages', () => {
    it('should return empty string for undefined or empty list', () => {
      expect(formatAptPackages(undefined)).toBe('');
      expect(formatAptPackages([])).toBe('');
    });

    it('should format a few packages as quoted comma-separated list', () => {
      expect(formatAptPackages(['ffmpeg', 'git'])).toBe('"ffmpeg", "git"');
    });

    it('should escape double quotes in package names', () => {
      expect(formatAptPackages(['foo"bar'])).toBe('"foo\\"bar"');
    });

    it('should trim and drop blank package entries', () => {
      expect(formatAptPackages(['  ffmpeg  ', '', '  '])).toBe('"ffmpeg"');
    });
  });

  describe('shouldIgnoreProjectEntry / projectCopyFilter', () => {
    it('should ignore node_modules, .git, .env, and .pyc files', () => {
      expect(shouldIgnoreProjectEntry('node_modules')).toBe(true);
      expect(shouldIgnoreProjectEntry('.git')).toBe(true);
      expect(shouldIgnoreProjectEntry('.env')).toBe(true);
      expect(shouldIgnoreProjectEntry('module.pyc')).toBe(true);
    });

    it('should not ignore normal source files', () => {
      expect(shouldIgnoreProjectEntry('main.py')).toBe(false);
      expect(shouldIgnoreProjectEntry('src')).toBe(false);
      expect(shouldIgnoreProjectEntry('requirements.txt')).toBe(false);
    });

    it('should filter copy paths by basename', () => {
      expect(projectCopyFilter('/tmp/project/node_modules')).toBe(false);
      expect(projectCopyFilter('/tmp/project/.git')).toBe(false);
      expect(projectCopyFilter('/tmp/project/.env')).toBe(false);
      expect(projectCopyFilter('/tmp/project/__pycache__/mod.pyc')).toBe(false);
      expect(projectCopyFilter('/tmp/project/main.py')).toBe(true);
      expect(projectCopyFilter('/tmp/project/src/agent.py')).toBe(true);
    });
  });

  describe('DISCOVERY_ORDER', () => {
    it('should list core artifacts before extended callables and type scan', () => {
      expect(DISCOVERY_ORDER[0]).toBe('crew');
      expect(DISCOVERY_ORDER).toContain('handler|invoke|call|predict_fn|pipeline');
      expect(DISCOVERY_ORDER).toContain('llm_chain|agent_executor');
      expect(DISCOVERY_ORDER).toContain('single __call__ instance');
      expect(DISCOVERY_ORDER).toContain('entrypoint_script (runpy / AURAOPS_INPUT)');
      expect(DISCOVERY_ORDER).toContain('secondary common files (main.py|app.py|agent.py)');
      const crewIdx = DISCOVERY_ORDER.indexOf('crew');
      const handlerIdx = DISCOVERY_ORDER.indexOf(
        'handler|invoke|call|predict_fn|pipeline',
      );
      const scriptIdx = DISCOVERY_ORDER.indexOf(
        'entrypoint_script (runpy / AURAOPS_INPUT)',
      );
      expect(crewIdx).toBeLessThan(handlerIdx);
      expect(handlerIdx).toBeLessThan(scriptIdx);
    });
  });

  describe('generateUserCodeLoaderPython', () => {
    it('should include /app, sys.path, file load path, and user_runner discovery', () => {
      const code = generateUserCodeLoaderPython({ entrypoint: 'main.py' });

      expect(code).toContain('/app');
      expect(code).toContain('sys.path');
      expect(code).toContain('sys.path.insert(0, "/app")');
      expect(code).toContain('os.path.join("/app"');
      expect(code).toContain('"main.py"');
      expect(code).toContain('spec_from_file_location');
      expect(code).toContain('self.user_runner');
      expect(code).toContain('self.user_module = mod');
    });

    it('should use import_module for module entrypoints', () => {
      const code = generateUserCodeLoaderPython({ entrypoint: 'python -m mypkg.agent' });

      expect(code).toContain('/app');
      expect(code).toContain('sys.path');
      expect(code).toContain('importlib.import_module("mypkg.agent")');
      expect(code).toContain('self.entry_file = None');
      // primary path is import_module; secondary common-file probe may still use spec_from_file_location
      expect(code).toContain('self.user_runner');
    });

    it('should discover extended callables and LangChain-style names', () => {
      const code = generateUserCodeLoaderPython({ entrypoint: 'main.py' });

      expect(code).toContain('"handler"');
      expect(code).toContain('"invoke"');
      expect(code).toContain('"call"');
      expect(code).toContain('"predict_fn"');
      expect(code).toContain('"pipeline"');
      expect(code).toContain('"llm_chain"');
      expect(code).toContain('"agent_executor"');
      // existing callables still present and listed first in the tuple
      expect(code).toContain(
        '("run", "predict", "infer", "main", "endpoint", "handler", "invoke", "call", "predict_fn", "pipeline")',
      );
    });

    it('should scan for framework instances by type name and __call__', () => {
      const code = generateUserCodeLoaderPython({ entrypoint: 'agent.py' });

      expect(code).toContain('type(_obj).__name__');
      expect(code).toContain('"Crew"');
      expect(code).toContain('"AgentExecutor"');
      expect(code).toContain('"StateGraph"');
      expect(code).toContain('CompiledStateGraph');
      expect(code).toContain('_call_hits');
      expect(code).toContain('module_call');
    });

    it('should raise helpful error listing public names when nothing found', () => {
      const code = generateUserCodeLoaderPython({ entrypoint: 'main.py' });

      expect(code).toContain('Public names:');
      expect(code).toContain('no runnable artifact found');
      expect(code).toContain('_public = [n for n in dir(mod) if not n.startswith("_")]');
      expect(code).toContain('entrypoint=');
      expect(code).toContain(
        'Export one of: crew, graph, agent, run, main, or ensure script prints result / reads AURAOPS_INPUT',
      );
    });

    it('should keep core named exports before extended discovery', () => {
      const code = generateUserCodeLoaderPython({ entrypoint: 'main.py' });
      const crewPos = code.indexOf('hasattr(mod, "crew")');
      const handlerPos = code.indexOf('"handler"');
      const typeScanPos = code.indexOf('_type_hits');
      expect(crewPos).toBeGreaterThan(-1);
      expect(handlerPos).toBeGreaterThan(crewPos);
      expect(typeScanPos).toBeGreaterThan(handlerPos);
    });

    it('should fall back to entrypoint_script with runpy / AURAOPS_INPUT for plain scripts', () => {
      const code = generateUserCodeLoaderPython({ entrypoint: 'main.py' });

      expect(code).toContain('entrypoint_script');
      expect(code).toContain('self.entry_file = entry_file');
      expect(code).toContain('("entrypoint_script", self.entry_file)');
      // secondary common files after primary discovery fails
      expect(code).toContain('"main.py"');
      expect(code).toContain('"app.py"');
      expect(code).toContain('"agent.py"');
    });
  });

  describe('generateUserInferencePython', () => {
    it('should define _run_user_inference with crew/graph/callable tags', () => {
      const code = generateUserInferencePython();

      expect(code).toContain('def _run_user_inference');
      expect(code).toContain('tag == "crew"');
      expect(code).toContain('tag == "graph"');
      expect(code).toContain('tag == "callable"');
      expect(code).toContain('tag == "invoke"');
      expect(code).toContain('tag == "transformers"');
    });

    it('should support module_call and crew input/query fallback', () => {
      const code = generateUserInferencePython();

      expect(code).toContain('tag == "module_call"');
      expect(code).toContain('inputs={"input": input_text');
      expect(code).toContain('inputs={"query": input_text');
    });

    it('should handle entrypoint_script via runpy and AURAOPS_INPUT', () => {
      const code = generateUserInferencePython();

      expect(code).toContain('tag == "entrypoint_script"');
      expect(code).toContain('runpy');
      expect(code).toContain('run_path');
      expect(code).toContain('AURAOPS_INPUT');
      expect(code).toContain('redirect_stdout');
    });
  });
});
