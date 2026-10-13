import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { projectMcpManager } from '../src/main/project-mcp/runtime.js';
import { addProject, assignSessionProject } from '../src/main/projects.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { createSession, flushSessions, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { resetWorkspaces, setWorkspaceFor } from '../src/main/workspace.js';
import { DEFAULT_CAPABILITIES, type Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// The second tools/list is held after the Core request was authorized, before tools/call.
const stdioFixture = `const fs=require('node:fs');const readline=require('node:readline');
const [arm,reached,release,calls]=process.argv.slice(2);
const tool={name:'mutate',description:'Record downstream mutation',inputSchema:{type:'object'}};
const reply=(m,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',m=>{m=JSON.parse(m);if(m.id===undefined)return;
if(m.method==='initialize')return reply(m,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'gate',version:'1'}});
if(m.method==='tools/list'){
  if(!fs.existsSync(arm))return reply(m,{tools:[tool]});
  fs.writeFileSync(reached,'held');
  const gate=setInterval(()=>{if(!fs.existsSync(release))return;clearInterval(gate);reply(m,{tools:[tool]});},10);
  return;
}
if(m.method==='tools/call'){fs.appendFileSync(calls,'x');return reply(m,{content:[{type:'text',text:'mutated'}]});}
reply(m,{});});`;

it('rechecks live permissions and exact project authorization after delayed downstream discovery', async () => {
  const directory = await makeTempDir('cos-project-mcp-authorization-');
  const projectAPath = path.join(directory, 'first');
  const projectBPath = path.join(directory, 'second');
  const arm = path.join(directory, 'arm');
  const reached = path.join(directory, 'reached');
  const release = path.join(directory, 'release');
  const calls = path.join(directory, 'calls');
  let endpoint: McpEndpoint | undefined;
  let client: Client | undefined;
  let folderClient: Client | undefined;
  try {
    await Promise.all([fs.mkdir(projectAPath), fs.mkdir(projectBPath)]);
    const entry = path.join(projectAPath, 'gate.cjs');
    await fs.writeFile(entry, stdioFixture);
    await fs.writeFile(path.join(projectAPath, '.mcp.json'), JSON.stringify({ mcpServers: {
      gate: { command: process.execPath, args: [entry, arm, reached, release, calls] }
    } }));
    initConfigPath(directory);
    initDurableStore(directory);
    initSessionStore(directory);
    const roots: Root[] = [{ name: 'test-projects', path: directory }];
    await saveConfig({ ...defaultConfig(), roots, readOnly: false, capabilities: { ...DEFAULT_CAPABILITIES, command: true } });
    projectMcpManager.setUserConfigPathForTest(null);
    const first = await addProject(projectAPath);
    await addProject(projectBPath);
    const conversationId = 'project-mcp-authorization-regression';
    const requestId = 'wfr_project_mcp_auth_regression';
    const session = await createSession({ title: 'Authorization regression', conversationId });
    await assignSessionProject(session.id, first.id);
    expect(observeRequestCorrelation({
      requestId, conversationId, sessionId: session.id, messageId: 'authorization-request',
      tool: 'project_mcp', observedAt: Date.now()
    })).toBe('stored');
    endpoint = await startMcpServer(() => ({
      roots, caps: { ...DEFAULT_CAPABILITIES, command: true }, readOnly: false,
      sessionTools: false, agentTools: false
    }));
    client = new Client({ name: 'project authorization regression', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.urls.core), {
      requestInit: { headers: { 'x-request-id': requestId } }
    }));
    const discovered = await client.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    const tools = (discovered.structuredContent as { tools: Array<{ tool_id: string }> }).tools;
    expect(tools).toHaveLength(1);
    const toolId = tools[0]!.tool_id;

    // Verify the permitted path really dispatches before checking each revocation case.
    const allowed = await client.callTool({ name: 'project_mcp', arguments: {
      action: 'call', tool_id: toolId, arguments: {}
    } });
    expect(allowed.isError).toBeFalsy();
    expect(await fs.readFile(calls, 'utf8')).toBe('x');

    const cases = [
      {
        name: 'read capability',
        revoke: async () => { const config = getConfig(); await saveConfig({ ...config, capabilities: { ...config.capabilities, read: false } }); },
        restore: async () => {}
      },
      {
        name: 'command capability',
        revoke: async () => { const config = getConfig(); await saveConfig({ ...config, capabilities: { ...config.capabilities, command: false } }); },
        restore: async () => {}
      },
      {
        name: 'Read-only mode',
        revoke: async () => { await saveConfig({ ...getConfig(), readOnly: true }); },
        restore: async () => {}
      },
      {
        name: 'approved root',
        revoke: async () => { await saveConfig({ ...getConfig(), roots: [] }); },
        restore: async () => {}
      }
    ];
    for (const scenario of cases) {
      const saved = getConfig();
      // The manager intentionally retires live servers when permissions change.
      // Discover a new current ID for each independent revocation scenario.
      const fresh = await client.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
      const freshTools = (fresh.structuredContent as { tools: Array<{ tool_id: string }> }).tools;
      expect(freshTools, scenario.name).toHaveLength(1);
      await fs.writeFile(arm, 'armed');
      const pending = client.callTool({ name: 'project_mcp', arguments: {
        action: 'call', tool_id: freshTools[0]!.tool_id, arguments: {}
      } });
      await vi.waitFor(async () => {
        expect(await fs.readFile(reached, 'utf8')).toBe('held');
      }, { timeout: 5000, interval: 20 });
      await scenario.revoke();
      await fs.writeFile(release, 'released');
      const refused = await pending;
      expect(refused.isError, scenario.name).toBe(true);
      expect(await fs.readFile(calls, 'utf8'), scenario.name).toBe('x');
      await scenario.restore();
      await saveConfig(saved);
      await Promise.all([arm, reached, release].map(file => fs.rm(file, { force: true })));
    }

    // A workspace switch does not publish Settings changes or retire the live MCP client.
    // This exercises the broker's beforeDispatch callback itself.
    const folderConversation = 'project-mcp-authorization-folder';
    const folderRequest = 'wfr_project_mcp_authorization_folder';
    const folderSession = await createSession({ title: 'Folder owner', conversationId: folderConversation });
    expect(observeRequestCorrelation({ requestId: folderRequest, conversationId: folderConversation,
      sessionId: folderSession.id, messageId: 'folder-request', tool: 'project_mcp', observedAt: Date.now()
    })).toBe('stored');
    setWorkspaceFor(`chat:${folderConversation}`, { virtual: '/test-projects/first', real: projectAPath });
    folderClient = new Client({ name: 'project folder authorization', version: '1' });
    await folderClient.connect(new StreamableHTTPClientTransport(new URL(endpoint.urls.core), {
      requestInit: { headers: { 'x-request-id': folderRequest } }
    }));
    const folderSearch = await folderClient.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    const folderTools = (folderSearch.structuredContent as { tools: Array<{ tool_id: string }> }).tools;
    expect(folderTools).toHaveLength(1);
    await fs.writeFile(arm, 'armed');
    const folderPending = folderClient.callTool({ name: 'project_mcp', arguments: {
      action: 'call', tool_id: folderTools[0]!.tool_id, arguments: {}
    } });
    await vi.waitFor(async () => { expect(await fs.readFile(reached, 'utf8')).toBe('held'); }, { timeout: 5000 });
    setWorkspaceFor(`chat:${folderConversation}`, { virtual: '/test-projects/second', real: projectBPath });
    await fs.writeFile(release, 'released');
    const folderResult = await folderPending;
    expect(folderResult.isError).toBe(true);
    expect(JSON.stringify(folderResult.content)).toContain('MCP_AUTH_REVOKED');
    expect(await fs.readFile(calls, 'utf8')).toBe('x');
  } finally {
    await folderClient?.close().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await endpoint?.stop({ forceAfterMs: 2_000 });
    await projectMcpManager.close();
    await flushSessions();
    await flushDurable();
    resetCorrelationRegistryForTests();
    resetWorkspaces();
    resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(directory);
  }
}, 45_000);
