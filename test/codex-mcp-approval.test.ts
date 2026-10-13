import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { randomUUID } from 'node:crypto';
import { PluginManager } from '../src/main/plugins/manager.js';

const server = `const fs=require('node:fs'),readline=require('node:readline');
fs.appendFileSync(process.env.CODEX_TEST_STARTED,'S');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 const tool={name:'codex_echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}};
 let result={};
 if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Codex import fixture',version:'1'}};
 if(m.method==='tools/list')result={tools:[tool]};
 if(m.method==='tools/call'){fs.appendFileSync(process.env.CODEX_TEST_CALLED,'C');result={content:[{type:'text',text:'ok'}]};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`;

let base: string, home: string, start: string, called: string, entry: string, manager: PluginManager;
async function writeConfig(args: string[] = [entry]): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  const q = (value: string) => JSON.stringify(value);
  await fs.writeFile(path.join(home, 'config.toml'),
    `[mcp_servers.local]\ncommand = ${q(process.execPath)}\nargs = [${args.map(q).join(', ')}]\n`);
}
async function count(file: string): Promise<number> {
  return fs.readFile(file).then(buffer => buffer.length, () => 0);
}
beforeEach(async () => {
  base = await makeTempDir('cos-codex-approval-');
  home = path.join(base, 'codex-home');
  entry = path.join(base, 'fixture.cjs');
  start = path.join(base, 'started');
  called = path.join(base, 'called');
  await fs.writeFile(entry, server
    .replace('process.env.CODEX_TEST_STARTED', JSON.stringify(start))
    .replace('process.env.CODEX_TEST_CALLED', JSON.stringify(called)));
  vi.stubEnv('CODEX_HOME', home);
  initDurableStore(base);
  initConfigPath(base);
  await saveConfig(defaultConfig());
  manager = new PluginManager();
  await manager.initialize(base);
});
afterEach(async () => {
  await manager.close();
  resetDurableForTests();
  vi.unstubAllEnvs();
  await removeTempDir(base);
});

it('passively lists Codex config without starting code, then starts only the approved exact server', async () => {
  await writeConfig();
  const rows = await manager.codexCandidates();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: 'local', supported: true, sourceKind: 'stdio' });
  expect(rows[0]?.argumentCount).toBe(1);
  expect(JSON.stringify(rows)).not.toContain(entry);
  expect(await count(start)).toBe(0);
  expect(manager.snapshot().plugins).toEqual([]);
  expect(manager.tools()).toEqual([]);
  const row = rows[0]!;
  const installed = await manager.importCodex({ id: row.id, fingerprint: row.fingerprint });
  expect(installed.plugins).toHaveLength(1);
  expect(JSON.stringify(installed.plugins)).not.toContain(entry);
  expect(await count(start)).toBe(1);
  expect(installed.plugins[0]!.codexImport?.fingerprint).toBe(row.fingerprint);
  expect(installed.plugins[0]!.status).toBe('ready');
  expect((await manager.call('codex_echo', { text: 'ok' })).isError).not.toBe(true);
  expect(await count(called)).toBe(1);
});

it('refuses stale approval before installation without launching any executable', async () => {
  await writeConfig();
  const old = (await manager.codexCandidates())[0]!;
  await writeConfig([entry, '--changed']);
  await expect(manager.importCodex({ id: old.id, fingerprint: old.fingerprint })).rejects.toThrow(/changed/i);
  expect(await count(start)).toBe(0);
  expect(manager.snapshot().plugins).toHaveLength(0);
});

it('blocks credential-bearing definitions without leaking values to candidate previews', async () => {
  await writeConfig();
  await fs.appendFile(path.join(home, 'config.toml'), 'env = { API_KEY = "private-secret-1234" }\n');
  const [row] = await manager.codexCandidates();
  expect(row?.supported).toBe(false);
  expect(JSON.stringify(row)).not.toContain('private-secret-1234');
  await expect(manager.importCodex({ id: row!.id, fingerprint: row!.fingerprint }))
    .rejects.toThrow(/unsupported/i);
  expect(await count(start)).toBe(0);
});

