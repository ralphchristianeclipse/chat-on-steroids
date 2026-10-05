import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { rawPromises as fs } from '../rawfs.js';
import { envValue } from '../env.js';
import { isContained } from '../sandbox.js';

export interface ProjectMcpServerConfig {
  name: string;
  sourcePaths: string[];
  enabled: boolean;
  transport: 'stdio' | 'streamable_http';
  command?: string;
  args: string[];
  env: Record<string, string>;
  envVars: string[];
  projectEnvironment: boolean;
  trustedUserLaunch: boolean;
  userDisabled: boolean;
  userPolicyDisabledTools: string[];
  userEnabledTools?: string[];
  cwd: string;
  url?: string;
  bearerTokenEnvVar?: string;
  httpHeaders: Record<string, string>;
  envHttpHeaders: Record<string, string>;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  enabledTools?: string[];
  disabledTools: string[];
}

type Raw = Record<string, unknown>;
type ConfigSource = 'user' | 'project';
type Patch = Partial<Omit<ProjectMcpServerConfig, 'name' | 'sourcePaths'>> & {
  name: string;
  sourcePath: string;
  source: ConfigSource;
};
export interface ProjectMcpLoadOptions { userConfigPath?: string | null }
const MAX_CONFIG_BYTES = 256 * 1024;
const object = (value: unknown): Raw | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Raw : null;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined;
const envImports = (value: unknown): { names: string[]; remote: boolean } | undefined => {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  let remote = false;
  for (const item of value) {
    if (typeof item === 'string') {
      if (!item.trim()) return undefined;
      names.push(item.trim());
      continue;
    }
    const row = object(item);
    const name = row ? text(row.name) : undefined;
    const source = row ? text(row.source)?.toLowerCase() : undefined;
    if (!name || (source !== undefined && source !== 'local' && source !== 'remote')) return undefined;
    if (source === 'remote') remote = true;
    names.push(name);
  }
  return { names, remote };
};
const stringMap = (value: unknown): Record<string, string> | undefined => {
  const row = object(value);
  if (!row || !Object.values(row).every(item => typeof item === 'string')) return undefined;
  return row as Record<string, string>;
};
const milliseconds = (value: unknown, seconds = false): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(seconds ? value * 1000 : value, 10 * 60 * 1000);
};
const APPROVAL_MODES = new Set(['auto', 'prompt', 'writes', 'approve']);

function approvalRestrictions(raw: Raw): { disableServer: boolean; disabledTools: string[] } {
  const serverMode = text(raw.approval_mode ?? raw.approvalMode)?.toLowerCase();
  if (serverMode && !APPROVAL_MODES.has(serverMode)) throw new Error('Project MCP field approval_mode has an invalid value');
  const disabledTools: string[] = [];
  const tools = object(raw.tools);
  if (tools) for (const [name, value] of Object.entries(tools)) {
    const row = object(value);
    if (!row) continue;
    const mode = text(row.approval_mode ?? row.approvalMode)?.toLowerCase();
    if (mode && !APPROVAL_MODES.has(mode)) throw new Error(`Project MCP tool ${name} approval_mode has an invalid value`);
    if (mode && mode !== 'approve') disabledTools.push(name);
  }
  return { disableServer: !!serverMode && serverMode !== 'approve', disabledTools };
}

