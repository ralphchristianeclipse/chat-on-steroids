import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { projectMcpManager } from '../project-mcp/runtime.js';
import { getConfig } from '../config.js';
import { listProjects, projectWorkspace } from '../projects.js';
import { rawPromises as fs } from '../rawfs.js';
import { nativePathIdentity, resolvePath } from '../sandbox.js';
import { getSession } from '../session/store.js';
import { setWorkspaceFor, workspaceForChat } from '../workspace.js';
import { redactCredentialText } from '../redaction.js';
import { currentCaller } from './call-context.js';
import { fail, failIdentity, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

function redactProjectMcpValue(value: unknown): unknown {
  if (typeof value === 'string') return redactCredentialText(value);
  if (Array.isArray(value)) return value.map(redactProjectMcpValue);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactProjectMcpValue(entry)])
  );
  return value;
}

function folderScopeId(workspace: string): string {
  return `folder:${createHash('sha256').update(nativePathIdentity(workspace)).digest('hex')}`;
}

async function approvedWorkspace(real: string): Promise<{ virtual: string; real: string } | null> {
  const config = getConfig();
  const resolved = await resolvePath(config.roots, real);
  if (!(await fs.stat(resolved.real)).isDirectory()) return null;
  const identity = nativePathIdentity(resolved.real);
  const knownProject = (await listProjects()).some(project => nativePathIdentity(project.path) === identity);
  let approvedFolder = false;
  for (const root of config.roots) {
    const canonical = await fs.realpath(root.path).catch(() => null);
    if (canonical && nativePathIdentity(canonical) === identity) { approvedFolder = true; break; }
  }
  // A learned cwd may be any child of an approved root. That is enough for ordinary file tools,
  // but not enough to opt that child into repository-defined executable MCP config. Folder fallback
  // is limited to an explicit Settings Folder or an already-known local Project path.
  if (!approvedFolder && !knownProject) return null;
  return { virtual: resolved.virtual, real: resolved.real };
}

async function scope(): Promise<{ scopeId: string; workspace: string } | null> {
  const caller = currentCaller();
  const sessionId = caller.sessionId;
  if (!sessionId) return null;
  const session = await getSession(sessionId);
  if (!session) return null;

  let workspace: { virtual: string; real: string } | null = null;
  if (session.projectId) {
    // An explicit project is durable authority. A dangling/revoked/moved binding must fail rather
    // than borrowing the chat's last learned cwd, which may legitimately be another approved root.
    workspace = await projectWorkspace(session.projectId);
  } else if (caller.conversationId) {
    // Folder fallback is exact-chat state, never UI selection and never the first approved root.
    // Revalidate it against the current roots so removing a Folder immediately revokes this path.
    const learned = workspaceForChat(caller.conversationId);
    if (learned) workspace = await approvedWorkspace(learned.real);
  }
  if (!workspace) return null;

  // Remember an explicit Project folder too. This makes the exact conversation resilient if its
  // project catalog row later disappears, without persisting or borrowing another chat's cwd.
  if (caller.conversationId) setWorkspaceFor(`chat:${caller.conversationId}`, workspace);

  // MCP capability identity follows the actual folder/config, not the presentation UUID. Re-adding
  // the same folder therefore keeps one scope, while a different folder can never reuse its IDs.
  return { scopeId: folderScopeId(workspace.real), workspace: workspace.real };
}

const input = z.object({
  action: z.enum(['search', 'describe', 'call']).describe('search discovers tools; describe returns one selected schema; call invokes one tool_id returned by search.'),
  query: z.string().max(300).optional().describe('search: optional alternative words matched against server name, tool name and description; any word may match.'),
  server: z.string().min(1).max(128).optional().describe('search: optional exact configured server name.'),
  compact: z.boolean().optional().describe('search: return names and descriptions without full schemas; then describe only the selected tool. Defaults to false for compatibility.'),
  cached: z.boolean().optional().describe('search: reuse live servers\' previous tool catalogs without tools/list round trips. Defaults to false for fresh discovery; calls always revalidate.'),
  tool_id: z.string().regex(/^pmcp_[0-9a-f]{24}$/).optional().describe('describe/call: opaque project-owned id returned by search.'),
  arguments: z.record(z.string(), z.unknown()).optional().describe('call: arguments validated by the upstream MCP tool schema.')
}).strict().superRefine((value, ctx) => {
  if (value.action !== 'search' && !value.tool_id) ctx.addIssue({ code: 'custom', path: ['tool_id'], message: 'tool_id is required for describe/call' });
  if (value.action === 'search' && (value.tool_id !== undefined || value.arguments !== undefined)) ctx.addIssue({ code: 'custom', message: 'tool_id and arguments apply only to call' });
  if (value.action !== 'search' && (value.query !== undefined || value.server !== undefined || value.compact !== undefined || value.cached !== undefined)) ctx.addIssue({ code: 'custom', message: 'query, server, compact and cached apply only to search' });
  if (value.action === 'describe' && value.arguments !== undefined) ctx.addIssue({ code: 'custom', message: 'arguments apply only to call' });
});

