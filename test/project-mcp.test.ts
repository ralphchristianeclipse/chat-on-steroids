import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DIR_LINK, IS_WINDOWS, makeTempDir, removeTempDir } from './helpers.js';
import { loadProjectMcpConfig } from '../src/main/project-mcp/config.js';
import { ProjectMcpManager, resolveProjectMcpWindowsCommand } from '../src/main/project-mcp/runtime.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';

const fixture = `const readline=require('node:readline');const fs=require('node:fs');
const tools=()=>{const changed=process.env.PROJECT_MCP_SCHEMA&&fs.existsSync(process.env.PROJECT_MCP_SCHEMA);return[
 {name:'echo',description:'Echo a value',inputSchema:{type:'object',properties:{value:{type:changed?'number':'string'}},required:['value'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'blocked',description:'Filtered fixture',inputSchema:{type:'object'}},
 ...(process.env.PROJECT_MCP_LARGE_SCHEMAS?Array.from({length:64},(_,i)=>({name:'large_'+i,description:'Large schema fixture',inputSchema:{type:'object',properties:{payload:{type:'string',description:'x'.repeat(9000)}}}})):[]),
 ...(process.env.PROJECT_MCP_DYNAMIC&&fs.existsSync(process.env.PROJECT_MCP_DYNAMIC)?[{name:'dynamic',description:'Appears after marker creation',inputSchema:{type:'object'}}]:[])
]};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'project fixture',version:'1'}};
else if(m.method==='tools/list'){if(process.env.PROJECT_MCP_LIST_COUNT_FILE)fs.appendFileSync(process.env.PROJECT_MCP_LIST_COUNT_FILE,'x');result={tools:tools()};}
else if(m.method==='tools/call')result={content:[{type:'text',text:(process.env.PROJECT_MCP_INCLUDE_CWD?process.cwd()+'|env='+(process.env.PROJECT_MCP_VALUE?'set':'missing')+'|':(process.env.PROJECT_MCP_TOKEN||process.env.PROJECT_MCP_VALUE||''))+m.params.arguments.value}]};
else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;

const barrierFixture = `const readline=require('node:readline');const fs=require('node:fs');const path=require('node:path');
const reply=(m,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize')return reply(m,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'barrier fixture',version:'1'}});
if(m.method==='tools/list'){const dir=process.env.PROJECT_MCP_BARRIER_DIR;fs.writeFileSync(path.join(dir,process.env.PROJECT_MCP_BARRIER_ID),'1');
const timer=setInterval(()=>{if(fs.readdirSync(dir).length<2)return;clearInterval(timer);reply(m,{tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'}}]});},10);return;}
if(m.method==='tools/call')return reply(m,{content:[{type:'text',text:'ok'}]});reply(m,{});});`;

let directory: string, entry: string, manager: ProjectMcpManager;
beforeEach(async () => {
  directory = await makeTempDir('cos-project-mcp-');
  entry = path.join(directory, 'server.cjs');
  await fs.writeFile(entry, fixture);
  initConfigPath(directory);
  await saveConfig(defaultConfig());
  manager = new ProjectMcpManager(null);
});
afterEach(async () => {
  await manager.close();
  await removeTempDir(directory);
});

describe('project MCP config', () => {
  it('loads only the exact project root and overlays .codex/config.toml after .mcp.json', async () => {
    const child = path.join(directory, 'child');
    await fs.mkdir(path.join(child, '.codex'), { recursive: true });
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      parentOnly: { command: process.execPath, args: [entry] }
    } }));
    expect((await loadProjectMcpConfig(child, { userConfigPath: null })).servers).toEqual([]);

    await fs.writeFile(path.join(child, '.mcp.json'), JSON.stringify({ mcpServers: {
      alpha: { command: process.execPath, args: [entry], env: { A: '${workspaceFolder}' }, disabledTools: ['blocked'], startupTimeoutMs: 15000 },
      sensitive: { url: 'https://first.example/mcp', httpHeaders: { Authorization: 'Bearer SECRET' } },
      filesystem: { command: process.execPath, args: [entry] }
    } }));
    await fs.writeFile(path.join(child, '.codex', 'config.toml'), [
      '[mcp_servers.alpha]',
      'tool_timeout_sec = 7',
      '',
      '[mcp_servers.sensitive]',
      'url = "https://second.example/mcp"',
      '',
      '[mcp_servers.dbcode]',
      'url = "http://192.168.0.235:5003/mcp"',
      'enabled = true'
    ].join('\n'));
    const loaded = await loadProjectMcpConfig(child, { userConfigPath: null });
    const alpha = loaded.servers.find(server => server.name === 'alpha')!;
    expect(alpha).toMatchObject({ transport: 'stdio', args: [entry], cwd: child, toolTimeoutMs: 7000, startupTimeoutMs: 15000, disabledTools: ['blocked'] });
    expect(alpha.env.A).toBe(child);
    expect(alpha.sourcePaths).toHaveLength(2);
    expect(loaded.servers.find(server => server.name === 'sensitive')).toMatchObject({
      url: 'https://second.example/mcp', httpHeaders: {}, envHttpHeaders: {}, args: [], env: {}, cwd: child
    });
    expect(loaded.servers.find(server => server.name === 'dbcode')).toMatchObject({ transport: 'streamable_http', url: 'http://192.168.0.235:5003/mcp' });
    expect(loaded.servers.some(server => server.name.toLowerCase() === 'filesystem')).toBe(false);
  });

  it('fails closed on malformed restrictive fields and unsupported transports', async () => {
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      badEnabled: { command: process.execPath, args: [entry], enabled: 'false' },
      badAllowlist: { command: process.execPath, args: [entry], enabledTools: 'echo' },
      unsupported: { type: 'sse', url: 'https://example.com/mcp' }
    } }));
    await expect(loadProjectMcpConfig(directory, { userConfigPath: null })).rejects.toThrow(/invalid type|unsupported transport/i);
  });

  it('does not import arbitrary host environment variables from project config', async () => {
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env_vars: ['OPENAI_API_KEY'] }
    } }));
    await expect(loadProjectMcpConfig(directory, { userConfigPath: null })).rejects.toThrow(/env_vars is not supported/i);
  });

  it('refuses linked config and cwd paths that leave the selected project', async () => {
    const project = path.join(directory, 'project');
    const outside = path.join(directory, 'outside');
    await fs.mkdir(project);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'config.toml'), '[mcp_servers.escape]\nurl = "https://example.com/mcp"\n');
    await fs.symlink(outside, path.join(project, '.codex'), DIR_LINK);
    await expect(loadProjectMcpConfig(project, { userConfigPath: null })).rejects.toThrow(/leaves the selected project/i);

    await fs.rm(path.join(project, '.codex'), { recursive: true, force: true });
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: {
      escape: { command: process.execPath, args: [entry], cwd: outside }
    } }));
    await expect(loadProjectMcpConfig(project, { userConfigPath: null })).rejects.toThrow(/cwd leaves the selected project/i);
  });

  it('inherits trusted user MCPs before project overrides and binds default cwd to the selected project', async () => {
    const project = path.join(directory, 'project');
    const userConfig = path.join(directory, 'user-config.toml');
    await fs.mkdir(path.join(project, '.codex'), { recursive: true });
    await fs.writeFile(userConfig, [
      '[mcp_servers.serena]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(entry)}]`,
      'env_vars = [{ name = "PROJECT_MCP_VALUE", source = "local" }]',
      '',
      '[mcp_servers.serena.tools.blocked]',
      'approval_mode = "prompt"',
      '',
      '[mcp_servers.shared]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(entry)}]`,
      'tool_timeout_sec = 12',
      '',
      '[mcp_servers.limited]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(entry)}]`,
      'enabled_tools = ["echo"]',
      '',
      '[mcp_servers.disabledGlobal]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(entry)}]`,
      'enabled = false'
    ].join('\n'));
    await fs.writeFile(path.join(project, '.codex', 'config.toml'), [
      '[mcp_servers.shared]',
      'enabled = false',
      '',
      '[mcp_servers.limited]',
      'enabled_tools = ["blocked"]',
      '',
      '[mcp_servers.disabledGlobal]',
      'enabled = true',
      '',
      '[mcp_servers.dbcode]',
      'url = "http://192.168.0.235:5003/mcp"'
    ].join('\n'));

    const loaded = await loadProjectMcpConfig(project, { userConfigPath: userConfig });
    expect(loaded.sourcePaths).toEqual([userConfig, path.join(project, '.codex', 'config.toml')]);
    expect(loaded.servers.find(server => server.name === 'serena')).toMatchObject({
      command: process.execPath, args: [entry], cwd: project, envVars: ['PROJECT_MCP_VALUE'], projectEnvironment: false,
      disabledTools: ['blocked'], startupTimeoutMs: 30_000, toolTimeoutMs: 120_000
    });
    expect(loaded.servers.find(server => server.name === 'shared')).toMatchObject({ enabled: false, toolTimeoutMs: 12000, cwd: project });
    expect(loaded.servers.find(server => server.name === 'limited')).toMatchObject({ enabledTools: [], userEnabledTools: ['echo'] });
    expect(loaded.servers.find(server => server.name === 'disabledGlobal')).toMatchObject({ enabled: false, userDisabled: true });
    expect(loaded.servers.find(server => server.name === 'dbcode')).toMatchObject({ transport: 'streamable_http', url: 'http://192.168.0.235:5003/mcp', startupTimeoutMs: 10_000 });
  });

  it('does not let project config mutate a trusted global launch without defining a full replacement', async () => {
    const project = path.join(directory, 'project-partial-launch');
    const userConfig = path.join(directory, 'user-partial-launch.toml');
    await fs.mkdir(path.join(project, '.codex'), { recursive: true });
    await fs.writeFile(userConfig, [
      '[mcp_servers.serena]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(entry)}]`,
      'env_vars = ["PROJECT_MCP_VALUE"]'
    ].join('\n'));
    await fs.writeFile(path.join(project, '.codex', 'config.toml'), [
      '[mcp_servers.serena]',
      'args = ["different"]'
    ].join('\n'));
    await expect(loadProjectMcpConfig(project, { userConfigPath: userConfig }))
      .rejects.toThrow(/restate command or url/i);
  });

  it('refuses trusted user MCP entries that require a remote execution environment', async () => {
    const project = path.join(directory, 'project-remote-env');
    const userConfig = path.join(directory, 'user-remote-env.toml');
    await fs.mkdir(project);
    await fs.writeFile(userConfig, [
      '[mcp_servers.remoteOnly]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(entry)}]`,
      'env_vars = [{ name = "REMOTE_SECRET", source = "remote" }]'
    ].join('\n'));
    await expect(loadProjectMcpConfig(project, { userConfigPath: userConfig }))
      .rejects.toThrow(/remote environment imports/i);
  });

  it('drops inherited host environment when project config rebinds a global server launch', async () => {
    const project = path.join(directory, 'project-rebind');
    const userConfig = path.join(directory, 'user-rebind.toml');
    await fs.mkdir(project);
    await fs.writeFile(userConfig, [
      '[mcp_servers.shared]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(entry)}]`,
      'env_vars = ["PROJECT_MCP_VALUE"]'
    ].join('\n'));
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: {
      shared: { command: process.execPath, args: [entry], env: { PROJECT_MCP_VALUE: 'project:' } }
    } }));
    const loaded = await loadProjectMcpConfig(project, { userConfigPath: userConfig });
    expect(loaded.servers.find(server => server.name === 'shared')).toMatchObject({
      envVars: [], env: { PROJECT_MCP_VALUE: 'project:' }, projectEnvironment: true
    });
  });
});

