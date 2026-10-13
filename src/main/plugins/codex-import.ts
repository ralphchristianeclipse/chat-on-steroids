/** Passive Codex MCP inventory. Never launches servers, resolves credential env vars or exports secrets. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

export type CodexMcpSource = 'user' | 'project';
export interface CodexMcpCandidate {
  id: string; fingerprint: string; name: string; source: CodexMcpSource;
  transport: 'stdio' | 'http'; enabled: boolean;
  executable?: string; argumentCount?: number; endpointHost?: string;
  envNames: string[]; envVarNames: string[]; headerNames: string[]; headerEnvNames: string[];
}
export interface CodexMcpRejected { source: CodexMcpSource; name: string; reason: string }
export interface CodexMcpSourceError { source: CodexMcpSource; reason: 'unsafe-path' | 'unreadable' | 'too-large' | 'invalid-toml' | 'invalid-config' }
export interface CodexMcpImportOptions { codexHome?: string; projectRoot?: string; sourceOnly?: CodexMcpSource }
export interface CodexMcpDiscovery {
  candidates: CodexMcpCandidate[]; rejected: CodexMcpRejected[]; errors: CodexMcpSourceError[];
}

const MAX_CONFIG_BYTES = 256 * 1024;
const named = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const allowedFields = new Set(['command', 'args', 'cwd', 'url', 'env', 'env_vars', 'http_headers',
  'env_http_headers', 'bearer_token_env_var', 'enabled', 'disabled', 'enabled_tools', 'disabled_tools',
  'startup_timeout_sec', 'tool_timeout_sec', 'startup_timeout_ms', 'tool_timeout_ms']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identityPath = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const contained = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const sorted = (values: string[]): string[] => [...new Set(values)].sort();
const stringList = (value: unknown, pattern: RegExp = /^.{1,8192}$/): string[] | null =>
  Array.isArray(value) && value.length <= 128 && value.every(v => typeof v === 'string' && pattern.test(v))
    ? value : null;
const stringMap = (value: unknown, keyPattern: RegExp, valuePattern: RegExp): Record<string, string> | null => {
  if (!record(value) || Object.keys(value).length > 128) return null;
  if (!Object.entries(value).every(([k, v]) => keyPattern.test(k) && typeof v === 'string' && valuePattern.test(v))) return null;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) as Record<string, string>;
};

function candidate(name: string, value: unknown, source: CodexMcpSource, sourcePath: string, root?: string): Promise<CodexMcpCandidate> {
  return (async () => {
    if (!record(value) || Object.keys(value).some(key => !allowedFields.has(key))) throw Error('invalid-fields');
    const command = value.command, url = value.url;
    const stdio = typeof command === 'string' && command.length > 0 && command.length <= 4096 && !/[\r\n\0]/.test(command);
    const http = typeof url === 'string' && url.length > 0 && url.length <= 4096;
    if (stdio === http || (command !== undefined && !stdio) || (url !== undefined && !http)) throw Error('invalid-transport');
    if ((value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
      (value.disabled !== undefined && typeof value.disabled !== 'boolean') ||
      (value.enabled === true && value.disabled === true)) throw Error('invalid-enabled');
    const enabled = value.enabled !== false && value.disabled !== true;
    const args = value.args === undefined ? [] : stringList(value.args);
    const env = value.env === undefined ? {} : stringMap(value.env, envName, /^[\s\S]{0,8192}$/);
    const vars = value.env_vars === undefined ? [] : stringList(value.env_vars, envName);
    const headers = value.http_headers === undefined ? {} : stringMap(value.http_headers, headerName, /^[^\r\n]{0,8192}$/);
    const headerVars = value.env_http_headers === undefined ? {} : stringMap(value.env_http_headers, headerName, envName);
    const bearer = value.bearer_token_env_var;
    if (!args || !env || !vars || !headers || !headerVars || (bearer !== undefined &&
      (typeof bearer !== 'string' || !envName.test(bearer)))) throw Error('invalid-environment');
    if ((http && (value.args !== undefined || value.env !== undefined || value.env_vars !== undefined || value.cwd !== undefined)) ||
      (stdio && (value.http_headers !== undefined || value.env_http_headers !== undefined || bearer !== undefined))) {
      throw Error('invalid-transport-fields');
    }
    for (const field of ['enabled_tools', 'disabled_tools']) {
      if (value[field] !== undefined && !stringList(value[field], named)) throw Error('invalid-tools');
    }
    for (const field of ['startup_timeout_sec', 'tool_timeout_sec', 'startup_timeout_ms', 'tool_timeout_ms']) {
      if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]) ||
        (value[field] as number) <= 0 || (value[field] as number) > 600000)) throw Error('invalid-timeout');
    }
    let cwd: string | undefined;
    if (value.cwd !== undefined) {
      if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || /[\0\r\n]/.test(value.cwd)) throw Error('invalid-cwd');
      cwd = path.resolve(value.cwd);
      if (source === 'project' && root) {
        const resolved = await fs.realpath(cwd).catch(() => null);
        if (!resolved || !contained(root, resolved) || !(await fs.stat(resolved)).isDirectory()) throw Error('invalid-cwd');
        cwd = resolved;
      }
    }
    let endpoint: URL | undefined;
    if (http) {
      try { endpoint = new URL(url as string); } catch { throw Error('invalid-url'); }
      const hostname = endpoint.hostname.toLowerCase();
      const local = hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);
      if (!['https:', 'http:'].includes(endpoint.protocol) || (endpoint.protocol === 'http:' && !local) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('unsafe-url');
    }
    const launch = { source, sourcePath: identityPath(sourcePath), name, enabled, transport: stdio ? 'stdio' : 'http',
      command: stdio ? command : null, args, cwd: cwd ?? null, url: endpoint?.href ?? null,
      env, envVars: sorted(vars), headers, headerVars, bearer: bearer ?? null,
      enabledTools: sorted(value.enabled_tools as string[] ?? []), disabledTools: sorted(value.disabled_tools as string[] ?? []),
      startupTimeout: value.startup_timeout_sec ?? value.startup_timeout_ms ?? null,
      toolTimeout: value.tool_timeout_sec ?? value.tool_timeout_ms ?? null };
    const executable = stdio ? path.win32.basename(command as string).split('/').pop() : undefined;
    return { id: `codex_${hash([source, identityPath(sourcePath), name]).slice(0, 32)}`,
      fingerprint: hash(launch), name, source, transport: stdio ? 'stdio' : 'http', enabled,
      ...(executable && named.test(executable) ? { executable } : {}),
      ...(stdio ? { argumentCount: args.length } : { endpointHost: endpoint!.host }),
      envNames: Object.keys(env), envVarNames: sorted(vars), headerNames: Object.keys(headers),
      headerEnvNames: sorted([...Object.values(headerVars), ...(bearer ? [bearer as string] : [])]) };
  })();
}

async function readConfig(file: string, root?: string): Promise<{ data: Record<string, unknown>; canonical: string } | null> {
  const before = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw Error('unreadable');
  });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink()) throw Error('unsafe-path');
  if (before.size > MAX_CONFIG_BYTES) throw Error('too-large');
  const canonical = await fs.realpath(file).catch(() => { throw Error('unsafe-path'); });
  if (root && !contained(root, canonical)) throw Error('unsafe-path');
  const content = await fs.readFile(file, 'utf8').catch(() => { throw Error('unreadable'); });
  const after = await fs.lstat(file).catch(() => { throw Error('unsafe-path'); });
  if (!after.isFile() || after.isSymbolicLink() || after.size > MAX_CONFIG_BYTES ||
    before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
    canonical !== await fs.realpath(file).catch(() => null)) throw Error('unsafe-path');
  try { const data: unknown = parse(content); if (!record(data)) throw Error(); return { data, canonical }; }
  catch { throw Error('invalid-toml'); }
}

export async function discoverCodexMcpCandidates(options: CodexMcpImportOptions = {}): Promise<CodexMcpDiscovery> {
  const result: CodexMcpDiscovery = { candidates: [], rejected: [], errors: [] };
  const codexHome = options.codexHome ?? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const sources: Array<{ source: CodexMcpSource; file: string; root?: string }> = [
    { source: 'user', file: path.join(codexHome, 'config.toml') }
  ];
  if (options.projectRoot) {
    const root = await fs.realpath(options.projectRoot).catch(() => null);
    if (!root || !(await fs.stat(root)).isDirectory()) result.errors.push({ source: 'project', reason: 'unsafe-path' });
    else sources.push({ source: 'project', file: path.join(root, '.codex', 'config.toml'), root });
  }
  for (const item of sources.filter(item => !options.sourceOnly || item.source === options.sourceOnly)) {
    try {
      if (!path.isAbsolute(item.file)) throw Error('unsafe-path');
      if (item.root) {
        const folder = path.dirname(item.file);
        const info = await fs.lstat(folder).catch(() => null);
        if (info && (!info.isDirectory() || info.isSymbolicLink())) throw Error('unsafe-path');
      }
      const snapshot = await readConfig(item.file, item.root);
      if (!snapshot) continue;
      const parsed = snapshot.data;
      if (parsed.mcp_servers === undefined) continue;
      if (!record(parsed.mcp_servers)) throw Error('invalid-config');
      for (const [name, row] of Object.entries(parsed.mcp_servers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (!named.test(name)) { result.rejected.push({ source: item.source, name: '[invalid]', reason: 'invalid-name' }); continue; }
        try { result.candidates.push(await candidate(name, row, item.source, snapshot.canonical, item.root)); }
        catch (error) { result.rejected.push({ source: item.source, name, reason: error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'invalid-entry' }); }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      result.errors.push({ source: item.source, reason: ['unsafe-path', 'unreadable', 'too-large', 'invalid-toml', 'invalid-config'].includes(reason)
        ? reason as CodexMcpSourceError['reason'] : 'unreadable' });
    }
  }
  return result;
}

/** Source/name identify an approval record; changed fingerprint always requires renewed approval. */
export function compareCodexMcpCandidate(a: Pick<CodexMcpCandidate, 'id' | 'fingerprint'>,
  b: Pick<CodexMcpCandidate, 'id' | 'fingerprint'>): 'unchanged' | 'changed' | 'different-server' {
  return a.id !== b.id ? 'different-server' : a.fingerprint === b.fingerprint ? 'unchanged' : 'changed';
}

/** Main-process-only matching of freshly read raw TOML to the same validated fingerprint. */
export async function fingerprintCodexMcpRow(name: string, row: unknown, source: CodexMcpSource,
  sourcePath: string, projectRoot?: string): Promise<Pick<CodexMcpCandidate, 'id' | 'fingerprint'>> {
  const checked = await candidate(name, row, source, sourcePath, projectRoot);
  return { id: checked.id, fingerprint: checked.fingerprint };
}
