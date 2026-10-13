import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { initPlugins } from '../src/renderer/plugins.js';

let dom: JSDOM;
let api: Record<string, ReturnType<typeof vi.fn>>;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const candidate = {
  id: 'codex:local',
  fingerprint: 'first-revision',
  name: '<img src=x onerror=alert(1)>',
  sourceKind: 'stdio' as const,
  sourcePath: 'C:\\Users\\Example\\.codex\\config.toml',
  executable: 'codex-mcp.exe',
  argumentCount: 3,
  cwd: 'C:\\Projects\\example',
  environmentNames: ['ACCESS_TOKEN', 'PROJECT_MODE'],
  headerNames: [],
  supported: true
};
const response = <T>(data: T) => ({ ok: true as const, data });

beforeEach(() => {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new dom.window.Event('close'));
  };
  api = {
    pluginsSnapshot: vi.fn().mockResolvedValue(response({ plugins: [], catalog: [], schemaRevision: 0 })),
    pluginsCodexCandidates: vi.fn().mockResolvedValue(response([candidate])),
    pluginsCodexImport: vi.fn().mockResolvedValue(response({ plugins: [], catalog: [], schemaRevision: 1 })),
    pluginsInstall: vi.fn(),
    onPluginsChanged: vi.fn()
  };
  Object.assign(dom.window, { api });
});

afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

async function openCandidates(): Promise<void> {
  initPlugins();
  await tick();
  document.getElementById('pluginsAdd')!.click();
  const button = [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Import from Codex')!;
  expect(button).toBeDefined();
  button.click();
  await tick();
}

function approve(): void {
  const consent = document.querySelector<HTMLInputElement>('#pluginDialog input[type=checkbox]')!;
  consent.checked = true;
  consent.dispatchEvent(new dom.window.Event('change'));
}

it('requires an explicit import action before passive discovery and never runs an unreviewed server', async () => {
  initPlugins();
  await tick();
  expect(api.pluginsCodexCandidates).not.toHaveBeenCalled();
  expect(api.pluginsCodexImport).not.toHaveBeenCalled();
  document.getElementById('pluginsAdd')!.click();
  expect(api.pluginsCodexCandidates).not.toHaveBeenCalled();
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Import from Codex')!.click();
  await tick();
  expect(api.pluginsCodexCandidates).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('[data-codex-candidates] .plugin-tool')).toHaveLength(1);
  expect(api.pluginsInstall).not.toHaveBeenCalled();
  expect(api.pluginsCodexImport).not.toHaveBeenCalled();
});

it('previews safe metadata without exposing argument values, with separate confirmation', async () => {
  await openCandidates();
  expect(document.querySelector('[data-codex-candidates] img')).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-codex-candidates] button')!.click();
  const body = document.querySelector('#pluginDialog')!;
  expect(body.textContent).toContain(candidate.executable);
  expect(body.textContent).toContain(candidate.cwd);
  expect(body.textContent).toContain(candidate.sourcePath);
  expect(body.textContent).toContain('Argument count3');
  expect(body.textContent).toContain('ACCESS_TOKEN');
  expect(body.textContent).toContain('PROJECT_MODE');
  expect(body.querySelector('script, img')).toBeNull();
  expect(body.textContent).not.toContain('<script>alert(1)</script>');
  expect(body.textContent).not.toContain('secret-value');
  const confirm = [...body.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => node.textContent === 'Import and approve')!;
  expect(confirm.disabled).toBe(true);
  confirm.click(); await tick();
  expect(api.pluginsCodexImport).not.toHaveBeenCalled();
  approve();
  expect(confirm.disabled).toBe(false);
  confirm.click(); await tick();
  expect(api.pluginsCodexImport).toHaveBeenCalledExactlyOnceWith({
    id: candidate.id, fingerprint: candidate.fingerprint
  });
  expect(api.pluginsInstall).not.toHaveBeenCalled();
});

