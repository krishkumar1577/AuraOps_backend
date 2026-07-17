/**
 * Parse a single requirements.txt line into [packageName, pipVersionSpec].
 * Preserves operators (>=, ==, ~=) so install does not pin ancient wheels.
 */
export function parseRequirementLine(line: string): [string, string] {
  const stripped = line.split('#')[0].trim();
  if (!stripped || stripped.startsWith('-')) return ['', ''];

  const match = stripped.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?(.*)$/);
  if (!match) return ['', ''];

  const name = match[1].toLowerCase();
  let versionSpec = (match[3] || '').trim();
  versionSpec = versionSpec.split(';')[0].trim();

  if (!versionSpec) {
    return [name, ''];
  }

  if (/^[<>=!~]/.test(versionSpec) || versionSpec.includes(',')) {
    return [name, versionSpec];
  }

  if (/^\d/.test(versionSpec)) {
    return [name, `==${versionSpec}`];
  }

  return [name, versionSpec];
}