/** Output attribution is visible even though ChatGPT controls the fixed "Ran project_mcp" header. */
const label = (value: string): string => redactCredentialText(value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120));

export function registerProjectMcpTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.read || !reg.exposedCaps.command) return;
  reg.register('project_mcp', toolDeclaration('project_mcp', () => ({
    title: 'Project MCP',
    description: 'Discover and call MCP tools for this chat\'s local project folder. Prefer compact search, then describe the selected schema and call. Repeat searches may use cached=true to skip live tools/list; calls still revalidate, and cached=false forces fresh discovery. Full-schema search remains available. Only this chat\'s explicit Project or already-proven approved workspace is used, never a guessed folder. Trusted user Codex MCP config is inherited before project .mcp.json/.codex/config.toml overrides. Servers start lazily. Tool IDs are project/config-bound. Ambiguous failed mutations are never retried.',
    inputSchema: input,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  })), async ({ action, query, server, compact, cached, tool_id, arguments: args }) => reg.guarded('read', 'project_mcp', () => reg.guarded('command', 'project_mcp', async () => {
    const owned = await scope();
    if (!owned) return currentCaller().sessionId
      ? fail('PROJECT_REQUIRED: Select a local project for this chat, or first establish this exact chat\'s workspace by using an approved folder with a local file/command tool.')
      : failIdentity('PROJECT_IDENTITY_REQUIRED: Exact local session identity is required before using project MCP tools.');
    const project = label(path.basename(owned.workspace));
    if (action === 'call') {
      const target: { server?: string; tool?: string } = {};
      const result = await projectMcpManager.call(owned.scopeId, owned.workspace, tool_id!, args ?? {},
        (resolvedServer, tool) => { target.server = resolvedServer; target.tool = tool; });
      const identification = target.server && target.tool
        ? `Project MCP | Project: ${project} | Tool: ${label(target.server)}.${label(target.tool)}`
        : `Project MCP | Project: ${project} | Tool: not resolved`;
      return { ...result, content: [{ type: 'text' as const, text: identification }, ...result.content] };
    }
    if (action === 'describe') {
      const entry = await projectMcpManager.describe(owned.scopeId, owned.workspace, tool_id!);
      if (!entry) return fail('MCP_TOOL_STALE: Search this project MCP catalog again; the tool id is absent or its project/config changed. No tool was invoked.');
      return {
        content: [{ type: 'text' as const, text: `Project MCP | Project: ${project} | Tool: ${label(entry.server)}.${label(entry.tool.name)} | Schema retrieved` }],
        structuredContent: {
          project, tool_id: entry.id, server: entry.server, name: entry.tool.name,
          description: entry.tool.description ? redactCredentialText(entry.tool.description) : '',
          input_schema: redactProjectMcpValue(entry.tool.inputSchema),
          ...(entry.tool.annotations ? { annotations: redactProjectMcpValue(entry.tool.annotations) } : {})
        }
      };
    }
    const result = await projectMcpManager.search(owned.scopeId, owned.workspace, query ?? '', server, cached, compact);
    const tools = result.tools.map(entry => ({
      tool_id: entry.id, server: entry.server, name: entry.tool.name,
      description: entry.tool.description ? redactCredentialText(entry.tool.description) : '',
      ...(!compact ? { input_schema: redactProjectMcpValue(entry.tool.inputSchema) } : {}),
      ...(!compact && entry.tool.annotations ? { annotations: redactProjectMcpValue(entry.tool.annotations) } : {})
    }));
    return {
      content: [{ type: 'text', text: tools.length
        ? `Project MCP | Project: ${project} | Found ${tools.length} tool${tools.length === 1 ? '' : 's'}${compact ? ' (compact)' : ''}.${result.errors.length ? ` ${result.errors.length} server(s) failed discovery.` : ''}`
        : `Project MCP | Project: ${project} | ${result.errors.length ? 'No tools discovered; see errors.' : 'No matching tools found.'}` }],
      structuredContent: { project, tools, errors: result.errors }
    };
  })));
}