it('requires re-review of a changed Codex fingerprint rather than retrying stale approval', async () => {
  api.pluginsCodexImport!.mockResolvedValueOnce({ ok: false, error: 'CODEX_CONFIG_CHANGED: Refresh candidates and approve again.' });
  await openCandidates();
  document.querySelector<HTMLButtonElement>('[data-codex-candidates] button')!.click();
  approve();
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Import and approve')!.click();
  await tick();
  expect(api.pluginsCodexImport).toHaveBeenCalledExactlyOnceWith({
    id: candidate.id, fingerprint: candidate.fingerprint
  });
  expect(document.querySelector('.toast')!.textContent).toContain('CODEX_CONFIG_CHANGED');
  expect(document.querySelector('#pluginDialog')).not.toBeNull();
  expect(document.querySelector<HTMLInputElement>('#pluginDialog input[type=checkbox]')!.disabled).toBe(true);
  expect(document.querySelector('#pluginDialog')!.textContent).toContain('review the configuration again');
  api.pluginsCodexCandidates!.mockResolvedValue(response([{ ...candidate, fingerprint: 'changed-revision', argumentCount: 4 }]));
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Back to candidates')!.click();
  await tick();
  expect(api.pluginsCodexCandidates).toHaveBeenCalledTimes(2);
  expect(api.pluginsCodexImport).toHaveBeenCalledTimes(1);
  document.querySelector<HTMLButtonElement>('[data-codex-candidates] button')!.click();
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Import and approve')!;
  expect(confirm.disabled).toBe(true);
  approve();
  confirm.click(); await tick();
  expect(api.pluginsCodexImport).toHaveBeenLastCalledWith({
    id: candidate.id, fingerprint: 'changed-revision'
  });
});

it('shows unsupported Codex definitions but never offers to approve or launch them', async () => {
  api.pluginsCodexCandidates!.mockResolvedValue(response([{
    ...candidate, supported: false, reason: 'Command cannot be safely imported.'
  }]));
  await openCandidates();
  expect(document.querySelector('[data-codex-candidates]')!.textContent).toContain('Command cannot be safely imported.');
  document.querySelector<HTMLButtonElement>('[data-codex-candidates] button')!.click();
  const consent = document.querySelector<HTMLInputElement>('#pluginDialog input[type=checkbox]')!;
  expect(consent.disabled).toBe(true);
  const action = [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Import and approve')!;
  expect(action.disabled).toBe(true);
  expect(api.pluginsCodexImport).not.toHaveBeenCalled();
});

it('distinguishes an approved fingerprint from a changed one requiring reapproval', async () => {
  api.pluginsSnapshot!.mockResolvedValue(response({ schemaRevision: 1, catalog: [], plugins: [{
    id: 'imported', name: 'existing', codexImport: {
      id: candidate.id, fingerprint: candidate.fingerprint, sourcePath: candidate.sourcePath
    }, source: { kind: 'command', command: 'codex-mcp.exe' }, config: {}, credentialKeys: [],
    version: '', license: '', enabled: true, status: 'ready', tools: [], installedAt: 1
  }] }));
  await openCandidates();
  expect(document.querySelector('[data-codex-candidates]')!.textContent).toContain('Already imported · current configuration');
  document.querySelector<HTMLButtonElement>('[data-codex-candidates] button')!.click();
  expect(document.querySelector<HTMLInputElement>('#pluginDialog input[type=checkbox]')!.disabled).toBe(true);
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Back to candidates')!.click();
  await tick();
  api.pluginsCodexCandidates!.mockResolvedValue(response([{ ...candidate, fingerprint: 'new-security-revision' }]));
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Refresh candidates')!.click();
  await tick();
  expect(document.querySelector('[data-codex-candidates]')!.textContent).toContain('Configuration changed · reapproval required');
  document.querySelector<HTMLButtonElement>('[data-codex-candidates] button')!.click();
  expect(document.querySelector<HTMLInputElement>('#pluginDialog input[type=checkbox]')!.disabled).toBe(false);
  approve();
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Reapprove and reconnect')!.click();
  await tick();
  expect(api.pluginsCodexImport).toHaveBeenCalledExactlyOnceWith({
    id: candidate.id, fingerprint: 'new-security-revision'
  });
});
