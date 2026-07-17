import { ModalAppDeployer } from '../modalAppDeployer';

describe('ModalAppDeployer.toPipRequirement', () => {
  it('keeps range operators (live-test bug: >=0.3.0 must not become ==0.3.0)', () => {
    expect(ModalAppDeployer.toPipRequirement('llama-cpp-python', '>=0.3.8')).toBe(
      'llama-cpp-python>=0.3.8',
    );
    expect(ModalAppDeployer.toPipRequirement('llama-cpp-python', '>=0.3.0')).toBe(
      'llama-cpp-python>=0.3.0',
    );
  });

  it('pins bare versions with ==', () => {
    expect(ModalAppDeployer.toPipRequirement('fastapi', '0.110.0')).toBe('fastapi==0.110.0');
  });

  it('leaves unpinned packages unpinned', () => {
    expect(ModalAppDeployer.toPipRequirement('llama-cpp-python', '')).toBe('llama-cpp-python');
    expect(ModalAppDeployer.toPipRequirement('llama-cpp-python', 'latest')).toBe(
      'llama-cpp-python',
    );
  });

  it('preserves == and ~= specs', () => {
    expect(ModalAppDeployer.toPipRequirement('torch', '==2.1.0')).toBe('torch==2.1.0');
    expect(ModalAppDeployer.toPipRequirement('numpy', '~=1.26.0')).toBe('numpy~=1.26.0');
  });
});
