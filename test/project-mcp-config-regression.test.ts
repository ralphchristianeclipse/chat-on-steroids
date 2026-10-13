import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadProjectMcpConfig } from '../src/main/project-mcp/config.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let root: string;
let project: string;
let outside: string;

beforeEach(async () => {
  root = await makeTempDir('cos-project-mcp-cwd-');
  project = path.join(root, 'project');
  outside = path.join(root, 'outside');
  await Promise.all([fs.mkdir(project), fs.mkdir(outside)]);
});

afterEach(async () => {
  await removeTempDir(root);
});

async function writeProjectServers(servers: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

describe('disabled project MCP cwd validation', () => {
  it.each([
    ['nonexistent', 'missing', { disabled: true }],
    ['outside project', 'outside', { enabled: false }]
  ] as const)('keeps an enabled server when a disabled server has %s cwd', async (_label, kind, disabled) => {
    const stale = kind === 'missing' ? path.join(project, 'deleted-cwd') : outside;
    await writeProjectServers({
      stale: { command: 'node', cwd: stale, ...disabled },
      healthy: { command: 'node' }
    });

    const loaded = await loadProjectMcpConfig(project, { userConfigPath: null });
    expect(loaded.servers.map(server => [server.name, server.enabled])).toEqual([
      ['stale', false], ['healthy', true]
    ]);
    expect(loaded.servers.find(server => server.name === 'healthy')?.cwd).toBe(project);
  });

  it.each([
    ['nonexistent', 'missing', /cwd does not exist/],
    ['outside project', 'outside', /cwd leaves the selected project folder/]
  ] as const)('still rejects an enabled server with %s cwd', async (_label, kind, error) => {
    const stale = kind === 'missing' ? path.join(project, 'deleted-cwd') : outside;
    await writeProjectServers({ healthy: { command: 'node' }, invalid: { command: 'node', cwd: stale } });

    await expect(loadProjectMcpConfig(project, { userConfigPath: null })).rejects.toThrow(error);
  });

  it('preserves user-disabled inheritance despite a stale cwd and project enabled override', async () => {
    const userConfig = path.join(root, 'user-config.toml');
    await fs.writeFile(userConfig, [
      '[mcp_servers.inherited]',
      'command = "node"',
      `cwd = ${JSON.stringify(outside)}`,
      'enabled = false'
    ].join('\n'));
    await writeProjectServers({
      inherited: { enabled: true },
      healthy: { command: 'node' }
    });

    const loaded = await loadProjectMcpConfig(project, { userConfigPath: userConfig });
    expect(loaded.servers.find(server => server.name === 'inherited')).toMatchObject({
      enabled: false, userDisabled: true, cwd: outside
    });
    expect(loaded.servers.find(server => server.name === 'healthy')).toMatchObject({
      enabled: true, cwd: project
    });
  });
});
