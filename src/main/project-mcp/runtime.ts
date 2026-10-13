import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';
import { rawPromises as fs } from '../rawfs.js';
import { terminateProcessTree } from '../exec.js';
import { pluginEnvironment } from '../plugins/installer.js';
import { envValue, setEnvValue } from '../env.js';
import { redactSecretText } from '../redaction.js';
import { getConfig, onConfigPublished } from '../config.js';
import { isContained, nativePathIdentity, resolvePath } from '../sandbox.js';
import { evaluateCommandAllowlistArgs } from '../../shared/command-allowlist.js';
import { loadProjectMcpConfig, type ProjectMcpServerConfig } from './config.js';
import type { ToolResult } from '../mcp/kernel.js';

interface LiveServer { client: Client; transport?: StdioClientTransport; tools: Tool[] }
interface ConnectingServer { client: Client; transport?: StdioClientTransport }
interface ServerState { config: ProjectMcpServerConfig; projectRoot: string; live?: LiveServer; pending?: Promise<LiveServer>; connecting?: ConnectingServer; retired: boolean; retirementPids?: number[] }
interface CatalogTool { id: string; server: string; tool: Tool }
interface ProjectState { fingerprint: string; workspace: string; servers: Map<string, ServerState>; catalog: Map<string, CatalogTool> }

const MAX_TOOLS = 256;
const MAX_SCHEMA_BYTES = 1_000_000;
const MAX_PROJECT_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULT_BYTES = 512 * 1024;
const MAX_PARALLEL_DISCOVERY = 8;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

async function mapConcurrent<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}
const boundedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: 'error' });
  if (!response.body) return response;
  let size = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > 16 * 1024 * 1024) throw new Error('Project MCP HTTP response exceeds 16 MiB');
      controller.enqueue(chunk);
    }
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

function configuredSecrets(config: ProjectMcpServerConfig): string[] {
  const values: string[] = [];
  const secretKey = /(?:auth|credential|password|passphrase|secret|token|api[_-]?key)/i;
  for (const [key, value] of Object.entries(config.env)) if (secretKey.test(key) && value.length >= 4) values.push(value);
  for (const key of config.envVars) {
    const value = envValue(process.env, key);
    if (value && value.length >= 4) values.push(value);
  }
  for (const [key, value] of Object.entries(config.httpHeaders)) if (secretKey.test(key) && value.length >= 4) values.push(value);
  for (const envName of Object.values(config.envHttpHeaders)) {
    const value = envValue(process.env, envName);
    if (value && value.length >= 4) values.push(value);
  }
  if (config.bearerTokenEnvVar) {
    const value = envValue(process.env, config.bearerTokenEnvVar);
    if (value && value.length >= 4) values.push(value);
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function redactText(text: string, secrets: readonly string[] = []): string {
  let out = redactSecretText(text);
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(entry => redactValue(entry, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    redactText(key, secrets), redactValue(entry, secrets)
  ]));
  return value;
}

function redactResult(result: CallToolResult, secrets: readonly string[]): CallToolResult {
  return {
    ...result,
    ...(result.structuredContent === undefined ? {} : { structuredContent: redactValue(result.structuredContent, secrets) as Record<string, unknown> }),
    ...(result._meta === undefined ? {} : { _meta: redactValue(result._meta, secrets) as Record<string, unknown> }),
    content: result.content.map(block => {
      const metadata = '_meta' in block ? { _meta: redactValue(block._meta, secrets) as Record<string, unknown> } : {};
      if (block.type === 'text') return { ...block, ...metadata, text: redactText(block.text, secrets) };
      if (block.type === 'resource') return {
        ...block, ...metadata,
        resource: {
          ...block.resource,
          ...('_meta' in block.resource ? { _meta: redactValue(block.resource._meta, secrets) as Record<string, unknown> } : {}),
          uri: redactText(block.resource.uri, secrets),
          ...('text' in block.resource ? { text: redactText(block.resource.text, secrets) } : {})
        }
      };
      if (block.type === 'resource_link') return {
        ...block, ...metadata, name: redactText(block.name, secrets), uri: redactText(block.uri, secrets),
        ...(block.title === undefined ? {} : { title: redactText(block.title, secrets) }),
        ...(block.description === undefined ? {} : { description: redactText(block.description, secrets) })
      };
      return { ...block, ...metadata };
    })
  };
}

async function closeLive(live: LiveServer | undefined): Promise<void> {
  if (!live) return;
  if (live.transport?.pid) await terminateProcessTree(live.transport.pid, true).catch(() => undefined);
  await live.client.close().catch(() => undefined);
}

async function retireServer(server: ServerState): Promise<void> {
  server.retired = true;
  const connecting = server.connecting;
  const pids = [...new Set([
    ...(server.retirementPids ?? []), connecting?.transport?.pid, server.live?.transport?.pid
  ].filter((pid): pid is number => typeof pid === 'number' && pid > 0))];
  // Preserve the original process identities until tree termination is confirmed.
  // A fallback parent-only kill on Windows is not proof grandchildren stopped.
  server.retirementPids = pids;
  const stopped = await Promise.allSettled(pids.map(pid => terminateProcessTree(pid, true, 1000, true)));
  await Promise.allSettled([
    ...(connecting ? [connecting.client.close()] : []),
    ...(server.live ? [server.live.client.close()] : [])
  ]);
  if (server.pending) await server.pending.catch(() => undefined);
  let alive = false;
  for (const pid of pids) {
    let gone = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { gone = true; break; }
      }
      if (attempt === 9) break;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    if (!gone) alive = true;
  }
  if (alive || stopped.some(result => result.status === 'rejected')) {
    throw new Error('MCP_RETIRE_INCOMPLETE: The downstream process tree could not be confirmed stopped.');
  }
  server.retirementPids = [];
  server.live = undefined;
}