async function optional(file: string, workspace: string): Promise<string | null> {
  try {
    const real = await fs.realpath(file);
    if (!isContained(workspace, real)) throw new Error('Project MCP config leaves the selected project folder');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error(`Project MCP config must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes`);
    return await fs.readFile(real, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function optionalUserConfig(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
      throw new Error(`User MCP config must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes`);
    }
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function defaultProjectMcpUserConfigPath(): string {
  const configured = envValue(process.env, 'CODEX_HOME');
  const root = configured && path.isAbsolute(configured) ? configured : path.join(homedir(), '.codex');
  return path.join(root, 'config.toml');
}

function present(raw: Raw, ...keys: string[]): boolean {
  return keys.some(key => Object.prototype.hasOwnProperty.call(raw, key));
}

function requireType(condition: boolean, name: string): void {
  if (!condition) throw new Error(`Project MCP field ${name} has an invalid type`);
}

function expand(value: string, workspace: string): string {
  const expanded = value.replace(/\$\{workspace(?:Folder|Root)\}/g, workspace);
  if (/\$\{[^}]+\}/.test(expanded)) {
    throw new Error('Project MCP process-environment interpolation is not supported; use explicit project values or a managed Plugin credential');
  }
  return expanded;
}

function serverPatch(name: string, raw: Raw, sourcePath: string, workspace: string, source: ConfigSource): Patch | null {
  if (name.toLowerCase() === 'filesystem') return null;
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Project MCP server name is invalid');
  if (present(raw, 'command')) requireType(text(raw.command) !== undefined, 'command');
  if (present(raw, 'url')) requireType(text(raw.url) !== undefined, 'url');
  if (present(raw, 'cwd')) requireType(text(raw.cwd) !== undefined, 'cwd');
  if (present(raw, 'enabled')) requireType(bool(raw.enabled) !== undefined, 'enabled');
  if (present(raw, 'disabled')) requireType(bool(raw.disabled) !== undefined, 'disabled');
  if (present(raw, 'args')) requireType(strings(raw.args) !== undefined, 'args');
  if (present(raw, 'env')) requireType(stringMap(raw.env) !== undefined, 'env');
  if (present(raw, 'env_vars', 'envVars')) {
    if (source === 'project') throw new Error('Project MCP env_vars is not supported because repository config must not import arbitrary host secrets');
    const imports = envImports(raw.env_vars ?? raw.envVars);
    requireType(imports !== undefined, 'env_vars');
    if (imports?.remote) throw new Error(`Project MCP ${name} uses remote environment imports, which CoS cannot execute as a local project MCP`);
  }
  if (present(raw, 'experimental_environment')) {
    if (source === 'project') throw new Error('Project MCP experimental_environment is not supported in repository config');
    const environment = text(raw.experimental_environment)?.toLowerCase();
    requireType(environment === 'local' || environment === 'remote', 'experimental_environment');
    if (environment === 'remote') throw new Error(`Project MCP ${name} requires a remote execution environment, which CoS cannot provide`);
  }
  if (present(raw, 'http_headers', 'httpHeaders')) requireType(stringMap(raw.http_headers ?? raw.httpHeaders) !== undefined, 'http_headers');
  if (present(raw, 'env_http_headers', 'envHttpHeaders')) {
    if (source === 'project') throw new Error('Project MCP env_http_headers is not supported because repository config must not import arbitrary host secrets');
    requireType(stringMap(raw.env_http_headers ?? raw.envHttpHeaders) !== undefined, 'env_http_headers');
  }
  if (present(raw, 'bearer_token_env_var', 'bearerTokenEnvVar')) {
    if (source === 'project') throw new Error('Project MCP bearer_token_env_var is not supported because repository config must not import arbitrary host secrets');
    requireType(text(raw.bearer_token_env_var ?? raw.bearerTokenEnvVar) !== undefined, 'bearer_token_env_var');
  }
  if (present(raw, 'enabled_tools', 'enabledTools')) requireType(strings(raw.enabled_tools ?? raw.enabledTools) !== undefined, 'enabled_tools');
  if (present(raw, 'disabled_tools', 'disabledTools')) requireType(strings(raw.disabled_tools ?? raw.disabledTools) !== undefined, 'disabled_tools');
  const command = text(raw.command);
  const url = text(raw.url);
  const transportValue = text(raw.transport ?? raw.type)?.toLowerCase();
  let transport: ProjectMcpServerConfig['transport'] | undefined;
  if (transportValue) {
    if (transportValue === 'stdio') transport = 'stdio';
    else if (['streamable_http', 'streamable-http', 'http'].includes(transportValue)) transport = 'streamable_http';
    else throw new Error(`Project MCP ${name} uses unsupported transport ${transportValue}`);
  } else transport = url ? 'streamable_http' : command ? 'stdio' : undefined;
  const enabled = raw.disabled === true ? false : bool(raw.enabled);
  const configuredEnv = stringMap(raw.env) ?? {};
  const envVars = source === 'user' ? envImports(raw.env_vars ?? raw.envVars)?.names ?? [] : [];
  const env = { ...configuredEnv };
  const rawCwd = text(raw.cwd);
  const cwd = rawCwd ? expand(rawCwd, workspace) : undefined;
  const httpHeaders = stringMap(raw.http_headers ?? raw.httpHeaders);
  const envHttpHeaders = stringMap(raw.env_http_headers ?? raw.envHttpHeaders);
  const bearerTokenEnvVar = text(raw.bearer_token_env_var ?? raw.bearerTokenEnvVar);
  for (const [field, value] of [
    ['startup_timeout_ms', raw.startup_timeout_ms ?? raw.startupTimeoutMs],
    ['startup_timeout_sec', raw.startup_timeout_sec],
    ['tool_timeout_ms', raw.tool_timeout_ms ?? raw.toolTimeoutMs],
    ['tool_timeout_sec', raw.tool_timeout_sec]
  ] as const) if (value !== undefined) requireType(milliseconds(value, field.endsWith('_sec')) !== undefined, field);
  const startupTimeoutMs = milliseconds(raw.startup_timeout_ms ?? raw.startupTimeoutMs) ?? milliseconds(raw.startup_timeout_sec, true);
  const toolTimeoutMs = milliseconds(raw.tool_timeout_ms ?? raw.toolTimeoutMs) ?? milliseconds(raw.tool_timeout_sec, true);
  const enabledTools = strings(raw.enabled_tools ?? raw.enabledTools);
  const approval = approvalRestrictions(raw);
  const configuredDisabledTools = strings(raw.disabled_tools ?? raw.disabledTools) ?? [];
  const disabledTools = [...new Set([...configuredDisabledTools, ...approval.disabledTools])];
  const effectiveEnabled = approval.disableServer ? false : enabled;
  return {
    name, sourcePath, source, ...(transport ? { transport } : {}), ...(effectiveEnabled === undefined ? {} : { enabled: effectiveEnabled }),
    ...(command ? { command: expand(command, workspace) } : {}),
    ...(url ? { url: expand(url, workspace) } : {}),
    ...(strings(raw.args) ? { args: strings(raw.args)!.map(value => expand(value, workspace)) } : {}),
    ...(Object.keys(env).length ? { env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, expand(value, workspace)])) } : {}),
    ...(envVars.length ? { envVars } : {}),
    ...(source === 'project' && Object.keys(env).length ? { projectEnvironment: true } : {}),
    ...(source === 'user' ? {
      trustedUserLaunch: true,
      userDisabled: effectiveEnabled === false,
      userPolicyDisabledTools: disabledTools,
      ...(enabledTools ? { userEnabledTools: enabledTools } : {})
    } : {}),
    ...(cwd ? { cwd: path.isAbsolute(cwd) ? cwd : path.resolve(workspace, cwd) } : {}),
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
    ...(httpHeaders ? { httpHeaders } : {}),
    ...(envHttpHeaders ? { envHttpHeaders } : {}),
    ...(startupTimeoutMs ? { startupTimeoutMs } : {}),
    ...(toolTimeoutMs ? { toolTimeoutMs } : {}),
    ...(enabledTools ? { enabledTools } : {}),
    ...(disabledTools.length ? { disabledTools } : {})
  };
}

