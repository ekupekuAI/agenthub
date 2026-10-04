/** `deps.remote` for dependency manifests: npm install hooks and remote dependency specs. */
import type { FileScan } from '../context';
import { analyzeCommandString } from './shell';

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
const DEPENDENCY_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const REMOTE_SPEC_RE =
  /^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|[\w.-]+\/[\w.-]+(?:#.*)?$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lineOf(scan: FileScan, key: string, value: string): number {
  const keyText = JSON.stringify(key);
  const index = scan.lines.findIndex((l) => l.includes(keyText) && l.includes(value.slice(0, 40)));
  return index < 0 ? 1 : index + 1;
}

export function analyzePackageJson(scan: FileScan, text: string): void {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  if (!isRecord(json)) return;
  const scripts = json.scripts;
  if (isRecord(scripts)) {
    for (const hook of INSTALL_HOOKS) {
      const command = scripts[hook];
      if (typeof command !== 'string') continue;
      const line = lineOf(scan, hook, command);
      scan.add({
        ruleId: 'deps.remote',
        line,
        message: `npm ${hook} hook runs on install: ${command}`,
        subject: 'npm',
      });
      analyzeCommandString(scan, command, line);
    }
  }
  for (const key of DEPENDENCY_KEYS) {
    const deps = json[key];
    if (!isRecord(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !REMOTE_SPEC_RE.test(spec)) continue;
      scan.add({
        ruleId: 'deps.remote',
        line: lineOf(scan, name, spec),
        message: `Dependency ${name} is fetched from ${spec}`,
        subject: 'npm',
      });
    }
  }
}

export function analyzeRequirements(scan: FileScan): void {
  scan.lines.forEach((raw, i) => {
    const text = raw.replace(/(?:^|\s)#.*$/, '');
    const m =
      /(?:^|\s)(?:git|hg|svn|bzr)\+\S+|https?:\/\/\S+|^\s*(?:--(?:index-url|extra-index-url|find-links|trusted-host)\b|-[if]\s)/.exec(
        text,
      );
    if (m === null) return;
    scan.add({
      ruleId: 'deps.remote',
      line: i + 1,
      focus: m.index,
      message: 'Python requirement fetched from a URL, VCS or custom index',
      subject: 'pip',
    });
  });
}
