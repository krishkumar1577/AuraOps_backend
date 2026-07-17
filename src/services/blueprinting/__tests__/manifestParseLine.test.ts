import { parseRequirementLine } from '../requirementSpec';

describe('parseRequirementLine (pip specs for founders)', () => {
  it('preserves >= for llama-cpp (GGUF live-test bug)', () => {
    expect(parseRequirementLine('llama-cpp-python>=0.3.8')).toEqual([
      'llama-cpp-python',
      '>=0.3.8',
    ]);
  });

  it('preserves == pins', () => {
    expect(parseRequirementLine('torch==2.1.0')).toEqual(['torch', '==2.1.0']);
  });

  it('allows unpinned packages', () => {
    expect(parseRequirementLine('llama-cpp-python')).toEqual(['llama-cpp-python', '']);
  });

  it('strips extras brackets from name', () => {
    const [name, ver] = parseRequirementLine('huggingface_hub[cli]>=0.20.0');
    expect(name).toBe('huggingface_hub');
    expect(ver).toBe('>=0.20.0');
  });

  it('ignores comments and flags', () => {
    expect(parseRequirementLine('# comment')).toEqual(['', '']);
    expect(parseRequirementLine('-r other.txt')).toEqual(['', '']);
  });

  it('turns bare version into == pin', () => {
    expect(parseRequirementLine('numpy 1.26.0')).toEqual(['numpy', '==1.26.0']);
  });
});
