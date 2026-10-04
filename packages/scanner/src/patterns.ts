/** Language-independent patterns shared by the per-language analyzers. */

export interface PathHit {
  index: number;
  subject: string;
}

function collect(
  text: string,
  re: RegExp,
  subject: (m: RegExpExecArray) => string | null,
): PathHit[] {
  const hits: PathHit[] = [];
  // Cheap rejection first: most lines match nothing (the patterns are not global).
  if (!re.test(text)) return hits;
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = global.exec(text); m !== null; m = global.exec(text)) {
    const s = subject(m);
    if (s !== null) hits.push({ index: m.index, subject: s });
    if (m[0].length === 0) global.lastIndex++;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

const URL_RE = /\b(?:https?|wss?|ftps?):\/\/([^\s/?#'"`<>()[\]{}\\|,;]+)/gi;

/** Normalizes a URL authority to a hostname, or null when it is not a literal host. */
export function hostFromAuthority(authority: string): string | null {
  let host = authority;
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end > 0 ? host.slice(1, end) : host;
  } else {
    host = host.replace(/:\d*$/, '');
  }
  host = host.replace(/\.$/, '').toLowerCase();
  if (host === '' || /[$%{}]/.test(host)) return null;
  return host;
}

/** All literal URL hosts on a line, in order. */
export function urlHosts(text: string): { index: number; host: string }[] {
  const out: { index: number; host: string }[] = [];
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m !== null; m = URL_RE.exec(text)) {
    const host = hostFromAuthority(m[1] ?? '');
    if (host !== null) out.push({ index: m.index, host });
  }
  return out;
}

/** The first literal URL host on a line, or '*' when none is visible. */
export function hostSubject(text: string): string {
  return urlHosts(text)[0]?.host ?? '*';
}

// ---------------------------------------------------------------------------
// Secrets (secrets.read)
// ---------------------------------------------------------------------------

const ENV_FILE_EXEMPT = new Set([
  'example',
  'sample',
  'template',
  'dist',
  'defaults',
  'default',
  'schema',
  'tpl',
]);

const SECRET_PATTERNS: {
  re: RegExp;
  subject: (m: RegExpExecArray, text: string) => string | null;
}[] = [
  {
    // Not a property access such as `process.env`, `process?.env` or `config().env`.
    re: /(?<![\w$.?)\]-])\.env(?:\.([A-Za-z0-9_-]+))?(?![\w-])/,
    subject: (m) => {
      const suffix = m[1];
      if (suffix === undefined) return '.env';
      return ENV_FILE_EXEMPT.has(suffix.toLowerCase()) ? null : `.env.${suffix}`;
    },
  },
  {
    re: /\brequire\(\s*['"]dotenv(?:\/config)?['"]\s*\)|\bfrom\s+['"]dotenv(?:\/config)?['"]|\bimport\s+['"]dotenv\/config['"]|\bload_dotenv\s*\(|\bdotenv_values\s*\(/,
    subject: () => '.env',
  },
  {
    re: /(?<![\w$.-])\.aws(?=$|[\\/'"`\s,)\]}])/,
    subject: (m, text) => {
      const rest = text.slice(m.index);
      if (/credentials/.test(rest)) return '~/.aws/credentials';
      if (/\bconfig\b/.test(rest)) return '~/.aws/config';
      return '~/.aws';
    },
  },
  {
    re: /(?<![\w$.-])\.ssh(?=$|[\\/'"`\s,)\]}])/,
    subject: (m, text) => {
      const rest = text.slice(m.index + 4, m.index + 80);
      const file = /^['"`]?\s*(?:[\\/]|,\s*['"`])\s*([\w.-]+)/.exec(rest)?.[1];
      if (file === undefined) return '~/.ssh';
      if (file === 'known_hosts' || file === 'authorized_keys' || file.endsWith('.pub'))
        return null;
      return `~/.ssh/${file}`;
    },
  },
  {
    re: /(?<![\w.\\/-])id_(?:rsa|dsa|ecdsa|ed25519)(?![\w.-])/,
    subject: (m) => `~/.ssh/${m[0]}`,
  },
  { re: /\.config[\\/]+gcloud\b/, subject: () => '~/.config/gcloud' },
  {
    re: /\bapplication_default_credentials\.json\b/,
    subject: () => '~/.config/gcloud/application_default_credentials.json',
  },
  {
    re: /(?<![\w$.-])(\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|\.pgpass|\.my\.cnf)(?![\w.-])/,
    subject: (m) => `~/${m[1]}`,
  },
  { re: /\.docker[\\/]+config\.json\b/, subject: () => '~/.docker/config.json' },
  { re: /\.kube[\\/]+config\b/, subject: () => '~/.kube/config' },
  { re: /(?<![\w$.-])\.azure(?=[\\/'"`\s])/, subject: () => '~/.azure' },
  { re: /(?<![\w$.-])\.gnupg\b/, subject: () => '~/.gnupg' },
  { re: /\.config[\\/]+gh[\\/]+hosts\.yml\b/, subject: () => '~/.config/gh/hosts.yml' },
  {
    re: /\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain)\b|\bsecret-tool\s+lookup\b|\bkeyring\.get_password\s*\(|\bkeytar\b|\bcmdkey(?:\.exe)?\s+\/list\b|\bGet-StoredCredential\b|\bCredRead\w*\s*\(|\bvaultcmd\b|\bPasswordVault\b|\blogin\.keychain\b/i,
    subject: () => 'keychain',
  },
  {
    re: /User Data[\\/]|Application Support[\\/]+(?:Google[\\/]+Chrome|Chromium|BraveSoftware|Microsoft Edge|Firefox)|\.config[\\/]+(?:google-chrome|chromium|BraveSoftware|microsoft-edge)\b|\.mozilla[\\/]+firefox|Mozilla[\\/]+Firefox[\\/]+Profiles|\b(?:Login Data|Web Data|logins\.json|key[34]\.db|cookies\.sqlite)\b/,
    subject: () => 'browser-profile',
  },
];

/** Credential files, keychains and browser profiles referenced on a line. */
export function findSecretPaths(text: string): PathHit[] {
  const hits: PathHit[] = [];
  for (const p of SECRET_PATTERNS) hits.push(...collect(text, p.re, (m) => p.subject(m, text)));
  return hits.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Persistence (fs.persistence)
// ---------------------------------------------------------------------------

const PERSISTENCE_PATTERNS: { re: RegExp; subject: (m: RegExpExecArray) => string }[] = [
  {
    re: /(?<![\w$.-])\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|cshrc|tcshrc|kshrc|mkshrc)(?![\w.-])/,
    subject: (m) => `~/.${m[1]}`,
  },
  { re: /\bconfig\.fish\b/, subject: () => '~/.config/fish/config.fish' },
  { re: /\/etc\/(?:profile|bash\.bashrc|environment|zshrc|zsh\/zshrc)\b/, subject: (m) => m[0] },
  {
    re: /\$PROFILE\b|\bMicrosoft\.PowerShell_profile\.ps1\b|(?<![\w.-])profile\.ps1\b/i,
    subject: () => '$PROFILE',
  },
  {
    re: /Start Menu[\\/]+Programs[\\/]+Startup|\bshell:(?:common )?startup\b|SpecialFolder\]::(?:Common)?Startup\b|GetFolderPath\(\s*['"](?:Common)?Startup['"]|[\\/]\.config[\\/]+autostart\b|\/etc\/xdg\/autostart\b|\/etc\/rc\.local\b|\/etc\/init\.d\//i,
    subject: () => 'startup-folder',
  },
  {
    re: /\/etc\/cron(?:tab|\.d|\.daily|\.hourly|\.weekly|\.monthly)?\b|\/var\/spool\/cron\b|Library[\\/]+Launch(?:Agents|Daemons)\b|\.config[\\/]+systemd[\\/]+user\b|\/etc\/systemd\/system\b/,
    subject: () => 'scheduler',
  },
  {
    re: /CurrentVersion[\\/]+Run(?:Once|Services|ServicesOnce)?\b|[\\/]Winlogon\b|Image File Execution Options/i,
    subject: () => 'registry-run',
  },
  { re: /\.git[\\/]+hooks\b|\bcore\.hooksPath\b/, subject: () => 'git-hooks' },
  {
    // Settings, hooks, MCP servers and always-loaded instruction files of agents: writing them
    // changes permissions or injects instructions into every later session. Adding a command
    // or skill file is ordinary authoring and is not matched.
    re: /\.claude[\\/]+(?:settings(?:\.local)?\.json|hooks)\b|(?<![\w.-])\.claude\.json\b|(?<![\w.-])(?:CLAUDE|AGENTS|GEMINI)\.md\b|\.cursor[\\/]+(?:mcp\.json|rules)\b|(?<![\w.-])\.cursorrules\b|\.codex[\\/]+(?:config\.toml|AGENTS\.md)\b|(?<![\w.-])\.mcp\.json\b|\.vscode[\\/]+(?:settings|mcp)\.json\b|\bcopilot-instructions\.md\b|(?<![\w.-])\.windsurfrules\b|\.gemini[\\/]+settings\.json\b/,
    subject: () => 'agent-config',
  },
  { re: /(?<![\w.-])authorized_keys\b/, subject: () => '~/.ssh/authorized_keys' },
];

/** Shell rc files, startup folders, schedulers, Run keys, git hooks and agent config. */
export function findPersistencePaths(text: string): PathHit[] {
  const hits: PathHit[] = [];
  for (const p of PERSISTENCE_PATTERNS) hits.push(...collect(text, p.re, p.subject));
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * Commands that install persistence by themselves, whatever file they touch.
 * Returns the subject, or null.
 */
export function persistenceCommand(text: string): PathHit | null {
  const checks: { re: RegExp; subject: string; ok?: (m: RegExpExecArray) => boolean }[] = [
    {
      re: /\bcrontab\b(?:\.exe)?([^|;&\n]*)/,
      subject: 'scheduler',
      ok: (m) => !/^\s*-[lr]\b/.test(m[1] ?? ''),
    },
    { re: /\blaunchctl\s+(?:load|bootstrap|submit|enable)\b/, subject: 'scheduler' },
    { re: /\bsystemctl\s+(?:--user\s+)?(?:enable|link)\b/, subject: 'scheduler' },
    { re: /\bupdate-rc\.d\b|\bchkconfig\b[^\n]*\bon\b/, subject: 'scheduler' },
    { re: /\bschtasks(?:\.exe)?\b[^\n]*\/create\b/i, subject: 'scheduler' },
    { re: /\bRegister-ScheduledTask\b/i, subject: 'scheduler' },
    {
      re: /\b(?:reg(?:\.exe)?\s+(?:add|import)|New-ItemProperty|Set-ItemProperty|SetValue(?:Ex)?\s*\()[^\n]*CurrentVersion[\\/]+Run/i,
      subject: 'registry-run',
    },
    { re: /\bgit\s+config\b[^\n]*\bcore\.hooksPath\b/, subject: 'git-hooks' },
  ];
  for (const c of checks) {
    if (!c.re.test(text)) continue;
    const re = new RegExp(c.re.source, `${c.re.flags}g`);
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (c.ok === undefined || c.ok(m)) return { index: m.index, subject: c.subject };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Encoded data (code.obfuscated, code.dynamic)
// ---------------------------------------------------------------------------

/** Runtime decoding of base64/hex data, in any supported language. */
export const DECODE_RE =
  /\batob\s*\(|\bBuffer\.from\s*\([^\n]*['"](?:base64|base64url|hex)['"]|\.?\bfrom(?:Base64|Hex)\s*\(|\b(?:b64decode|b32decode|b16decode|b85decode|a85decode|urlsafe_b64decode|decodebytes|decodestring|unhexlify|a2b_base64|a2b_hex)\s*\(|\bbytes\.fromhex\s*\(|\bcodecs\.decode\s*\([^\n]*['"](?:base64|hex|rot13|rot_13)['"]|\bbase64\s+(?:-[a-zA-Z]*[dD][a-zA-Z]*|--decode)\b|\bopenssl\s+(?:enc\s+)?-?base64\b[^\n]*\s-d\b|\bxxd\s+(?:-\w+\s+)*-r\b|\bcertutil(?:\.exe)?\s+-decode\b|FromBase64String\s*\(/i;

/** A base64 or hex run of at least 200 characters. */
export const BLOB_RE = /[A-Za-z0-9+/=_-]{200,}/g;

export function looksLikeEncodedBlob(run: string): boolean {
  if (/^[0-9a-fA-F]+$/.test(run)) return true;
  return /[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);
}

/** PowerShell -EncodedCommand with a base64 argument. */
export const PS_ENCODED_RE =
  /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+['"]?[A-Za-z0-9+/=]{16,}/i;
