export type PluginSource = {
  kind: 'npm' | 'python' | 'command' | 'remote' | 'mcpb' | 'github';
  package?: string;
  version?: string;
  /** Reviewed exact Python dependency pins, resolved together with the server package. */
  dependencies?: { package: string; version: string }[];
  command?: string;
  args?: string[];
  url?: string;
  /** Remote OAuth is explicit; omitted sources keep their existing static headers. */
  auth?: 'oauth';
  path?: string;
};

/** Passive, never-started configuration preview; credentials and environment values are omitted. */
export interface CodexMcpCandidate {
  /** Stable configuration-defined identity; never executable data supplied to install IPC. */
  id: string;
  /** Hash of security-relevant source definition. Main re-reads before approval. */
  fingerprint: string;
  name: string;
  sourceKind: 'stdio' | 'http';
  sourcePath: string;
  /** Never include raw executable paths, arguments or endpoint paths in IPC previews. */
  executable?: string;
  argumentCount?: number;
  cwd?: string;
  endpointHost?: string;
  environmentNames: string[];
  headerNames: string[];
  supported: boolean;
  reason?: string;
}

/** The user's explicit selection; source/command cannot be supplied from the renderer. */
export interface CodexMcpApproval {
  id: string;
  fingerprint: string;
}

export interface CodexMcpImportOrigin extends CodexMcpApproval {
  sourcePath: string;
  /** A display-only configured working directory, part of the fingerprint. */
  cwd?: string;
}
export interface PluginConfigPatch {
  config?: Record<string, string>;
  credentials?: Record<string, string>;
  source?: PluginSource;
  name?: string;
}
export interface PluginInstallRequest extends PluginConfigPatch {
  catalogId?: string;
}
export interface PluginField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}
export interface PluginCatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  source: PluginSource;
  homepage: string;
  license: string;
  instructions: string[];
  fields: PluginField[];
  /** Representative tool names or documented action labels; live discovery determines actual tools. */
  tools?: string[];
}
export interface PluginToolView {
  name: string;
  exposedName: string;
  description?: string;
  enabled: boolean;
  published?: boolean;
  exposureError?: string;
}
export interface PluginView {
  id: string;
  name: string;
  catalogId?: string;
  source: PluginSource;
  config: Record<string, string>;
  credentialKeys: string[];
  fields?: PluginField[];
  version: string;
  license: string;
  homepage?: string;
  enabled: boolean;
  status: 'installed' | 'connecting' | 'ready' | 'disabled' | 'error' | 'needs-auth' | 'authenticating';
  error?: string;
  tools: PluginToolView[];
  installedAt: number;
  /** Approved import from Codex configuration, revalidated before every server start. */
  codexImport?: CodexMcpImportOrigin;
}
export interface PluginSnapshot {
  plugins: PluginView[];
  catalog: PluginCatalogEntry[];
  schemaRevision: number;
}