describe('project MCP runtime', () => {
  it.runIf(IS_WINDOWS)('pins bare Windows commands to safe PATH instead of a project-cwd shadow', async () => {
    const project = path.join(directory, 'shadow-project');
    const configuredCwd = path.join(project, 'nested-cwd');
    const safeBin = path.join(directory, 'safe-bin');
    await fs.mkdir(configuredCwd, { recursive: true });
    await fs.mkdir(safeBin);
    await fs.writeFile(path.join(project, 'npx.cmd'), '@echo project-shadow');
    const safeShim = path.join(safeBin, 'npx.cmd');
    await fs.writeFile(safeShim, '@echo safe-npx');
    const resolved = await resolveProjectMcpWindowsCommand('npx', project, { PATH: safeBin, PATHEXT: '.EXE;.CMD;.BAT;.COM' }, 'win32');
    expect(await fs.realpath(resolved)).toBe(await fs.realpath(safeShim));
    // The shadow is outside the configured cwd but still inside the selected project. Project
    // scope, not cwd scope, owns the trust boundary.
    await expect(resolveProjectMcpWindowsCommand('npx', project, { PATH: project, PATHEXT: '.CMD' }, 'win32'))
      .rejects.toThrow(/resolved inside the selected project/i);
  });

  it('discovers lazily, filters tools, calls by opaque project id and invalidates ids after config changes', async () => {
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_MCP_VALUE: 'project:' }, disabledTools: ['blocked'] }
    } }));
    const first = await manager.search('project-a', directory, 'echo');
    expect(first.errors).toEqual([]);
    expect(first.tools).toHaveLength(1);
    expect(first.tools[0]).toMatchObject({ server: 'local', tool: { name: 'echo' } });
    expect(first.tools[0]!.id).toMatch(/^pmcp_[0-9a-f]{24}$/);
    const described = await manager.describe('project-a', directory, first.tools[0]!.id);
    expect(described).toMatchObject({ server: 'local', tool: { name: 'echo', inputSchema: { type: 'object' } } });
    const called = await manager.call('project-a', directory, first.tools[0]!.id, { value: 'hello' });
    expect(called.isError).toBeFalsy();
    expect(called.content).toEqual([{ type: 'text', text: 'project:hello' }]);

    const other = await manager.search('project-b', directory, 'echo');
    expect(other.tools[0]!.id).not.toBe(first.tools[0]!.id);
    expect(await manager.describe('project-b', directory, first.tools[0]!.id)).toBeNull();
    expect((await manager.call('project-b', directory, first.tools[0]!.id, { value: 'wrong' })).isError).toBe(true);

    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_MCP_VALUE: 'changed:' }, disabledTools: ['blocked'] }
    } }));
    expect((await manager.call('project-a', directory, first.tools[0]!.id, { value: 'stale' })).content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('MCP_TOOL_STALE') });
    expect(await manager.describe('project-a', directory, first.tools[0]!.id)).toBeNull();
    const refreshed = await manager.search('project-a', directory, 'echo');
    expect(refreshed.tools[0]!.id).not.toBe(first.tools[0]!.id);
    expect((await manager.call('project-a', directory, refreshed.tools[0]!.id, { value: 'ok' })).content).toEqual([{ type: 'text', text: 'changed:ok' }]);
  });

  it('treats multi-word search terms as alternatives instead of requiring every word', async () => {
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_MCP_VALUE: 'project:' } }
    } }));
    const found = await manager.search('project-a', directory, 'missing echo unrelated');
    expect(found.errors).toEqual([]);
    expect(found.tools.map(entry => entry.tool.name)).toContain('echo');
  });

  it('reuses a warm catalog for opt-in cached searches but revalidates before execution', async () => {
    const counter = path.join(directory, 'list-count');
    const schemaMarker = path.join(directory, 'schema-changed');
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: {
        PROJECT_MCP_LIST_COUNT_FILE: counter, PROJECT_MCP_SCHEMA: schemaMarker
      } }
    } }));
    const first = await manager.search('project-a', directory, 'echo');
    expect(await fs.readFile(counter, 'utf8')).toBe('x');
    const warm = await manager.search('project-a', directory, 'echo', undefined, true);
    expect(warm.tools[0]!.id).toBe(first.tools[0]!.id);
    expect(await fs.readFile(counter, 'utf8')).toBe('x');
    await fs.writeFile(schemaMarker, 'changed');
    const stale = await manager.call('project-a', directory, first.tools[0]!.id, { value: 'old' });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain('MCP_TOOL_STALE');
    expect(await fs.readFile(counter, 'utf8')).toBe('xx');
  });

  it('bounds compact search by displayed fields instead of hidden tool schemas', async () => {
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_MCP_LARGE_SCHEMAS: '1' } }
    } }));
    const full = await manager.search('project-a', directory, 'large_');
    const concise = await manager.search('project-a', directory, 'large_', undefined, true, true);
    expect(full.errors).toEqual([]);
    expect(full.tools.length).toBeLessThan(64);
    expect(concise.errors).toEqual([]);
    expect(concise.tools).toHaveLength(64);
  });

  it('discovers independent project MCP servers concurrently', async () => {
    const barrier = path.join(directory, 'barrier');
    const barrierEntry = path.join(directory, 'barrier-server.cjs');
    await fs.mkdir(barrier);
    await fs.writeFile(barrierEntry, barrierFixture);
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      alpha: { command: process.execPath, args: [barrierEntry], startupTimeoutMs: 800,
        env: { PROJECT_MCP_BARRIER_DIR: barrier, PROJECT_MCP_BARRIER_ID: 'alpha' } },
      bravo: { command: process.execPath, args: [barrierEntry], startupTimeoutMs: 800,
        env: { PROJECT_MCP_BARRIER_DIR: barrier, PROJECT_MCP_BARRIER_ID: 'bravo' } }
    } }));
    const found = await manager.search('project-a', directory, 'echo');
    expect(found.errors).toEqual([]);
    expect(found.tools).toHaveLength(2);
  });

  it('launches inherited user MCPs from the selected project and imports only named host environment variables', async () => {
    const project = path.join(directory, 'global-project');
    const userConfig = path.join(directory, 'global-config.toml');
    await fs.mkdir(project);
    await fs.writeFile(userConfig, [
      '[mcp_servers.serena]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(entry)}]`,
      'env_vars = ["PROJECT_MCP_VALUE"]',
      '',
      '[mcp_servers.serena.env]',
      'PROJECT_MCP_INCLUDE_CWD = "1"'
    ].join('\n'));
    const previous = process.env.PROJECT_MCP_VALUE;
    process.env.PROJECT_MCP_VALUE = 'global:';
    const globalManager = new ProjectMcpManager(userConfig);
    try {
      const found = await globalManager.search('project-global', project, 'echo');
      expect(found.errors).toEqual([]);
      expect(found.tools).toHaveLength(1);
      const called = await globalManager.call('project-global', project, found.tools[0]!.id, { value: 'ok' });
      expect(called.content).toEqual([{ type: 'text', text: `${project}|env=set|ok` }]);
    } finally {
      await globalManager.close();
      if (previous === undefined) delete process.env.PROJECT_MCP_VALUE;
      else process.env.PROJECT_MCP_VALUE = previous;
    }
  });

  it('applies command policy before a repository-defined stdio process starts', async () => {
    await saveConfig({ ...defaultConfig(), commandAllowlist: { enabled: true, mode: 'allow', rules: [] } });
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry] }
    } }));
    const result = await manager.search('project-a', directory);
    expect(result.tools).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining('COMMAND_NOT_ALLOWED')]);
  });

  it('rejects public plain-HTTP endpoints before making a network request', async () => {
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      remote: { url: 'http://example.com/mcp' }
    } }));
    const result = await manager.search('project-a', directory);
    expect(result.tools).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining('localhost/private LAN')]);
  });

  it('does not mistake public DNS names beginning with private-IP text for private hosts', async () => {
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      remote: { url: 'http://10.attacker.example/mcp' }
    } }));
    const result = await manager.search('project-a', directory);
    expect(result.tools).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining('localhost/private LAN')]);
  });

  it('rejects project environment overrides when command allowlisting is active', async () => {
    await saveConfig({ ...defaultConfig(), commandAllowlist: { enabled: true, mode: 'allow', rules: [`${process.execPath} ${entry}`] } });
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { NODE_OPTIONS: '--require ./preload.js' } }
    } }));
    const result = await manager.search('project-a', directory);
    expect(result.tools).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining('environment overrides are disabled')]);
  });

  it('redacts configured secret-shaped environment values from downstream results', async () => {
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_MCP_TOKEN: 'secret-fixture-value' } }
    } }));
    const found = await manager.search('project-a', directory, 'echo');
    const called = await manager.call('project-a', directory, found.tools[0]!.id, { value: 'hello' });
    expect(called.content).toEqual([{ type: 'text', text: '[redacted]hello' }]);
  });

  it('refreshes a live server catalog when its advertised tools change', async () => {
    const marker = path.join(directory, 'dynamic.marker');
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_MCP_DYNAMIC: marker } }
    } }));
    expect((await manager.search('project-a', directory, 'dynamic')).tools).toEqual([]);
    await fs.writeFile(marker, 'ready');
    const refreshed = await manager.search('project-a', directory, 'dynamic');
    expect(refreshed.tools).toHaveLength(1);
    expect(refreshed.tools[0]!.tool.name).toBe('dynamic');
  });

  it('invalidates an opaque tool id when a live server changes that tool schema', async () => {
    const marker = path.join(directory, 'schema.marker');
    await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_MCP_SCHEMA: marker } }
    } }));
    const first = await manager.search('project-a', directory, 'echo');
    const firstId = first.tools[0]!.id;
    await fs.writeFile(marker, 'changed');
    const stale = await manager.call('project-a', directory, firstId, { value: 'old' });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('MCP_TOOL_STALE') });
    const refreshed = await manager.search('project-a', directory, 'echo');
    expect(refreshed.tools[0]!.id).not.toBe(firstId);
  });
});
