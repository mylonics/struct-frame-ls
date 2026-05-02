import * as path from 'path';
import * as fs from 'fs';
import {
  workspace, ExtensionContext, ConfigurationTarget,
  Uri, commands, window, Location, Position,
  MarkdownString, Hover, Range, ViewColumn, Selection
} from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  Middleware
} from 'vscode-languageclient/node';

let client: LanguageClient;

interface SfCompileGeneratedFileEntry {
  path: string;
  namespace: string | null;
  element: string;
  qualified_element: string;
}

interface SfCompileEntry {
  name: string;
  package: string;
  source_file: string;
  generated_files: Record<string, SfCompileGeneratedFileEntry>;
}

interface SfCompileConfig {
  messages: SfCompileEntry[];
  nested_messages?: SfCompileEntry[];
  enums: SfCompileEntry[];
}

function getCompileConfigFsPath(): string | null {
  const config = workspace.getConfiguration('structFrameLs');
  const configPath = config.get<string>('compileConfigPath') || 'sf_compile.json';
  if (path.isAbsolute(configPath)) return configPath;
  const folders = workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return path.join(folders[0].uri.fsPath, configPath);
  }
  return null;
}

function readCompileConfig(fsPath: string): SfCompileConfig | null {
  try {
    return JSON.parse(fs.readFileSync(fsPath, 'utf-8')) as SfCompileConfig;
  } catch {
    return null;
  }
}

function findLineInFile(fsPath: string, name: string): number {
  try {
    const re = new RegExp(`\\b${name}\\b`);
    const lines = fs.readFileSync(fsPath, 'utf-8').split('\n');
    const idx = lines.findIndex(l => re.test(l));
    return idx >= 0 ? idx : 0;
  } catch {
    return 0;
  }
}

function tryAutoSetCompileConfigPath(docUri: string): void {
  if (!path.basename(docUri).toLowerCase().endsWith('sf_compile.json')) return;

  const config = workspace.getConfiguration('structFrameLs');
  const current = config.inspect<string>('compileConfigPath');

  // Only auto-set if the user hasn't explicitly configured the path
  const hasUserValue =
    (current?.workspaceValue !== undefined && current.workspaceValue !== '') ||
    (current?.workspaceFolderValue !== undefined && current.workspaceFolderValue !== '');
  if (hasUserValue) return;

  // Compute a workspace-relative path if possible, otherwise store absolute
  const folders = workspace.workspaceFolders;
  let configPath = docUri.startsWith('file://') ? decodeURIComponent(docUri.replace(/^file:\/\/\/?/, '').replace(/\//g, path.sep)) : docUri;
  if (folders && folders.length > 0) {
    const root = folders[0].uri.fsPath;
    if (configPath.startsWith(root)) {
      configPath = path.relative(root, configPath);
    }
  }

  config.update('compileConfigPath', configPath, ConfigurationTarget.Workspace);
}

export function activate(context: ExtensionContext): void {
  const serverModule = context.asAbsolutePath(
    path.join('server', 'out', 'server.js')
  );

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] }
    }
  };

  const middleware: Middleware = {
    provideHover: async (document, position, token, next) => {
      const hover = await next(document, position, token);
      if (!hover) return hover;
      const hasOurCommand = hover.contents.some(c => {
        const val = c instanceof MarkdownString ? c.value : typeof c === 'string' ? c : '';
        return val.includes('command:structFrameLs.');
      });
      if (!hasOurCommand) return hover;
      return new Hover(
        hover.contents.map(c => {
          const value = c instanceof MarkdownString ? c.value
            : typeof c === 'string' ? c
            : (c as { language: string; value: string }).value ?? '';
          const md = new MarkdownString(value);
          md.isTrusted = true;
          return md;
        }),
        hover.range
      );
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'struct-frame' }],
    synchronize: {
      fileEvents: [
        workspace.createFileSystemWatcher('**/*.sf'),
        workspace.createFileSystemWatcher('**/sf_compile.json')
      ],
      configurationSection: 'structFrameLs'
    },
    middleware
  };

  client = new LanguageClient(
    'struct-frame-ls',
    'Struct Frame Language Server',
    serverOptions,
    clientOptions
  );

  client.start();

  context.subscriptions.push(
    commands.registerCommand('structFrameLs.showGeneratedFiles', async (args: { name: string }) => {
      const configFsPath = getCompileConfigFsPath();
      if (!configFsPath) {
        window.showWarningMessage('Struct Frame: compile config path not configured.');
        return;
      }
      const config = readCompileConfig(configFsPath);
      if (!config) {
        window.showWarningMessage(`Struct Frame: could not read ${configFsPath}`);
        return;
      }
      const entry =
        config.messages.find(m => m.name === args.name) ||
        (config.nested_messages ?? []).find(m => m.name === args.name) ||
        config.enums.find(e => e.name === args.name);
      if (!entry) {
        window.showWarningMessage(`Struct Frame: no generated files found for ${args.name}`);
        return;
      }
      const configDir = path.dirname(configFsPath);

      interface LangItem {
        label: string;
        description: string;
        detail: string;
        absPath: string;
        element: string;
      }

      const items: LangItem[] = [];
      const seen = new Set<string>();
      for (const [lang, fileEntry] of Object.entries(entry.generated_files)) {
        if (!fileEntry?.path) continue;
        const absPath = path.isAbsolute(fileEntry.path) ? fileEntry.path : path.resolve(configDir, fileEntry.path);
        if (seen.has(absPath) || !fs.existsSync(absPath)) continue;
        seen.add(absPath);
        const nsLabel = fileEntry.namespace ? ` (${fileEntry.namespace})` : '';
        items.push({
          label: `$(symbol-class) ${lang.toUpperCase()}`,
          description: fileEntry.qualified_element,
          detail: `${fileEntry.path}${nsLabel}`,
          absPath,
          element: fileEntry.element
        });
      }

      if (items.length === 0) {
        window.showInformationMessage(`Struct Frame: no generated files exist on disk for ${args.name}`);
        return;
      }

      const picked = await window.showQuickPick(items, {
        title: `Generated files for ${args.name}`,
        placeHolder: 'Select language target to open'
      });
      if (!picked) return;

      const line = findLineInFile(picked.absPath, picked.element);
      const doc = await workspace.openTextDocument(Uri.file(picked.absPath));
      const editor = await window.showTextDocument(doc, ViewColumn.Beside);
      const pos = new Position(line, 0);
      editor.selection = new Selection(pos, pos);
      editor.revealRange(new Range(pos, pos));
    })
  );

  context.subscriptions.push(
    workspace.onDidOpenTextDocument(doc => {
      tryAutoSetCompileConfigPath(doc.uri.toString());
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