it('does not widen Codex-only tool allowlists when importing into Plugins', async () => {
  await writeConfig();
  await fs.appendFile(path.join(home, 'config.toml'), 'enabled_tools = ["restricted_tool"]\n');
  const [row] = await manager.codexCandidates();
  expect(row?.supported).toBe(false);
  expect(row?.reason).toMatch(/tool restrictions/i);
  await expect(manager.importCodex({ id: row!.id, fingerprint: row!.fingerprint }))
    .rejects.toThrow(/unsupported/i);
  expect(await count(start)).toBe(0);
});

it('revokes an imported server after source changes and prevents stale calls or re-enabling', async () => {
  await writeConfig();
  const row = (await manager.codexCandidates())[0]!;
  const plugin = (await manager.importCodex({ id: row.id, fingerprint: row.fingerprint })).plugins[0]!;
  await writeConfig([entry, '--other']);
  const denied = await manager.call('codex_echo', { text: 'not allowed' });
  expect(denied.isError).toBe(true);
  expect(await count(called)).toBe(0);
  expect(manager.snapshot().plugins[0]!.enabled).toBe(false);
  await expect(manager.setEnabled(plugin.id, true)).rejects.toThrow(/changed/i);
  expect(await count(start)).toBe(1);
});

it('rechecks recorded fingerprint before restoring imported connections after application restart', async () => {
  await writeConfig();
  const row = (await manager.codexCandidates())[0]!;
  await manager.importCodex({ id: row.id, fingerprint: row.fingerprint });
  await manager.close();
  await writeConfig([entry, '--new']);
  manager = new PluginManager();
  await manager.initialize(base);
  const [restored] = manager.snapshot().plugins;
  expect(restored?.enabled).toBe(false);
  expect(manager.tools()).toEqual([]);
  expect(await count(start)).toBe(1);
});

it('reapproves an updated server only on a fresh, explicit fingerprint without reviving the old source', async () => {
  await writeConfig();
  const original = (await manager.codexCandidates())[0]!;
  const first = (await manager.importCodex({ id: original.id, fingerprint: original.fingerprint })).plugins[0]!;
  await writeConfig([entry, '--second']);
  const updated = (await manager.codexCandidates())[0]!;
  expect(updated.id).toBe(original.id);
  expect(updated.fingerprint).not.toBe(original.fingerprint);
  await expect(manager.importCodex({ id: original.id, fingerprint: original.fingerprint })).rejects.toThrow(/changed/i);
  const result = await manager.importCodex({ id: updated.id, fingerprint: updated.fingerprint });
  expect(result.plugins[0]!.id).toBe(first.id);
  expect(result.plugins[0]!.codexImport?.fingerprint).toBe(updated.fingerprint);
  expect(await count(start)).toBe(2);
  expect((await manager.call('codex_echo', { text: 'fresh' })).isError).not.toBe(true);
  expect(await count(called)).toBe(1);
});

it('proactively retires an approved process when the Codex configuration file changes', async () => {
  await writeConfig();
  const original = (await manager.codexCandidates())[0]!;
  await manager.importCodex({ id: original.id, fingerprint: original.fingerprint });
  expect(await count(start)).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 80));
  await writeConfig([entry, '--changed-without-a-tool-call']);
  await vi.waitFor(() => expect(manager.snapshot().plugins[0]!.enabled).toBe(false),
    { timeout: 6500, interval: 100 });
  expect(manager.tools()).toEqual([]);
  expect(await count(called)).toBe(0);
});

it('stops a project-sourced server as soon as the owning folder approval is revoked', async () => {
  const project = path.join(base, 'project');
  await fs.mkdir(path.join(project, '.codex'), { recursive: true });
  await fs.writeFile(path.join(project, '.codex', 'config.toml'),
    `[mcp_servers.project]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}]\n`);
  await writeDurableNow('projects', [{ id: randomUUID(), name: 'project', path: project, createdAt: Date.now() }]);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'project', path: project }] });
  const row = (await manager.codexCandidates()).find(item => item.name === 'project')!;
  expect(row.supported).toBe(true);
  await manager.importCodex({ id: row.id, fingerprint: row.fingerprint });
  expect(await count(start)).toBe(1);
  await saveConfig(defaultConfig());
  expect(manager.snapshot().plugins[0]!.enabled).toBe(false);
  expect(manager.tools()).toEqual([]);
  expect((await manager.call('codex_echo', { text: 'must not run' })).isError).toBe(true);
  expect(await count(called)).toBe(0);
});