function patches(raw: unknown, key: 'mcpServers' | 'mcp_servers', sourcePath: string, workspace: string, source: ConfigSource): Patch[] {
  const root = object(raw);
  if (!root) throw new Error(`Project MCP config ${sourcePath} must be an object`);
  if (!present(root, key)) return [];
  const servers = object(root[key]);
  if (!servers) throw new Error(`Project MCP field ${key} must be an object`);
  if (Object.keys(servers).length > 64) throw new Error('Project MCP config defines more than 64 servers');
  return Object.entries(servers).flatMap(([name, value]) => {
    const row = object(value);
    if (!row) throw new Error(`Project MCP server ${name} must be an object`);
    const patch = serverPatch(name, row, sourcePath, workspace, source);
    return patch ? [patch] : [];
  });
}

export async function loadProjectMcpConfig(workspace: string, options: ProjectMcpLoadOptions = {}): Promise<{ servers: ProjectMcpServerConfig[]; sourcePaths: string[] }> {
  const workspaceReal = await fs.realpath(workspace);
  const registry = new Map<string, ProjectMcpServerConfig>();
  const sourcePaths: string[] = [];
  const apply = (items: Patch[]) => {
    for (const patch of items) {
      const previous = registry.get(patch.name);
      // A later source may be a partial override of an earlier server. A brand-new entry still
      // needs enough information to identify its transport; do not manufacture a broken stdio row.
      if (!previous && !patch.transport) continue;
      // Timeouts, enabled state and tool filters may layer onto the same launch. A later source
      // that names a new command or URL is a new launch/auth identity: never carry argv, cwd,
      // environment or HTTP credentials from the lower-precedence file to that new target.
      const launchMutation = patch.command !== undefined || patch.url !== undefined || patch.transport !== undefined ||
        patch.args !== undefined || patch.cwd !== undefined || patch.env !== undefined || patch.envVars !== undefined ||
        patch.httpHeaders !== undefined || patch.envHttpHeaders !== undefined || patch.bearerTokenEnvVar !== undefined;
      const projectLaunchMutation = patch.source === 'project' && !!previous?.trustedUserLaunch && launchMutation;
      if (projectLaunchMutation && !patch.command && !patch.url) {
        throw new Error(`Project MCP ${patch.name} changes launch or authentication fields inherited from the trusted user config; restate command or url to define a project-owned replacement`);
      }
      const rebind = !!previous && (projectLaunchMutation || !!patch.command || !!patch.url ||
        (!!patch.transport && patch.transport !== previous.transport));
      const base = rebind ? undefined : previous;
      const userDisabled = patch.source === 'user'
        ? patch.enabled === false
        : base?.userDisabled ?? false;
      const userPolicyDisabledTools = patch.source === 'user'
        ? patch.userPolicyDisabledTools ?? []
        : base?.userPolicyDisabledTools ?? [];
      const userEnabledTools = patch.source === 'user'
        ? patch.userEnabledTools
        : base?.userEnabledTools;
      const requestedEnabled = patch.enabled ?? base?.enabled ?? true;
      const disabledTools = [...new Set([
        ...userPolicyDisabledTools,
        ...(patch.disabledTools ?? base?.disabledTools ?? [])
      ])];
      registry.set(patch.name, {
        name: patch.name,
        sourcePaths: [...new Set([...(previous?.sourcePaths ?? []), patch.sourcePath])],
        enabled: userDisabled && patch.source === 'project' && !rebind ? false : requestedEnabled,
        transport: patch.transport ?? base?.transport ?? 'stdio',
        command: patch.command ?? base?.command,
        args: patch.args ?? base?.args ?? [],
        env: { ...(base?.env ?? {}), ...(patch.env ?? {}) },
        envVars: patch.envVars ?? base?.envVars ?? [],
        projectEnvironment: patch.projectEnvironment ?? base?.projectEnvironment ?? false,
        trustedUserLaunch: patch.source === 'user' ? true : base?.trustedUserLaunch ?? false,
        userDisabled,
        userPolicyDisabledTools,
        ...(userEnabledTools ? { userEnabledTools } : {}),
        cwd: patch.cwd ?? base?.cwd ?? workspaceReal,
        url: patch.url ?? base?.url,
        bearerTokenEnvVar: patch.bearerTokenEnvVar ?? base?.bearerTokenEnvVar,
        httpHeaders: { ...(base?.httpHeaders ?? {}), ...(patch.httpHeaders ?? {}) },
        envHttpHeaders: { ...(base?.envHttpHeaders ?? {}), ...(patch.envHttpHeaders ?? {}) },
        startupTimeoutMs: patch.startupTimeoutMs ?? base?.startupTimeoutMs ?? (patch.source === 'user' ? 30_000 : 10_000),
        toolTimeoutMs: patch.toolTimeoutMs ?? base?.toolTimeoutMs ?? (patch.source === 'user' ? 120_000 : 60_000),
        enabledTools: patch.source === 'project' && !rebind && userEnabledTools
          ? (patch.enabledTools ? patch.enabledTools.filter(name => userEnabledTools.includes(name)) : base?.enabledTools)
          : patch.enabledTools ?? base?.enabledTools,
        disabledTools
      });
    }
  };
  const userConfigPath = options.userConfigPath === undefined ? defaultProjectMcpUserConfigPath() : options.userConfigPath;
  if (userConfigPath) {
    const userToml = await optionalUserConfig(userConfigPath);
    if (userToml !== null) {
      apply(patches(parse(userToml), 'mcp_servers', userConfigPath, workspaceReal, 'user'));
      sourcePaths.push(userConfigPath);
    }
  }
  const jsonPath = path.join(workspaceReal, '.mcp.json');
  const json = await optional(jsonPath, workspaceReal);
  if (json !== null) { apply(patches(JSON.parse(json), 'mcpServers', jsonPath, workspaceReal, 'project')); sourcePaths.push(jsonPath); }
  const codexPath = path.join(workspaceReal, '.codex', 'config.toml');
  const toml = await optional(codexPath, workspaceReal);
  if (toml !== null) { apply(patches(parse(toml), 'mcp_servers', codexPath, workspaceReal, 'project')); sourcePaths.push(codexPath); }
  for (const server of registry.values()) {
    const cwdReal = await fs.realpath(server.cwd).catch(() => { throw new Error(`Project MCP ${server.name} cwd does not exist`); });
    if (!isContained(workspaceReal, cwdReal)) throw new Error(`Project MCP ${server.name} cwd leaves the selected project folder`);
    const stat = await fs.stat(cwdReal);
    if (!stat.isDirectory()) throw new Error(`Project MCP ${server.name} cwd is not a folder`);
    server.cwd = cwdReal;
  }
  return { servers: [...registry.values()], sourcePaths };
}
