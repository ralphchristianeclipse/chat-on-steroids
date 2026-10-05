import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { toolSchema } from '../src/main/mcp/tool-declarations.js';
import { projectMcpManager } from '../src/main/project-mcp/runtime.js';
import { addProject, assignSessionProject } from '../src/main/projects.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { bindSessionProject, createSession, flushSessions, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { resetWorkspaces } from '../src/main/workspace.js';
import { DEFAULT_CAPABILITIES, type Capabilities, type Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const stdioFixture = `const readline=require('node:readline');
const tool={name:'identity',description:'Return the selected project identity',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'project fixture',version:'1'}};
else if(m.method==='tools/list')result={tools:[tool]};
else if(m.method==='tools/call')result={content:[{type:'text',text:(process.env.PROJECT_IDENTITY||'missing:')+m.params.arguments.value}]};
else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;

function caps(): Capabilities {
  return { ...DEFAULT_CAPABILITIES, command: true };
}

function closeHttp(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

it('routes the real Core HTTP broker to an exact project or exact learned folder and keeps permissions/config ids live', async () => {
  const directory = await makeTempDir('cos-project-mcp-http-');
  const approved = path.join(directory, 'approved');
  const projectAPath = path.join(approved, 'project-a');
  const projectBPath = path.join(approved, 'project-b');
  const projectCPath = path.join(approved, 'project-empty');
  const folderOnlyPath = path.join(approved, 'folder-only');
  const plainChildPath = path.join(approved, 'plain-child');
  let endpoint: McpEndpoint | undefined;
  let lanHttp: http.Server | undefined;
  let lanHandler: ReturnType<typeof createMcpHandler> | undefined;
  const clients: Client[] = [];
  try {
    projectMcpManager.setUserConfigPathForTest(null);
    await Promise.all([
      fs.mkdir(path.join(projectAPath, '.codex'), { recursive: true }),
      fs.mkdir(projectBPath, { recursive: true }),
      fs.mkdir(projectCPath, { recursive: true }),
      fs.mkdir(folderOnlyPath, { recursive: true }),
      fs.mkdir(plainChildPath, { recursive: true })
    ]);
    await Promise.all([
      fs.writeFile(path.join(projectAPath, 'workspace-probe.txt'), 'project-a'),
      fs.writeFile(path.join(folderOnlyPath, 'workspace-probe.txt'), 'folder-only'),
      fs.writeFile(path.join(plainChildPath, 'workspace-probe.txt'), 'plain-child')
    ]);
    const entry = path.join(projectAPath, 'fixture.cjs');
    await fs.writeFile(entry, stdioFixture);

    lanHandler = createMcpHandler(() => {
      const server = new McpServer({ name: 'LAN DBCode fixture', version: '1' });
      const input = z.object({ value: z.string() });
      server.registerTool('lan_identity', { inputSchema: toolSchema(input) }, async args => {
        const value = (args as { value: string }).value;
        return { content: [{ type: 'text', text: `lan:${value}` }] };
      });
      return server;
    });
    lanHttp = http.createServer(toNodeHandler(lanHandler));
    await new Promise<void>((resolve, reject) => {
      lanHttp!.once('error', reject);
      lanHttp!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = lanHttp.address();
    if (!address || typeof address === 'string') throw new Error('LAN fixture did not bind a TCP port');

    await fs.writeFile(path.join(projectAPath, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_IDENTITY: 'json:' } }
    } }));
    await fs.writeFile(path.join(projectAPath, '.codex', 'config.toml'), [
      '[mcp_servers.local]',
      'tool_timeout_sec = 7',
      '',
      '[mcp_servers.local.env]',
      'PROJECT_IDENTITY = "codex:"'
    ].join('\n'));
    await fs.writeFile(path.join(projectBPath, '.mcp.json'), JSON.stringify({ mcpServers: {
      dbcode: { url: `http://127.0.0.1:${address.port}/mcp` }
    } }));
    await fs.writeFile(path.join(folderOnlyPath, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_IDENTITY: 'folder:' } }
    } }));
    await fs.writeFile(path.join(plainChildPath, '.mcp.json'), JSON.stringify({ mcpServers: {
      local: { command: process.execPath, args: [entry], env: { PROJECT_IDENTITY: 'plain-child:' } }
    } }));

    initConfigPath(directory);
    initDurableStore(directory);
    initSessionStore(directory);
    await saveConfig({
      ...defaultConfig(),
      readOnly: false,
      capabilities: caps(),
      roots: [{ name: 'projects', path: approved }, { name: 'folder-only', path: folderOnlyPath }] as Root[]
    });

    const projectA = await addProject(projectAPath);
    const projectB = await addProject(projectBPath);
    const projectC = await addProject(projectCPath);
    const sessionA = await createSession({ title: 'Project A', conversationId: 'project-mcp-chat-a' });
    const sessionB = await createSession({ title: 'Project B', conversationId: 'project-mcp-chat-b' });
    const sessionC = await createSession({ title: 'Project C', conversationId: 'project-mcp-chat-c' });
    const sessionD = await createSession({ title: 'Same folder, no project id', conversationId: 'project-mcp-chat-d' });
    const sessionE = await createSession({ title: 'Folder only', conversationId: 'project-mcp-chat-e' });
    const sessionF = await createSession({ title: 'No project and no folder', conversationId: 'project-mcp-chat-f' });
    const sessionG = await createSession({ title: 'Dangling project id', conversationId: 'project-mcp-chat-g' });
    const sessionH = await createSession({ title: 'Approved child only', conversationId: 'project-mcp-chat-h' });
    await assignSessionProject(sessionA.id, projectA.id);
    await assignSessionProject(sessionB.id, projectB.id);
    await assignSessionProject(sessionC.id, projectC.id);

    const context = {
      roots: [{ name: 'projects', path: approved }, { name: 'folder-only', path: folderOnlyPath }] as Root[],
      caps: caps(),
      readOnly: false,
      sessionTools: false,
      agentTools: false
    };
    endpoint = await startMcpServer(() => context);

    const connect = async (conversationId: string, sessionId: string, requestId: string): Promise<Client> => {
      expect(observeRequestCorrelation({
        requestId, conversationId, sessionId, messageId: `msg-${requestId}`, tool: 'project_mcp', observedAt: Date.now()
      })).toBe('stored');
      const client = new Client({ name: `project acceptance ${conversationId}`, version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!.urls.core), {
        requestInit: { headers: { 'x-request-id': requestId } }
      }));
      clients.push(client);
      return client;
    };
    const clientA = await connect('project-mcp-chat-a', sessionA.id, 'wfr_project_mcp_a');
    const clientB = await connect('project-mcp-chat-b', sessionB.id, 'wfr_project_mcp_b');
    const clientC = await connect('project-mcp-chat-c', sessionC.id, 'wfr_project_mcp_c');
    const clientD = await connect('project-mcp-chat-d', sessionD.id, 'wfr_project_mcp_d');
    const clientE = await connect('project-mcp-chat-e', sessionE.id, 'wfr_project_mcp_e');
    const clientF = await connect('project-mcp-chat-f', sessionF.id, 'wfr_project_mcp_f');
    const clientG = await connect('project-mcp-chat-g', sessionG.id, 'wfr_project_mcp_g');
    const clientH = await connect('project-mcp-chat-h', sessionH.id, 'wfr_project_mcp_h');

    for (const [client, file] of [
      [clientD, '/projects/project-a/workspace-probe.txt'],
      [clientE, '/folder-only/workspace-probe.txt'],
      [clientG, '/folder-only/workspace-probe.txt'],
      [clientH, '/projects/plain-child/workspace-probe.txt']
    ] as const) {
      const learned = await client.callTool({ name: 'read', arguments: { paths: [file] } });
      expect(learned.isError, file + ': ' + JSON.stringify(learned.content)).toBeFalsy();
    }
    await bindSessionProject(sessionG.id, '11111111-1111-4111-8111-111111111111');

    expect((await clientA.listTools()).tools.some(tool => tool.name === 'project_mcp')).toBe(true);
    const searchA = await clientA.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    const toolsA = (searchA.structuredContent as { tools: Array<{ tool_id: string; server: string; name: string }> }).tools;
    expect(toolsA).toHaveLength(1);
    expect(toolsA[0]).toMatchObject({ server: 'local', name: 'identity' });
    expect((toolsA[0] as { input_schema?: unknown }).input_schema).toBeDefined();
    expect(searchA.structuredContent).toMatchObject({ project: 'project-a' });
    const idA = toolsA[0]!.tool_id;
    const compactA = await clientA.callTool({ name: 'project_mcp', arguments: { action: 'search', compact: true } });
    const concise = (compactA.structuredContent as { tools: Array<{ tool_id: string; input_schema?: unknown }> }).tools;
    expect(concise).toHaveLength(1);
    expect(concise[0]!.tool_id).toBe(idA);
    expect(concise[0]).not.toHaveProperty('input_schema');
    expect(JSON.stringify(compactA.structuredContent).length).toBeLessThan(JSON.stringify(searchA.structuredContent).length);
    const described = await clientA.callTool({ name: 'project_mcp', arguments: { action: 'describe', tool_id: idA } });
    expect(described.structuredContent).toMatchObject({ project: 'project-a', server: 'local', name: 'identity', input_schema: { type: 'object' } });
    const callA = await clientA.callTool({ name: 'project_mcp', arguments: { action: 'call', tool_id: idA, arguments: { value: 'A' } } });
    expect(JSON.stringify(callA.content)).toContain('codex:A');
    expect(JSON.stringify(callA.content)).toContain('project-a');
    expect(JSON.stringify(callA.content)).toContain('local.identity');

    const searchB = await clientB.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    const toolsB = (searchB.structuredContent as { tools: Array<{ tool_id: string; server: string; name: string }> }).tools;
    expect(toolsB).toHaveLength(1);
    expect(toolsB[0]).toMatchObject({ server: 'dbcode', name: 'lan_identity' });
    expect(toolsB.some(tool => tool.server === 'local')).toBe(false);
    const callB = await clientB.callTool({ name: 'project_mcp', arguments: { action: 'call', tool_id: toolsB[0]!.tool_id, arguments: { value: 'B' } } });
    expect(JSON.stringify(callB.content)).toContain('lan:B');
    expect(JSON.stringify(callB.content)).toContain('project-b');
    expect(JSON.stringify(callB.content)).toContain('dbcode.lan_identity');
    expect(JSON.stringify(callB.content)).not.toContain('project-a');

    const crossProject = await clientB.callTool({ name: 'project_mcp', arguments: { action: 'call', tool_id: idA, arguments: { value: 'wrong' } } });
    expect(crossProject.isError).toBe(true);
    expect(JSON.stringify(crossProject.content)).toContain('MCP_TOOL_STALE');
    expect(JSON.stringify(crossProject.content)).toContain('project-b');
    expect(JSON.stringify(crossProject.content)).not.toContain('local.identity');
    const empty = await clientC.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    expect((empty.structuredContent as { tools: unknown[] }).tools).toEqual([]);

    const sameFolder = await clientD.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    const sameFolderTools = (sameFolder.structuredContent as { tools: Array<{ tool_id: string; server: string; name: string }> }).tools;
    expect(sameFolderTools).toHaveLength(1);
    expect(sameFolderTools[0]).toMatchObject({ tool_id: idA, server: 'local', name: 'identity' });
    const sameFolderCall = await clientD.callTool({ name: 'project_mcp', arguments: { action: 'call', tool_id: idA, arguments: { value: 'D' } } });
    expect(JSON.stringify(sameFolderCall.content)).toContain('codex:D');

    const folderOnly = await clientE.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    const folderOnlyTools = (folderOnly.structuredContent as { tools: Array<{ tool_id: string; server: string; name: string }> }).tools;
    expect(folderOnlyTools).toHaveLength(1);
    expect(folderOnlyTools[0]).toMatchObject({ server: 'local', name: 'identity' });
    expect(folderOnlyTools[0]!.tool_id).not.toBe(idA);
    const folderOnlyCall = await clientE.callTool({ name: 'project_mcp', arguments: { action: 'call', tool_id: folderOnlyTools[0]!.tool_id, arguments: { value: 'E' } } });
    expect(JSON.stringify(folderOnlyCall.content)).toContain('folder:E');
    const crossFolder = await clientE.callTool({ name: 'project_mcp', arguments: { action: 'call', tool_id: idA, arguments: { value: 'wrong-folder' } } });
    expect(crossFolder.isError).toBe(true);
    expect(JSON.stringify(crossFolder.content)).toContain('MCP_TOOL_STALE');

    const withFolder = getConfig();
    await saveConfig({ ...withFolder, roots: [] });
    const revokedFolder = await clientE.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    expect(revokedFolder.isError).toBe(true);
    expect(JSON.stringify(revokedFolder.content)).toContain('approved folder');
    await saveConfig(withFolder);

    const noFolder = await clientF.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    expect(noFolder.isError).toBe(true);
    expect(JSON.stringify(noFolder.content)).toContain('PROJECT_REQUIRED');

    const dangling = await clientG.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    expect(dangling.isError).toBe(true);
    expect(JSON.stringify(dangling.content)).toContain('Project not found');

    const plainChild = await clientH.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    expect(plainChild.isError).toBe(true);
    expect(JSON.stringify(plainChild.content)).toContain('PROJECT_REQUIRED');

    await fs.writeFile(path.join(projectAPath, '.codex', 'config.toml'), [
      '[mcp_servers.local]',
      'tool_timeout_sec = 8',
      '',
      '[mcp_servers.local.env]',
      'PROJECT_IDENTITY = "updated:"'
    ].join('\n'));
    const stale = await clientA.callTool({ name: 'project_mcp', arguments: { action: 'call', tool_id: idA, arguments: { value: 'old' } } });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain('MCP_TOOL_STALE');
    const refreshed = await clientA.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    const refreshedTool = (refreshed.structuredContent as { tools: Array<{ tool_id: string }> }).tools[0]!;
    expect(refreshedTool.tool_id).not.toBe(idA);
    const updated = await clientA.callTool({ name: 'project_mcp', arguments: { action: 'call', tool_id: refreshedTool.tool_id, arguments: { value: 'A2' } } });
    expect(JSON.stringify(updated.content)).toContain('updated:A2');

    context.caps.read = false;
    const noRead = await clientA.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    expect(noRead.isError).toBe(true);
    expect(JSON.stringify(noRead.content)).toContain('TOOL_DISABLED');
    context.caps.read = true;
    context.caps.command = false;
    const noCommand = await clientA.callTool({ name: 'project_mcp', arguments: { action: 'search' } });
    expect(noCommand.isError).toBe(true);
    expect(JSON.stringify(noCommand.content)).toContain('TOOL_DISABLED');
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await endpoint?.stop({ forceAfterMs: 2_000 });
    await projectMcpManager.close();
    if (lanHttp?.listening) await closeHttp(lanHttp);
    await lanHandler?.close();
    await flushSessions();
    await flushDurable();
    resetCorrelationRegistryForTests();
    resetWorkspaces();
    resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(directory);
  }
}, 30_000);