function privateIp(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  const version = net.isIP(host);
  if (version === 4) {
    const [a = -1, b = -1] = host.split('.').map(Number);
    return a === 10 || (a === 127) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (version === 6) {
    const lower = host.toLowerCase();
    return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  return hostname.toLowerCase() === 'localhost';
}

function safeUrl(value: string): URL {
  const url = new URL(value);
  if (!privateIp(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Project MCP URLs must target localhost/private LAN over HTTP(S), without URL credentials, query tokens or fragments; use the managed Plugins connector for public remote MCPs');
  }
  return url;
}

/**
 * Pin a bare Windows command to the safe inherited PATH before cross-spawn sees the project cwd.
 * `which`, which cross-spawn uses, checks cwd first on Windows; leaving `npx` bare would therefore
 * let `<project>/npx.cmd` shadow the package manager after the allowlist had already admitted npx.
 * Explicit relative/absolute paths remain explicit and are not rewritten here.
 */
export async function resolveProjectMcpWindowsCommand(
  command: string,
  projectRoot: string,
  environment: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  if (platform !== 'win32' || /[\\/]/.test(command) || /^[A-Za-z]:/.test(command)) return command;
  const search = envValue(environment, 'PATH') ?? '';
  const pathExt = (envValue(environment, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM')
    .split(';').map(value => value.trim()).filter(Boolean);
  const suffixes = command.includes('.') ? ['', ...pathExt] : pathExt;
  for (const rawDirectory of search.split(';')) {
    const trimmed = rawDirectory.trim();
    const directory = /^".*"$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
    // A relative PATH entry would make resolution project-cwd dependent again.
    if (!directory || !path.win32.isAbsolute(directory)) continue;
    for (const suffix of suffixes) {
      const candidate = path.win32.join(directory, `${command}${suffix}`);
      try {
        const real = await fs.realpath(candidate);
        if (!(await fs.stat(real)).isFile()) continue;
        if (isContained(projectRoot, real)) {
          throw new Error('COMMAND_NOT_ALLOWED: A bare project MCP command resolved inside the selected project. Use an explicit path and matching command-policy rule if project-local executable code is intended.');
        }
        return real;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('COMMAND_NOT_ALLOWED:')) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
    }
  }
  throw new Error(`COMMAND_NOT_FOUND: Bare project MCP command ${JSON.stringify(command)} was not found on the safe inherited PATH.`);
}

export class ProjectMcpManager {
  private projects = new Map<string, ProjectState>();
  private retiring = new Set<ServerState>();
  private prepareTails = new Map<string, Promise<void>>();
  private searchTails = new Map<string, Promise<void>>();
  private closing = false;
  private revision = 0;
  private unsubscribeConfig: () => void;

  constructor(private userConfigPath: string | null | undefined = undefined) {
    this.unsubscribeConfig = onConfigPublished((next, previous) => this.settingsChanged(next, previous));
  }

  private async retireServers(servers: readonly ServerState[]): Promise<void> {
    for (const server of servers) { server.retired = true; this.retiring.add(server); }
    const results = await Promise.allSettled([...this.retiring].map(async server => {
      await retireServer(server);
      this.retiring.delete(server);
    }));
    if (results.some(result => result.status === 'rejected')) {
      throw new Error('MCP_RETIRE_INCOMPLETE: One or more managed MCP processes could not be confirmed stopped.');
    }
  }

  private async settingsChanged(next: ReturnType<typeof getConfig>, previous: ReturnType<typeof getConfig>): Promise<void> {
    const policyChanged = JSON.stringify(next.commandAllowlist) !== JSON.stringify(previous.commandAllowlist);
    const authorityChanged = next.readOnly !== previous.readOnly ||
      next.capabilities.read !== previous.capabilities.read ||
      next.capabilities.command !== previous.capabilities.command;
    const rootsChanged = JSON.stringify(next.roots) !== JSON.stringify(previous.roots);
    if (!policyChanged && !authorityChanged && !rootsChanged && !this.retiring.size) return;
    if (policyChanged || authorityChanged || rootsChanged) this.revision++;
    const retiring: ProjectState[] = [];
    for (const [id, state] of this.projects) {
      let revoked = policyChanged || authorityChanged;
      if (rootsChanged && !revoked) {
        const resolved = await resolvePath(next.roots, state.workspace).catch(() => null);
        revoked = !resolved || nativePathIdentity(resolved.real) !== nativePathIdentity(state.workspace);
      }
      if (revoked) { this.projects.delete(id); retiring.push(state); }
    }
    await this.retireServers(retiring.flatMap(state => [...state.servers.values()]));
  }

  private assertCommandPolicy(server: ServerState): void {
    if (server.config.transport !== 'stdio') return;
    const policy = getConfig().commandAllowlist;
    const decision = evaluateCommandAllowlistArgs(policy, [server.config.command ?? '', ...server.config.args]);
    if (!decision.allowed) throw new Error(`COMMAND_NOT_ALLOWED: ${decision.detail} No project MCP tool was invoked.`);
    if (policy.enabled && server.config.projectEnvironment) {
      throw new Error('COMMAND_NOT_ALLOWED: Project MCP environment overrides are disabled while the command allowlist is enabled.');
    }
  }

  setUserConfigPathForTest(pathValue: string | null | undefined): void {
    if (this.projects.size || this.prepareTails.size || this.searchTails.size) throw new Error('Project MCP runtime is already active');
    this.userConfigPath = pathValue;
  }

  private async prepare(projectId: string, workspace: string): Promise<ProjectState> {
    if (this.closing) throw new Error('Project MCP runtimes are shutting down');
    const previousTail = this.prepareTails.get(projectId) ?? Promise.resolve();
    let resolveTail!: () => void;
    const tail = new Promise<void>(resolve => { resolveTail = resolve; });
    const currentTail = previousTail.catch(() => undefined).then(() => tail);
    this.prepareTails.set(projectId, currentTail);
    await previousTail.catch(() => undefined);
    const expectedRevision = this.revision;
    try {
      if (this.closing || expectedRevision !== this.revision) {
        throw new Error('Project MCP authorization changed while preparing the server registry');
      }
      const loaded = await loadProjectMcpConfig(workspace, { userConfigPath: this.userConfigPath });
      if (expectedRevision !== this.revision) throw new Error('Project MCP authorization changed while loading configuration');
      const fingerprint = hash(JSON.stringify({ servers: loaded.servers, commandAllowlist: getConfig().commandAllowlist }));
      const previous = this.projects.get(projectId);
      if (previous?.fingerprint === fingerprint && previous.workspace === workspace) return previous;
      if (previous) await this.retireServers([...previous.servers.values()]);
      if (this.closing || expectedRevision !== this.revision) {
        throw new Error('Project MCP authorization changed before publishing the server registry');
      }
      const next: ProjectState = {
        fingerprint, workspace,
        servers: new Map(loaded.servers.map(config => [config.name, { config, projectRoot: workspace, retired: false }])),
        catalog: new Map()
      };
      this.projects.set(projectId, next);
      return next;
    } finally {
      resolveTail();
      if (this.prepareTails.get(projectId) === currentTail) this.prepareTails.delete(projectId);
    }
  }

  private async discover(client: Client, config: ProjectMcpServerConfig): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    const deadline = Date.now() + config.startupTimeoutMs;
    do {
      if (Date.now() >= deadline) throw new Error(`Project MCP ${config.name} discovery timed out`);
      const page = await client.request(
        { method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) },
        { timeout: Math.max(1, Math.min(15_000, deadline - Date.now())) }
      );
      tools.push(...page.tools);
      if (tools.length > MAX_TOOLS || Buffer.byteLength(JSON.stringify(tools)) > MAX_SCHEMA_BYTES) throw new Error(`Project MCP ${config.name} exposes too many tools`);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error(`Project MCP ${config.name} repeated a tool cursor`);
      if (cursor) seen.add(cursor);
    } while (cursor);
    const allowed = tools.filter(tool =>
      (!config.enabledTools || config.enabledTools.includes(tool.name)) && !config.disabledTools.includes(tool.name)
    );
    if (new Set(allowed.map(tool => tool.name)).size !== allowed.length) throw new Error(`Project MCP ${config.name} declares duplicate tool names`);
    return allowed;
  }

  private toolId(projectId: string, fingerprint: string, server: string, tool: Tool): string {
    return `pmcp_${hash(`${projectId}\0${fingerprint}\0${server}\0${tool.name}\0${JSON.stringify(tool.inputSchema)}`).slice(0, 24)}`;
  }

  private async connect(server: ServerState): Promise<LiveServer> {
    if (this.closing || server.retired) throw new Error(`Project MCP ${server.config.name} configuration changed or is shutting down`);
    this.assertCommandPolicy(server);
    if (server.live) return server.live;
    if (server.pending) return server.pending;
    const pending = (async () => {
      const config = server.config;
      const client = new Client({ name: 'Chat On Steroids Project MCP', version: '1.0.0' });
      let transport: StdioClientTransport | undefined;
      server.connecting = { client };
      try {
        if (config.transport === 'stdio') {
          if (!config.command) throw new Error(`Project MCP ${config.name} has no command`);
          // Authorize exactly what the project declared. On Windows cross-spawn may execute the
          // common Node package-manager .cmd shims through cmd.exe; the tokenized policy matcher
          // treats bare npx/npm/etc. and their .cmd spellings as the same executable identity.
          const env = pluginEnvironment();
          const launchCommand = await resolveProjectMcpWindowsCommand(config.command, server.projectRoot, env);
          for (const key of config.envVars) {
            const value = envValue(process.env, key);
            if (value !== undefined) setEnvValue(env, key, value);
          }
          for (const [key, value] of Object.entries(config.env)) setEnvValue(env, key, value);
          transport = new StdioClientTransport({ command: launchCommand, args: config.args, cwd: config.cwd, env, stderr: 'ignore', maxBufferSize: 16 * 1024 * 1024 });
          server.connecting.transport = transport;
          this.assertCommandPolicy(server);
          if (server.retired || this.closing) throw new Error('Project MCP authorization changed before process launch');
          await client.connect(transport, { timeout: config.startupTimeoutMs });
        } else {
          if (!config.url) throw new Error(`Project MCP ${config.name} has no URL`);
          const headers = { ...config.httpHeaders };
          for (const [header, envName] of Object.entries(config.envHttpHeaders)) {
            const value = envValue(process.env, envName);
            if (value !== undefined) headers[header] = value;
          }
          const bearer = config.bearerTokenEnvVar ? envValue(process.env, config.bearerTokenEnvVar) : undefined;
          if (bearer) headers.Authorization = `Bearer ${bearer}`;
          await client.connect(new StreamableHTTPClientTransport(safeUrl(config.url), { fetch: boundedFetch, requestInit: { headers }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } }), { timeout: config.startupTimeoutMs });
        }
        const live = { client, transport, tools: await this.discover(client, config) };
        if (this.closing || server.retired) {
          await closeLive(live);
          throw new Error(`Project MCP ${config.name} configuration changed during discovery`);
        }
        server.live = live;
        return live;
      } catch (error) {
        if (transport?.pid) await terminateProcessTree(transport.pid, true).catch(() => undefined);
        await client.close().catch(() => undefined);
        throw error;
      } finally { server.pending = undefined; server.connecting = undefined; }
    })();
    server.pending = pending;
    return pending;
  }

  private async searchNow(projectId: string, workspace: string, query = '', serverName?: string,
    cached = false, compact = false, stillAuthorized?: () => Promise<boolean>): Promise<{ tools: CatalogTool[]; errors: string[] }> {
    const state = await this.prepare(projectId, workspace);
    if (stillAuthorized && !(await stillAuthorized())) {
      await this.retireIfRootRevoked(projectId, state);
      throw new Error('MCP_AUTH_REVOKED: Project or tool permission changed before discovery. No server was started.');
    }
    const errors: string[] = [];
    const servers = [...state.servers.values()].filter(server => server.config.enabled && (!serverName || server.config.name === serverName));
    const refreshed = new Set(servers.map(server => server.config.name));
    const nextCatalog = new Map(state.catalog);
    for (const [id, entry] of nextCatalog) if (refreshed.has(entry.server)) nextCatalog.delete(id);
    let catalogBytes = [...nextCatalog.values()].reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify({ id: entry.id, server: entry.server, tool: entry.tool })),
      0
    );
    const discoveries = await mapConcurrent(servers, MAX_PARALLEL_DISCOVERY, async server => {
      try {
        const wasLive = !!server.live;
        const live = await this.connect(server);
        // Cached searches are an opt-in catalog snapshot. Calls always revalidate tools/list
        // before dispatch, even when the model chose a cached search result.
        if (wasLive && !cached) live.tools = await this.discover(live.client, server.config);
        const discovered: CatalogTool[] = [];
        let discoveredBytes = 0;
        for (const tool of live.tools) {
          const id = this.toolId(projectId, state.fingerprint, server.config.name, tool);
          const entry = { id, server: server.config.name, tool };
          discovered.push(entry);
          discoveredBytes += Buffer.byteLength(JSON.stringify(entry));
        }
        return { server, discovered, discoveredBytes };
      } catch (error) {
        return { server, error };
      }
    });
    for (const discovery of discoveries) {
      if ('error' in discovery) {
        const detail = redactText(discovery.error instanceof Error ? discovery.error.message : String(discovery.error),
          configuredSecrets(discovery.server.config))
          .split(state.workspace).join('<project>');
        errors.push(`${discovery.server.config.name}: ${detail}`.slice(0, 600));
        continue;
      }
      if (catalogBytes + discovery.discoveredBytes > MAX_PROJECT_CATALOG_BYTES) {
        errors.push(`${discovery.server.config.name}: Project MCP catalog exceeds the 2 MiB project limit`);
        continue;
      }
      for (const entry of discovery.discovered) nextCatalog.set(entry.id, entry);
      catalogBytes += discovery.discoveredBytes;
    }
    if (stillAuthorized && !(await stillAuthorized())) {
      await this.retireIfRootRevoked(projectId, state);
      throw new Error('MCP_AUTH_REVOKED: Project or tool permission changed during discovery. No tools were returned.');
    }
    if (this.projects.get(projectId) !== state || [...state.servers.values()].some(server => server.retired)) {
      throw new Error('Project MCP authorization or configuration changed during discovery');
    }
    state.catalog = nextCatalog;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const tools = [...state.catalog.values()].filter(entry => {
      if (serverName && entry.server !== serverName) return false;
      const haystack = `${entry.server} ${entry.tool.name} ${entry.tool.description ?? ''}`.toLowerCase();
      return terms.length === 0 || terms.some(term => haystack.includes(term));
    });
    const bounded: CatalogTool[] = [];
    let bytes = 0;
    for (const entry of tools) {
      const size = Buffer.byteLength(JSON.stringify(compact
        ? { tool_id: entry.id, server: entry.server, name: entry.tool.name, description: entry.tool.description ?? '' }
        : { id: entry.id, server: entry.server, tool: entry.tool }));
      if (bounded.length >= 64 || bytes + size > MAX_SEARCH_RESULT_BYTES) break;
      bytes += size; bounded.push(entry);
    }
    return {
      tools: bounded.map(entry => {
        const config = state.servers.get(entry.server)?.config;
        const secrets = config ? configuredSecrets(config) : [];
        return { ...entry, tool: redactValue(entry.tool, secrets) as Tool };
      }),
      errors
    };
  }

  private async retireIfRootRevoked(projectId: string, state: ProjectState): Promise<void> {
    const resolved = await resolvePath(getConfig().roots, state.workspace).catch(() => null);
    if (resolved && nativePathIdentity(resolved.real) === nativePathIdentity(state.workspace)) return;
    if (this.projects.get(projectId) !== state) return;
    this.projects.delete(projectId);
    await this.retireServers([...state.servers.values()]);
  }

  async search(projectId: string, workspace: string, query = '', serverName?: string,
    cached = false, compact = false, stillAuthorized?: () => Promise<boolean>): Promise<{ tools: CatalogTool[]; errors: string[] }> {
    const previousTail = this.searchTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const currentTail = previousTail.catch(() => undefined).then(() => gate);
    this.searchTails.set(projectId, currentTail);
    await previousTail.catch(() => undefined);
    try {
      return await this.searchNow(projectId, workspace, query, serverName, cached, compact, stillAuthorized);
    } finally {
      release();
      if (this.searchTails.get(projectId) === currentTail) this.searchTails.delete(projectId);
    }
  }

  /** Describes the last searched catalog entry without another downstream tools/list request.
   * Calls still revalidate the live schema before dispatch, including silent changes.
   */
  async describe(projectId: string, workspace: string, toolId: string,
    stillAuthorized?: () => Promise<boolean>): Promise<CatalogTool | null> {
    const state = await this.prepare(projectId, workspace);
    if (stillAuthorized && !(await stillAuthorized())) {
      await this.retireIfRootRevoked(projectId, state);
      return null;
    }
    const entry = state.catalog.get(toolId);
    const config = entry && state.servers.get(entry.server)?.config;
    if (!entry || !config?.enabled) return null;
    return { ...entry, tool: redactValue(entry.tool, configuredSecrets(config)) as Tool };
  }

  async call(projectId: string, workspace: string, toolId: string, args: Record<string, unknown>,
    onResolved?: (server: string, tool: string) => void, beforeDispatch?: () => Promise<boolean>): Promise<ToolResult> {
    const state = await this.prepare(projectId, workspace);
    const entry = state.catalog.get(toolId);
    if (!entry) return errorResult('MCP_TOOL_STALE: Search this project MCP catalog again; the tool id is absent or its project/config changed. This call was not dispatched.');
    const server = state.servers.get(entry.server);
    if (!server?.config.enabled) return errorResult('MCP_SERVER_DISABLED: The project MCP server is disabled. This call was not dispatched.');
    try {
      if (beforeDispatch && !(await beforeDispatch())) {
        await this.retireIfRootRevoked(projectId, state);
        return errorResult('MCP_AUTH_REVOKED: Project or tool permission changed before connection. No tool was invoked.');
      }
      const live = await this.connect(server);
      live.tools = await this.discover(live.client, server.config);
      const current = live.tools.find(tool => tool.name === entry.tool.name);
      if (!current) return errorResult('MCP_TOOL_STALE: The server tool list changed. Search again before calling it. This call was not dispatched.');
      if (this.toolId(projectId, state.fingerprint, server.config.name, current) !== toolId) {
        return errorResult('MCP_TOOL_STALE: The server tool schema changed. Search again before calling it. This call was not dispatched.');
      }
      if (this.projects.get(projectId) !== state || server.retired || this.closing) {
        return errorResult('MCP_AUTH_REVOKED: Project MCP authorization changed before dispatch. No tool was invoked.');
      }
      this.assertCommandPolicy(server);
      if (beforeDispatch && !(await beforeDispatch())) {
        return errorResult('MCP_AUTH_REVOKED: Project or tool permission changed before dispatch. No tool was invoked.');
      }
      this.assertCommandPolicy(server);
      if (server.retired || this.projects.get(projectId) !== state) {
        return errorResult('MCP_AUTH_REVOKED: Project MCP authorization changed before dispatch. No tool was invoked.');
      }
      onResolved?.(entry.server, current.name);
      const result = await live.client.callTool({ name: current.name, arguments: args }, { timeout: server.config.toolTimeoutMs, toolDefinition: current });
      if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024) return errorResult('MCP_RESULT_TOO_LARGE: The project MCP result exceeds 16 MiB. Request a smaller result.');
      for (const block of result.content) if (block.type === 'image') {
        const data = Buffer.from(block.data, 'base64');
        const info = await sharp(data, { limitInputPixels: 36_000_000 }).metadata();
        if (!info.width || !info.height || info.width * info.height > 36_000_000) return errorResult('MCP_IMAGE_TOO_LARGE: Image exceeds the decoded-pixel limit.');
        if (block.mimeType !== `image/${info.format === 'svg' ? 'svg+xml' : info.format}`) return errorResult('MCP_IMAGE_INVALID: Image MIME type does not match its decoded content.');
      }
      return redactResult(result, configuredSecrets(server.config)) as ToolResult;
    } catch {
      await closeLive(server.live);
      server.live = undefined;
      return errorResult('MCP_CALL_FAILED: The project MCP server failed or disconnected. The operation may have completed; inspect its state before retrying. CoS did not retry.');
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.unsubscribeConfig();
    const servers = [...this.projects.values()].flatMap(project => [...project.servers.values()]);
    this.projects.clear();
    this.searchTails.clear();
    await this.retireServers(servers);
  }
}

export const projectMcpManager = new ProjectMcpManager();
