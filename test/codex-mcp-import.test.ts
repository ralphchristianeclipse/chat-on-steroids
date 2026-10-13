import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { discoverCodexMcpCandidates, compareCodexMcpCandidate } from '../src/main/plugins/codex-import.js';
import { makeTempDir, removeTempDir, DIR_LINK } from './helpers.js';

let base: string, home: string, project: string;
const write = async (file: string, body: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
};
const config = (body: string) => write(path.join(home, 'config.toml'), body);
const discover = () => discoverCodexMcpCandidates({ codexHome: home, projectRoot: project });

beforeEach(async () => {
  base = await makeTempDir('cos-codex-import-');
  home = path.join(base, 'codex-home'); project = path.join(base, 'project');
  await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
});
afterEach(async () => { vi.unstubAllEnvs(); await removeTempDir(base); });

it('reads only configured Codex TOML, returning stable safe candidates without secrets or executing commands', async () => {
  const marker = path.join(base, 'never-executed');
  const secret = 'distinctive-private-token-73294';
  vi.stubEnv('INTERNAL_TOKEN', secret);
  await config(`
[mcp_servers.alpha]
command = "does-not-exist"
args = ${JSON.stringify(['--write', marker, `--password=${secret}`])}
env = { INTERNAL_TOKEN = "${secret}" }
env_vars = ["INTERNAL_TOKEN"]
[mcp_servers.remote]
url = "https://example.com/mcp/secret-path"
http_headers = { Authorization = "Bearer ${secret}" }
env_http_headers = { "X-Token" = "INTERNAL_TOKEN" }
bearer_token_env_var = "INTERNAL_TOKEN"
enabled = false
`);
  const first = await discover();
  expect(first.rejected).toEqual([]); expect(first.errors).toEqual([]);
  expect(first.candidates.map(row => [row.name, row.transport, row.enabled])).toEqual([
    ['alpha', 'stdio', true], ['remote', 'http', false]
  ]);
  expect(first.candidates[0]).toMatchObject({ executable: 'does-not-exist', argumentCount: 3,
    envNames: ['INTERNAL_TOKEN'], envVarNames: ['INTERNAL_TOKEN'] });
  expect(first.candidates[1]).toMatchObject({ endpointHost: 'example.com',
    headerNames: ['Authorization'], headerEnvNames: ['INTERNAL_TOKEN'] });
  expect(JSON.stringify(first)).not.toContain(secret);
  expect(JSON.stringify(first)).not.toContain('--password');
  expect(JSON.stringify(first)).not.toContain('/secret-path');
  expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
  const again = await discover();
  expect(again.candidates).toEqual(first.candidates);
  expect(compareCodexMcpCandidate(first.candidates[0]!, again.candidates[0]!)).toBe('unchanged');
});

it('canonicalizes TOML key ordering but detects security-relevant changes for reapproval', async () => {
  await config('[mcp_servers.agent]\ncommand = "node"\nargs = ["a"]\nenv_vars = ["B", "A"]\n');
  const initial = (await discover()).candidates[0]!;
  await config('[mcp_servers.agent]\nenv_vars = ["A", "B"]\nargs = ["a"]\ncommand = "node"\n');
  const reordered = (await discover()).candidates[0]!;
  expect(compareCodexMcpCandidate(initial, reordered)).toBe('unchanged');
  for (const changed of [
    '[mcp_servers.agent]\ncommand = "node"\nargs = ["b"]',
    '[mcp_servers.agent]\ncommand = "node"\nargs = ["a"]\nenv_vars = ["B"]',
    '[mcp_servers.agent]\ncommand = "node"\nargs = ["a"]\nenabled = false'
  ]) {
    await config(changed);
    const next = (await discover()).candidates[0]!;
    expect(next.id).toBe(initial.id);
    expect(compareCodexMcpCandidate(initial, next)).toBe('changed');
  }
  await config('[mcp_servers.other]\ncommand = "node"');
  expect(compareCodexMcpCandidate(initial, (await discover()).candidates[0]!)).toBe('different-server');
});

