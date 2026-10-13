/** Map the passive Codex inventory to safe UI previews and main-only launch approvals. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { getConfig } from '../config.js';
import { listProjects } from '../projects.js';
import { nativePathIdentity, resolvePath } from '../sandbox.js';
import { discoverCodexMcpCandidates, fingerprintCodexMcpRow } from './codex-import.js';
import type { CodexMcpApproval, CodexMcpCandidate, PluginSource } from '../../shared/plugins.js';

type Location = { codexHome: string; projectRoot?: string; file: string };
type ParsedRow = { command?: string; args?: string[]; url?: string; cwd?: string;
  enabled_tools?: string[]; disabled_tools?: string[] };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const real = async (file: string): Promise<string | null> => fs.realpath(file).catch(() => null);

async function locations(): Promise<Location[]> {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!path.isAbsolute(home)) return [];
  const locations: Location[] = [{ codexHome: home, file: path.join(home, 'config.toml') }];
  for (const project of await listProjects().catch(() => [])) {
    const approved = await resolvePath(getConfig().roots, project.path).catch(() => null);
    if (!approved || nativePathIdentity(approved.real) !== nativePathIdentity(project.path)) continue;
    locations.push({ codexHome: home, projectRoot: approved.real,
      file: path.join(approved.real, '.codex', 'config.toml') });
  }
  return locations;
}

async function rawRow(file: string, name: string, projectRoot?: string): Promise<ParsedRow | null> {
  // Recheck canonical file status; do not follow config-file symlinks or read oversized files.
  const first = await fs.lstat(file).catch(() => null);
  if (!first?.isFile() || first.isSymbolicLink() || first.size > 256 * 1024) return null;
  const canonical = await fs.realpath(file).catch(() => null);
  if (!canonical || (projectRoot && !canonical.startsWith(projectRoot + path.sep))) return null;
  if (projectRoot) {
    const parent = await fs.lstat(path.dirname(file)).catch(() => null);
    if (!parent?.isDirectory() || parent.isSymbolicLink()) return null;
  }
  const bytes = await fs.readFile(file, 'utf8').catch(() => null);
  if (bytes === null) return null;
  const after = await fs.lstat(file).catch(() => null);
  if (!after?.isFile() || after.isSymbolicLink() || first.dev !== after.dev ||
      first.ino !== after.ino || first.mtimeMs !== after.mtimeMs ||
      canonical !== await fs.realpath(file).catch(() => null)) return null;
  const parsed: unknown = parse(bytes);
  const server = isRecord(parsed) && isRecord(parsed.mcp_servers) ? parsed.mcp_servers[name] : null;
  return isRecord(server) ? server as ParsedRow : null;
}

/** Pure inventory; returned object contains no raw credential values. */
export async function loadCodexMcpCandidates(): Promise<CodexMcpCandidate[]> {
  const found: CodexMcpCandidate[] = [];
  for (const location of await locations()) {
    if (found.length >= 128) break;
    const inventory = await discoverCodexMcpCandidates({
      codexHome: location.codexHome, ...(location.projectRoot ? { projectRoot: location.projectRoot } : {}),
      sourceOnly: location.projectRoot ? 'project' : 'user'
    });
    const source = location.projectRoot ? 'project' : 'user';
    for (const item of inventory.candidates.filter(item => item.source === source)) {
      const sourcePath = await real(location.file);
      if (!sourcePath) continue;
      const definition = await rawRow(location.file, item.name, location.projectRoot).catch(() => null);
      if (!definition) continue;
      const attested = await fingerprintCodexMcpRow(item.name, definition, source, sourcePath,
        location.projectRoot).catch(() => null);
      if (!attested || attested.id !== item.id || attested.fingerprint !== item.fingerprint) continue;
      const environmentNames = [...item.envNames, ...item.envVarNames];
      const headerNames = [...item.headerNames, ...item.headerEnvNames];
      // Installed Plugins cannot represent a Codex-only tool allow/deny list.
      // Refuse rather than silently grant additional tools after import.
      const toolRestrictions = !!definition.enabled_tools?.length || !!definition.disabled_tools?.length;
      const supported = item.enabled && !environmentNames.length && !headerNames.length &&
        !toolRestrictions;
      // Match the parser's canonical project cwd: a later symlink replacement
      // cannot silently redirect the approved executable into another folder.
      const cwd = definition.cwd && location.projectRoot
        ? await fs.realpath(definition.cwd).catch(() => null)
        : definition.cwd ?? location.projectRoot;
      if (definition.cwd && !cwd) continue;
      found.push({
        id: item.id, fingerprint: item.fingerprint, name: item.name,
        sourceKind: item.transport, sourcePath,
        ...(item.executable ? { executable: item.executable } : {}),
        ...(item.argumentCount !== undefined ? { argumentCount: item.argumentCount } : {}),
        ...(item.endpointHost ? { endpointHost: item.endpointHost } : {}),
        ...(item.transport === 'stdio' && cwd ? { cwd } : {}),
        environmentNames, headerNames,
        supported, ...(supported ? {} : { reason: !item.enabled
          ? 'Disabled in Codex configuration; enable it there before importing.'
          : environmentNames.length || headerNames.length
            ? 'Environment or HTTP credentials need separate secure configuration. Import is blocked.'
            : 'Codex tool restrictions cannot be enforced by Plugins import yet. Import is blocked.' })
      });
      if (found.length >= 128) break;
    }
  }
  return [...new Map(found.map(item => [item.id, item])).values()];
}

/** Re-resolve from disk on the privileged side; renderer supplies only ID and fingerprint. */
export async function resolveApprovedCodex(approval: CodexMcpApproval): Promise<{
  candidate: CodexMcpCandidate; source: PluginSource
}> {
  const candidate = (await loadCodexMcpCandidates()).find(item =>
    item.id === approval.id && item.fingerprint === approval.fingerprint);
  if (!candidate || !candidate.supported) throw new Error('Codex MCP definition changed or is unsupported. Scan again.');
  const available = await Promise.all((await locations()).map(async item => ({
    ...item, canonical: await real(item.file)
  })));
  const location = available.find(item => item.canonical === candidate.sourcePath);
  if (!location) throw new Error('Codex MCP source was removed.');
  const definition = await rawRow(location.file, candidate.name, location.projectRoot);
  if (!definition) throw new Error('Codex MCP source changed during approval. Rescan.');
  const attested = await fingerprintCodexMcpRow(candidate.name, definition,
    location.projectRoot ? 'project' : 'user', candidate.sourcePath, location.projectRoot);
  if (attested.id !== approval.id || attested.fingerprint !== approval.fingerprint)
    throw new Error('Codex MCP configuration changed during approval. Rescan.');
  const source: PluginSource = candidate.sourceKind === 'stdio'
    ? { kind: 'command', command: definition.command, args: definition.args ?? [] }
    : { kind: 'remote', url: definition.url };
  if (source.kind === 'command' && !source.command || source.kind === 'remote' && !source.url)
    throw new Error('Codex MCP launch details were not resolved.');
  return { candidate, source };
}
