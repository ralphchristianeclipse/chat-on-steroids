import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, getConfig, initConfigPath, onConfigPublished, saveConfig, updateConfig } from '../src/main/config.js';
import { ProjectMcpManager } from '../src/main/project-mcp/runtime.js';

const fixture = `const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const mark=name=>{const dir=process.env.PROJECT_MCP_TEST_DIR;if(dir)fs.appendFileSync(path.join(dir,name),'x');};
const tool={name:'echo',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}};
if(process.env.PROJECT_MCP_TEST_BEAT)setInterval(()=>mark('beat'),35);
const reply=(id,result,error)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize')return reply(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
if(m.method==='tools/list'){
  if(process.env.PROJECT_MCP_TEST_ERROR)return reply(m.id,null,{code:-32000,message:process.env.PROJECT_MCP_TOKEN});
  if(process.env.PROJECT_MCP_TEST_GATE&&fs.existsSync(process.env.PROJECT_MCP_TEST_GATE)){
    mark('waiting');const timer=setInterval(()=>{if(fs.existsSync(process.env.PROJECT_MCP_TEST_GATE))return;clearInterval(timer);reply(m.id,{tools:[tool]});},10);return;
  }
  return reply(m.id,{tools:[tool]});
}
if(m.method==='tools/call'){mark('called');return reply(m.id,{content:[{type:'text',text:'ok'}],structuredContent:{[process.env.PROJECT_MCP_TOKEN||'safe']:'secret-key'}});}
return reply(m.id,{});});`;

let directory: string, manager: ProjectMcpManager, entry: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-project-mcp-security-');
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

async function configure(env: Record<string, string> = {}): Promise<void> {
  await fs.writeFile(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: {
    local: { command: process.execPath, args: [entry], env: { PROJECT_MCP_TEST_DIR: directory, ...env } }
  } }));
}
async function waitFor(file: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await fs.stat(file).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

it('refuses and retires a warm MCP server after command policy tightens', async () => {
  await configure();
  const id = (await manager.search('project', directory)).tools[0]!.id;
  await saveConfig({ ...defaultConfig(), commandAllowlist: { enabled: true, mode: 'allow', rules: [] } });
  const result = await manager.call('project', directory, id, { value: 'blocked' });
  expect(result.isError).toBe(true);
  expect(await fs.stat(path.join(directory, 'called')).then(() => true, () => false)).toBe(false);
});

it('retires a running MCP process when the approved root is revoked', async () => {
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'project', path: directory }] });
  await configure({ PROJECT_MCP_TEST_BEAT: '1' });
  await manager.search('project', directory);
  const heartbeat = path.join(directory, 'beat');
  await waitFor(heartbeat);
  await saveConfig({ ...defaultConfig(), roots: [] });
  await new Promise(resolve => setTimeout(resolve, 100));
  const before = (await fs.readFile(heartbeat)).length;
  await new Promise(resolve => setTimeout(resolve, 180));
  expect((await fs.readFile(heartbeat)).length).toBe(before);
});

it('masks inherited secret values in discovery errors and JSON object keys', async () => {
  const token = 'fixture-credential-without-recognized-prefix';
  await configure({ PROJECT_MCP_TOKEN: token, PROJECT_MCP_TEST_ERROR: '1' });
  const result = await manager.search('project', directory);
  expect(result.errors).toHaveLength(1);
  expect(JSON.stringify(result.errors)).not.toContain(token);
  await configure({ PROJECT_MCP_TOKEN: token });
  const tools = await manager.search('project', directory);
  expect(tools.tools).toHaveLength(1);
  const called = await manager.call('project', directory, tools.tools[0]!.id, { value: 'ok' });
  expect(called.isError).toBeFalsy();
  expect(JSON.stringify(called.structuredContent)).not.toContain(token);
});

it('retains valid tool ids while another search is discovering', async () => {
  const gate = path.join(directory, 'gate');
  await configure({ PROJECT_MCP_TEST_GATE: gate });
  const found = await manager.search('project', directory);
  const id = found.tools[0]!.id;
  await fs.writeFile(gate, 'wait');
  const refreshing = manager.search('project', directory, '', undefined, false);
  await waitFor(path.join(directory, 'waiting'));
  try {
    expect(await manager.describe('project', directory, id)).not.toBeNull();
  } finally {
    await fs.rm(gate);
    await refreshing;
  }
});

it('aborts a search when folder approval is withdrawn during cold discovery', async () => {
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'project', path: directory }] });
  const gate = path.join(directory, 'gate');
  await fs.writeFile(gate, 'wait');
  await configure({ PROJECT_MCP_TEST_GATE: gate, PROJECT_MCP_TEST_BEAT: '1' });
  const pending = manager.search('project', directory, '', undefined, false, false,
    async () => (await import('../src/main/config.js')).getConfig().roots.length > 0)
    .then(() => null, error => error as Error);
  await waitFor(path.join(directory, 'waiting'));
  await saveConfig({ ...defaultConfig(), roots: [] });
  await fs.rm(gate);
  expect((await pending)?.message).toMatch(/authorization|revoked|shutting down/i);
  const heartbeat = path.join(directory, 'beat');
  const before = await fs.readFile(heartbeat).then(buffer => buffer.length, () => 0);
  await new Promise(resolve => setTimeout(resolve, 160));
  expect(await fs.readFile(heartbeat).then(buffer => buffer.length, () => 0)).toBe(before);
});

it('reports failed post-commit cleanup after the Settings publisher finishes', async () => {
  const steps: string[] = [];
  const unsubscribe = onConfigPublished(() => { throw new Error('simulated retirement failure'); });
  try {
    await expect(updateConfig(config => ({ ...config, readOnly: true }), undefined,
      async (_next, _previous, persist) => {
        const saved = await persist();
        steps.push('publisher completed');
        return saved;
      })).rejects.toThrow(/Settings were saved.*could not be confirmed stopped/);
    expect(steps).toEqual(['publisher completed']);
    expect(getConfig().readOnly).toBe(true);
  } finally {
    unsubscribe();
  }
});