it('fingerprints remote URL, header names and embedded literal changes without displaying their values', async () => {
  const token = 'sensitive-static-header-8972';
  const definition = (host: string, header: string, value: string) => `
[mcp_servers.remote]
url = "https://${host}/mcp"
http_headers = { ${header} = "${value}" }
env_http_headers = { "X-Auth" = "REMOTE_TOKEN" }
`;
  await config(definition('example.com', 'Authorization', token));
  const original = (await discover()).candidates[0]!;
  expect(JSON.stringify(original)).not.toContain(token);
  for (const altered of [
    definition('example.org', 'Authorization', token),
    definition('example.com', 'Authorization', `${token}2`),
    definition('example.com', 'X-Other', token),
    definition('example.com', 'Authorization', token).replace('REMOTE_TOKEN', 'NEW_TOKEN')
  ]) {
    await config(altered);
    const current = (await discover()).candidates[0]!;
    expect(current.id).toBe(original.id);
    expect(compareCodexMcpCandidate(original, current)).toBe('changed');
    expect(JSON.stringify(current)).not.toContain(token);
  }
});

it('rejects malformed/dangerous rows individually without losing a valid neighbor', async () => {
  await config(`
[mcp_servers.healthy]
command = "node"
[mcp_servers.no_target]
args = ["x"]
[mcp_servers.mixed]
command = "node"
url = "https://example.com/mcp"
[mcp_servers.bad_args]
command = "node"
args = [1]
[mcp_servers.bad_env]
command = "node"
env_vars = ["BAD=SECRET"]
[mcp_servers.bad_url]
url = "https://user:secret@example.com/mcp"
[mcp_servers.insecure]
url = "http://public.example/mcp"
[mcp_servers.unknown_field]
command = "node"
shell = true
`);
  const result = await discover();
  expect(result.candidates.map(row => row.name)).toEqual(['healthy']);
  expect(result.rejected.map(row => row.name)).toEqual([
    'bad_args', 'bad_env', 'bad_url', 'insecure', 'mixed', 'no_target', 'unknown_field'
  ]);
  expect(JSON.stringify(result.rejected)).not.toContain('secret');
});

it('uses CODEX_HOME, then defaults to the user .codex directory', async () => {
  const fallback = path.join(base, 'profile');
  await write(path.join(fallback, '.codex/config.toml'), '[mcp_servers.from_home]\ncommand = "node"');
  vi.stubEnv('HOME', fallback); vi.stubEnv('USERPROFILE', fallback);
  vi.stubEnv('CODEX_HOME', home);
  await config('[mcp_servers.from_codex_home]\ncommand = "node"');
  expect((await discoverCodexMcpCandidates()).candidates.map(row => row.name)).toEqual(['from_codex_home']);
  vi.stubEnv('CODEX_HOME', '');
  expect((await discoverCodexMcpCandidates()).candidates.map(row => row.name)).toEqual(['from_home']);
});

it('keeps distinct user and project provenance and bounds project-local files', async () => {
  await config('[mcp_servers.agent]\ncommand = "node"');
  await write(path.join(project, '.codex/config.toml'), '[mcp_servers.agent]\ncommand = "node"');
  const both = await discover();
  expect(both.candidates.map(row => row.source)).toEqual(['user', 'project']);
  expect(both.candidates[0]!.id).not.toBe(both.candidates[1]!.id);
  expect(both.candidates[0]!.fingerprint).not.toBe(both.candidates[1]!.fingerprint);
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await write(path.join(outside, 'config.toml'), '[mcp_servers.escaped]\ncommand = "node"');
  await fs.rm(path.join(project, '.codex'), { recursive: true });
  await fs.symlink(outside, path.join(project, '.codex'), DIR_LINK);
  const blocked = await discover();
  expect(blocked.candidates.map(row => row.name)).toEqual(['agent']);
  expect(blocked.errors.map(row => [row.source, row.reason])).toContainEqual(['project', 'unsafe-path']);
});

it('rejects project cwd escaping the project but tolerates a missing or malformed user config', async () => {
  await config('[mcp_servers.]\ninvalid = true');
  await write(path.join(project, '.codex/config.toml'), `
[mcp_servers.good]
command = "node"
[mcp_servers.escape]
command = "node"
cwd = ${JSON.stringify(base)}
`);
  const result = await discover();
  expect(result.errors.map(row => row.source)).toContain('user');
  expect(result.candidates.map(row => row.name)).toEqual(['good']);
  expect(result.rejected.map(row => row.name)).toEqual(['escape']);
});
