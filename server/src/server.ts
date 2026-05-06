import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  Location,
  Range,
  Position,
  Hover,
  MarkupKind,
  DocumentSymbol,
  SymbolKind,
  Definition,
  FileChangeType,
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

interface FieldDefinition {
  name: string;
  type: string;
  tag: number;
  repeated: boolean;
  options: Record<string, string>;
  line: number;
}

interface OneofDefinition {
  name: string;
  line: number;
  endLine: number;
  fields: FieldDefinition[];
  options: Record<string, string>;
}

interface MessageDefinition {
  name: string;
  line: number;
  endLine: number;
  fields: FieldDefinition[];
  oneofs: OneofDefinition[];
  options: Record<string, string>;
  optionLines: Record<string, number>;
}

interface EnumValue {
  name: string;
  value: number;
  line: number;
}

interface EnumDefinition {
  name: string;
  line: number;
  endLine: number;
  values: EnumValue[];
  parentMessage?: string;
}

interface ParsedDocument {
  uri: string;
  packageName: string;
  imports: string[];
  messages: MessageDefinition[];
  enums: EnumDefinition[];
  fileOptions: Record<string, string>;
  fileOptionLines: Record<string, number>;
}

const parsedDocuments = new Map<string, ParsedDocument>();

// --- sf_compile.json support ---

interface SfCompileGeneratedFileEntry {
  path: string;
  namespace: string | null;
  element: string;
  qualified_element: string;
}

interface SfCompileGeneratedFiles {
  [key: string]: SfCompileGeneratedFileEntry | undefined;
}

interface SfCompileEntry {
  name: string;
  package: string;
  source_file: string;
  generated_files: SfCompileGeneratedFiles;
  parent_message?: string;
}

interface SfCompileConfig {
  messages: SfCompileEntry[];
  nested_messages?: SfCompileEntry[];
  enums: SfCompileEntry[];
}

let sfCompileConfig: SfCompileConfig | null = null;
let sfCompileConfigPath = 'sf_compile.json';
let workspaceRoot = '';

function loadSfCompileConfig(): void {
  if (!workspaceRoot) {
    connection.console.warn('loadSfCompileConfig: workspaceRoot is not set, skipping.');
    return;
  }
  let configPath = sfCompileConfigPath;
  if (!path.isAbsolute(configPath)) {
    configPath = path.join(workspaceRoot, configPath);
  }
  connection.console.log(`loadSfCompileConfig: reading '${configPath}'`);
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    sfCompileConfig = JSON.parse(content) as SfCompileConfig;
    const msgCount = sfCompileConfig.messages.length + (sfCompileConfig.nested_messages?.length ?? 0);
    const enumCount = sfCompileConfig.enums.length;
    connection.console.log(`loadSfCompileConfig: loaded ${msgCount} message(s) and ${enumCount} enum(s) from '${configPath}'`);
  } catch (err) {
    sfCompileConfig = null;
    connection.console.error(`loadSfCompileConfig: failed to read/parse '${configPath}': ${err}`);
  }
}

function findInCompileConfig(name: string): SfCompileEntry | null {
  if (!sfCompileConfig) return null;
  return (
    sfCompileConfig.messages.find(m => m.name === name) ||
    (sfCompileConfig.nested_messages ?? []).find(m => m.name === name) ||
    sfCompileConfig.enums.find(e => e.name === name) ||
    null
  );
}

function isEnumInCompileConfig(name: string): boolean {
  if (!sfCompileConfig) return false;
  return sfCompileConfig.enums.some(e => e.name === name);
}

function getCompileConfigSourceDir(): string {
  if (!workspaceRoot) return '';
  let configPath = sfCompileConfigPath;
  if (!path.isAbsolute(configPath)) {
    configPath = path.join(workspaceRoot, configPath);
  }
  return path.dirname(configPath);
}

async function refreshConfiguration(): Promise<void> {
  if (!hasConfigurationCapability) {
    connection.console.warn('refreshConfiguration: client does not support workspace configuration; using defaults.');
    loadSfCompileConfig();
    return;
  }
  const config = await connection.workspace.getConfiguration('structFrameLs');
  sfCompileConfigPath = (config?.compileConfigPath as string) || 'sf_compile.json';
  connection.console.log(`refreshConfiguration: compileConfigPath = '${sfCompileConfigPath}'`);
  loadSfCompileConfig();
}

const PRIMITIVE_TYPES = [
  'int8', 'int16', 'int32', 'int64',
  'uint8', 'uint16', 'uint32', 'uint64',
  'float', 'double', 'bool', 'string'
];

const PRIMITIVE_TYPE_DOCS: Record<string, string> = {
  'int8': 'Signed 8-bit integer (-128 to 127)',
  'int16': 'Signed 16-bit integer (-32768 to 32767)',
  'int32': 'Signed 32-bit integer (-2147483648 to 2147483647)',
  'int64': 'Signed 64-bit integer',
  'uint8': 'Unsigned 8-bit integer (0 to 255)',
  'uint16': 'Unsigned 16-bit integer (0 to 65535)',
  'uint32': 'Unsigned 32-bit integer (0 to 4294967295)',
  'uint64': 'Unsigned 64-bit integer',
  'float': 'Single-precision floating point (32-bit)',
  'double': 'Double-precision floating point (64-bit)',
  'bool': 'Boolean value (true or false)',
  'string': 'UTF-8 string'
};

const KEYWORDS = ['package', 'import', 'option', 'message', 'enum', 'repeated', 'oneof'];
const FILE_OPTION_NAMES = ['pkgid'];
const MESSAGE_OPTION_NAMES = ['msgid', 'variable', 'is_envelope'];
const ONEOF_OPTION_NAMES = ['discriminator'];
const DISCRIMINATOR_VALUES = ['auto', 'msgid', 'field_order', 'none'];
const FIELD_OPTION_NAMES = ['size=', 'max_size=', 'element_size=', 'flatten='];

function normalizeFieldOptionKey(key: string): string {
  if (key.startsWith('struct_frame.')) return key.substring('struct_frame.'.length);
  if (key.startsWith('sf.')) return key.substring('sf.'.length);
  return key;
}

function parseFieldOptions(optionsStr: string): Record<string, string> {
  const options: Record<string, string> = {};
  for (const opt of optionsStr.split(',')) {
    const kv = opt.trim().match(/^((?:(?:sf|struct_frame)\.)?(\w+))\s*=\s*(.+)$/);
    if (kv) options[normalizeFieldOptionKey(kv[1])] = kv[3].trim();
  }
  return options;
}

function parseDocument(uri: string, content: string): ParsedDocument {
  const lines = content.split('\n');
  const doc: ParsedDocument = {
    uri,
    packageName: '',
    imports: [],
    messages: [],
    enums: [],
    fileOptions: {},
    fileOptionLines: {}
  };

  let currentMessage: MessageDefinition | null = null;
  let currentEnum: EnumDefinition | null = null;
  let currentNestedEnum: EnumDefinition | null = null;
  let currentOneof: OneofDefinition | null = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Strip line comments
    const commentIdx = rawLine.indexOf('//');
    const line = commentIdx >= 0 ? rawLine.substring(0, commentIdx) : rawLine;
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (braceDepth === 0) {
      // Package declaration
      const pkgMatch = trimmed.match(/^package\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/);
      if (pkgMatch) {
        doc.packageName = pkgMatch[1];
        continue;
      }

      // Import
      const importMatch = trimmed.match(/^import\s+"([^"]+)"\s*;/);
      if (importMatch) {
        doc.imports.push(importMatch[1]);
        continue;
      }

      // File-level option (e.g. pkgid)
      const fileOptMatch = trimmed.match(/^option\s+(\w+)\s*=\s*(.+?)\s*;/);
      if (fileOptMatch) {
        doc.fileOptions[fileOptMatch[1]] = fileOptMatch[2];
        doc.fileOptionLines[fileOptMatch[1]] = i;
        continue;
      }

      // Message definition
      const msgMatch = trimmed.match(/^message\s+([A-Z][a-zA-Z0-9_]*)\s*\{/);
      if (msgMatch) {
        currentMessage = {
          name: msgMatch[1],
          line: i,
          endLine: i,
          fields: [],
          oneofs: [],
          options: {},
          optionLines: {}
        };
        braceDepth = 1;
        continue;
      }

      // Enum definition
      const enumMatch = trimmed.match(/^enum\s+([A-Z][a-zA-Z0-9_]*)\s*\{/);
      if (enumMatch) {
        currentEnum = {
          name: enumMatch[1],
          line: i,
          endLine: i,
          values: []
        };
        braceDepth = 1;
        continue;
      }
    }

    if (braceDepth > 0) {
      // Detect nested enum start (inside a message, before counting braces)
      if (currentMessage && !currentNestedEnum && !currentOneof && braceDepth === 1) {
        const nestedEnumMatch = trimmed.match(/^enum\s+([A-Z][a-zA-Z0-9_]*)\s*\{/);
        if (nestedEnumMatch) {
          currentNestedEnum = {
            name: nestedEnumMatch[1],
            parentMessage: currentMessage.name,
            line: i,
            endLine: i,
            values: []
          };
          braceDepth = 2;
          continue;
        }
      }

      // Detect oneof start (inside a message, before counting braces)
      if (currentMessage && !currentNestedEnum && !currentOneof && braceDepth === 1) {
        const oneofMatch = trimmed.match(/^oneof\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/);
        if (oneofMatch) {
          currentOneof = {
            name: oneofMatch[1],
            line: i,
            endLine: i,
            fields: [],
            options: {}
          };
          braceDepth = 2;
          continue;
        }
      }

      // Count braces
      for (const ch of trimmed) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }

      if (braceDepth === 0) {
        // Closing brace
        if (currentMessage) {
          currentMessage.endLine = i;
          doc.messages.push(currentMessage);
          currentMessage = null;
        }
        if (currentEnum) {
          currentEnum.endLine = i;
          doc.enums.push(currentEnum);
          currentEnum = null;
        }
        continue;
      }

      // Nested enum closing (depth went from 2 back to 1)
      if (currentNestedEnum && braceDepth === 1) {
        currentNestedEnum.endLine = i;
        doc.enums.push(currentNestedEnum);
        currentNestedEnum = null;
        continue;
      }

      // Oneof closing (depth went from 2 back to 1)
      if (currentOneof && braceDepth === 1) {
        currentOneof.endLine = i;
        currentMessage!.oneofs.push(currentOneof);
        currentOneof = null;
        continue;
      }

      if (currentNestedEnum) {
        // Nested enum value: supports both SCREAMING_SNAKE_CASE and PascalCase
        const enumValMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*([0-9]+)\s*;/);
        if (enumValMatch) {
          currentNestedEnum.values.push({
            name: enumValMatch[1],
            value: parseInt(enumValMatch[2], 10),
            line: i
          });
        }
        continue;
      }

      if (currentOneof) {
        // Option inside oneof (e.g. discriminator)
        const optMatch = trimmed.match(/^option\s+(\w+)\s*=\s*(.+?)\s*;/);
        if (optMatch) {
          currentOneof.options[optMatch[1]] = optMatch[2];
          continue;
        }
        // Field inside oneof
        const fieldMatch = trimmed.match(
          /^(repeated\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([0-9]+)\s*(?:\[([^\]]*)\])?\s*;/
        );
        if (fieldMatch) {
          const repeated = !!fieldMatch[1];
          const fieldType = fieldMatch[2];
          const fieldName = fieldMatch[3];
          const tag = parseInt(fieldMatch[4], 10);
          const optionsStr = fieldMatch[5] || '';
          currentOneof.fields.push({
            name: fieldName,
            type: fieldType,
            tag,
            repeated,
            options: optionsStr ? parseFieldOptions(optionsStr) : {},
            line: i
          });
        }
        continue;
      }

      if (currentEnum) {
        // Enum value: supports both SCREAMING_SNAKE_CASE and PascalCase
        const enumValMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*([0-9]+)\s*;/);
        if (enumValMatch) {
          currentEnum.values.push({
            name: enumValMatch[1],
            value: parseInt(enumValMatch[2], 10),
            line: i
          });
        }
        continue;
      }

      if (currentMessage) {
        // Option inside message
        const optMatch = trimmed.match(/^option\s+(\w+)\s*=\s*(.+?)\s*;/);
        if (optMatch) {
          currentMessage.options[optMatch[1]] = optMatch[2];
          currentMessage.optionLines[optMatch[1]] = i;
          continue;
        }

        // Field declaration (supports repeated, and field options)
        // repeated? type name = tag [options];
        const fieldMatch = trimmed.match(
          /^(repeated\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([0-9]+)\s*(?:\[([^\]]*)\])?\s*;/
        );
        if (fieldMatch) {
          const repeated = !!fieldMatch[1];
          const fieldType = fieldMatch[2];
          const fieldName = fieldMatch[3];
          const tag = parseInt(fieldMatch[4], 10);
          const optionsStr = fieldMatch[5] || '';
          currentMessage.fields.push({
            name: fieldName,
            type: fieldType,
            tag,
            repeated,
            options: optionsStr ? parseFieldOptions(optionsStr) : {},
            line: i
          });
        }
      }
    }
  }

  return doc;
}

function makeDiagnostic(line: number, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error): Diagnostic {
  return {
    severity,
    range: Range.create(line, 0, line, 10000),
    message,
    source: 'struct-frame'
  };
}

function validateDocument(uri: string): void {
  const parsed = getOrParseDocument(uri);
  const diagnostics: Diagnostic[] = [];

  // All known message names (including imports) for type resolution
  const allDefs = getAllDefinitions(uri);
  const messageNames = new Set(allDefs.messages.map(m => m.name));

  // File-level: pkgid range 0–255
  const pkgidStr = parsed.fileOptions['pkgid'];
  let hasPkgid = false;
  if (pkgidStr !== undefined) {
    const pkgid = parseInt(pkgidStr, 10);
    if (isNaN(pkgid) || pkgid < 0 || pkgid > 255) {
      diagnostics.push(makeDiagnostic(
        parsed.fileOptionLines['pkgid'] ?? 0,
        `pkgid must be 0–255, got '${pkgidStr}'`
      ));
    } else {
      hasPkgid = true;
    }
  }

  const maxMsgid = hasPkgid ? 65535 : 255;
  const msgidMap = new Map<number, string>(); // msgid value → message name

  for (const msg of parsed.messages) {
    // msgid range and uniqueness
    const msgidStr = msg.options['msgid'];
    if (msgidStr !== undefined) {
      const msgid = parseInt(msgidStr, 10);
      const optLine = msg.optionLines['msgid'] ?? msg.line;
      if (isNaN(msgid) || msgid < 0 || msgid > maxMsgid) {
        diagnostics.push(makeDiagnostic(optLine, `msgid must be 0–${maxMsgid}, got '${msgidStr}'`));
      } else if (msgidMap.has(msgid)) {
        diagnostics.push(makeDiagnostic(optLine,
          `Duplicate msgid ${msgid} (already used by '${msgidMap.get(msgid)}')`));
      } else {
        msgidMap.set(msgid, msg.name);
      }
    }

    // is_envelope: requires exactly 1 oneof; all oneof variants must be message types
    if (msg.options['is_envelope'] === 'true') {
      const optLine = msg.optionLines['is_envelope'] ?? msg.line;
      if (msg.oneofs.length !== 1) {
        diagnostics.push(makeDiagnostic(optLine,
          `is_envelope requires exactly one oneof field (found ${msg.oneofs.length})`));
      } else {
        for (const field of msg.oneofs[0].fields) {
          if (!messageNames.has(field.type)) {
            diagnostics.push(makeDiagnostic(field.line,
              `is_envelope: oneof variant '${field.name}' must be a message type (got '${field.type}')`));
          }
        }
      }
    }

    // oneof discriminator validation
    for (const oneof of msg.oneofs) {
      const disc = oneof.options['discriminator'];
      if (disc === 'msgid') {
        for (const field of oneof.fields) {
          const variantMsg = allDefs.messages.find(m => m.name === field.type);
          if (!variantMsg) {
            diagnostics.push(makeDiagnostic(field.line,
              `discriminator=msgid: variant '${field.name}' type '${field.type}' is not a known message`));
          } else if (!variantMsg.options['msgid']) {
            diagnostics.push(makeDiagnostic(field.line,
              `discriminator=msgid: variant '${field.name}' (type '${field.type}') does not have msgid`));
          }
        }
      }
    }

    // Field-level validation
    for (const field of msg.fields) {
      const hasSize = 'size' in field.options;
      const hasMaxSize = 'max_size' in field.options;
      const hasElementSize = 'element_size' in field.options;

      if (field.type === 'string' && !field.repeated) {
        // Plain string: exactly one of size or max_size
        if (!hasSize && !hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `String field '${field.name}' requires [size=N] or [max_size=N]`));
        } else if (hasSize && hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `String field '${field.name}' cannot have both size and max_size`));
        }
        if (hasElementSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `element_size is only valid on repeated string fields`));
        }
      } else if (field.type === 'string' && field.repeated) {
        // repeated string: size/max_size AND element_size
        if (!hasSize && !hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated string field '${field.name}' requires [size=N] or [max_size=N]`));
        } else if (hasSize && hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated string field '${field.name}' cannot have both size and max_size`));
        }
        if (!hasElementSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated string field '${field.name}' requires [element_size=M]`));
        }
      } else if (field.repeated && PRIMITIVE_TYPES.includes(field.type)) {
        // repeated primitive (array): size or max_size
        if (!hasSize && !hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated field '${field.name}' requires [size=N] or [max_size=N]`));
        } else if (hasSize && hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated field '${field.name}' cannot have both size and max_size`));
        }
        if (hasElementSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `element_size is only valid on repeated string fields`));
        }
      }

      // flatten: only on message-type fields; check name collisions with parent
      if (field.options['flatten'] === 'true') {
        if (!messageNames.has(field.type)) {
          diagnostics.push(makeDiagnostic(field.line,
            `flatten is only valid on message-type fields ('${field.type}' is not a known message)`));
        } else {
          const nestedMsg = allDefs.messages.find(m => m.name === field.type);
          if (nestedMsg) {
            const parentFieldNames = new Set(
              msg.fields.filter(f => f.name !== field.name).map(f => f.name)
            );
            for (const nf of nestedMsg.fields) {
              if (parentFieldNames.has(nf.name)) {
                diagnostics.push(makeDiagnostic(field.line,
                  `flatten: field '${nf.name}' from '${field.type}' collides with existing field in '${msg.name}'`));
              }
            }
          }
        }
      }
    }
  }

  connection.sendDiagnostics({ uri, diagnostics });
}

function getOrParseDocument(uri: string): ParsedDocument {
  if (parsedDocuments.has(uri)) {
    return parsedDocuments.get(uri)!;
  }

  const doc = documents.get(uri);
  let content: string;
  if (doc) {
    content = doc.getText();
  } else {
    // Try reading from filesystem
    try {
      const filePath = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
      content = fs.readFileSync(filePath, 'utf-8');
      connection.console.log(`getOrParseDocument: read from filesystem '${filePath}'`);
    } catch (err) {
      connection.console.error(`getOrParseDocument: could not read '${uri}': ${err}`);
      return { uri, packageName: '', imports: [], messages: [], enums: [], fileOptions: {}, fileOptionLines: {} };
    }
  }

  const parsed = parseDocument(uri, content);
  parsedDocuments.set(uri, parsed);
  return parsed;
}

function resolveImportUri(importPath: string, currentUri: string): string {
  const currentFilePath = currentUri.startsWith('file://') ? fileURLToPath(currentUri) : currentUri;
  const currentDir = path.dirname(currentFilePath);
  const resolvedPath = path.resolve(currentDir, importPath);
  const resolved = pathToFileURL(resolvedPath).toString();
  connection.console.log(`resolveImportUri: '${importPath}' from '${currentFilePath}' -> '${resolvedPath}'`);
  if (!fs.existsSync(resolvedPath)) {
    connection.console.warn(`resolveImportUri: resolved path does not exist: '${resolvedPath}'`);
  }
  return resolved;
}

function getAllDefinitions(uri: string, visited = new Set<string>()): { messages: MessageDefinition[]; enums: EnumDefinition[] } {
  if (visited.has(uri)) return { messages: [], enums: [] };
  visited.add(uri);

  const parsed = getOrParseDocument(uri);
  const result = { messages: [...parsed.messages], enums: [...parsed.enums] };

  for (const imp of parsed.imports) {
    const importUri = resolveImportUri(imp, uri);
    const imported = getAllDefinitions(importUri, visited);
    result.messages.push(...imported.messages);
    result.enums.push(...imported.enums);
  }

  return result;
}

function getWordAtPosition(text: string, position: Position): { word: string; start: number; end: number } | null {
  const lines = text.split('\n');
  if (position.line >= lines.length) return null;
  const line = lines[position.line];
  let start = position.character;
  let end = position.character;
  while (start > 0 && /[a-zA-Z0-9_]/.test(line[start - 1])) start--;
  while (end < line.length && /[a-zA-Z0-9_]/.test(line[end])) end++;
  const word = line.substring(start, end);
  if (!word) return null;
  return { word, start, end };
}

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;
  hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
  hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
  connection.console.log(`onInitialize: hasConfigurationCapability=${hasConfigurationCapability}, hasWorkspaceFolderCapability=${hasWorkspaceFolderCapability}`);

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [' ', '[', '=', '"']
      },
      definitionProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true
    }
  };

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: { supported: true }
    };
  }

  // Capture workspace root for sf_compile.json resolution
  if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    const folderUri = params.workspaceFolders[0].uri;
    workspaceRoot = folderUri.startsWith('file://') ? fileURLToPath(folderUri) : folderUri;
    connection.console.log(`onInitialize: workspaceRoot='${workspaceRoot}'`);
  } else {
    connection.console.warn('onInitialize: no workspace folders provided; sf_compile.json resolution may fail.');
  }

  return result;
});

connection.onInitialized(async () => {
  connection.console.log('Struct Frame LS initialized.');
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  await refreshConfiguration();
});

connection.onDidChangeConfiguration(async () => {
  await refreshConfiguration();
});

connection.onDidChangeWatchedFiles(params => {
  for (const change of params.changes) {
    if (change.uri.endsWith('sf_compile.json')) {
      loadSfCompileConfig();
    }
    if (change.type === FileChangeType.Deleted) {
      parsedDocuments.delete(change.uri);
    } else {
      parsedDocuments.delete(change.uri);
    }
  }
});

documents.onDidChangeContent(change => {
  parsedDocuments.delete(change.document.uri);
  validateDocument(change.document.uri);
});

documents.onDidClose(e => {
  parsedDocuments.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// Completion
function getCompileConfigCompletionItems(existingDefs: { messages: MessageDefinition[]; enums: EnumDefinition[] }): CompletionItem[] {
  if (!sfCompileConfig) return [];
  const existingNames = new Set([
    ...existingDefs.messages.map(m => m.name),
    ...existingDefs.enums.map(e => e.name)
  ]);
  const items: CompletionItem[] = [];
  for (const entry of sfCompileConfig.messages) {
    if (!existingNames.has(entry.name)) {
      items.push({ label: entry.name, kind: CompletionItemKind.Class, detail: `Message (${entry.package})` });
    }
  }
  for (const entry of (sfCompileConfig.nested_messages ?? [])) {
    if (!existingNames.has(entry.name)) {
      items.push({ label: entry.name, kind: CompletionItemKind.Class, detail: `Nested message (${entry.package})` });
    }
  }
  for (const entry of sfCompileConfig.enums) {
    if (!existingNames.has(entry.name)) {
      const detail = entry.parent_message
        ? `Nested enum (${entry.package}, in ${entry.parent_message})`
        : `Enum (${entry.package})`;
      items.push({ label: entry.name, kind: CompletionItemKind.Enum, detail });
    }
  }
  return items;
}

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const lines = text.split('\n');
  const lineText = lines[params.position.line] || '';
  const lineUpToCursor = lineText.substring(0, params.position.character);
  const trimmedUpToCursor = lineUpToCursor.trim();

  // Inside [ ] - field options
  const bracketStart = lineUpToCursor.lastIndexOf('[');
  const bracketEnd = lineUpToCursor.lastIndexOf(']');
  if (bracketStart > bracketEnd && bracketStart >= 0) {
    const afterBracket = lineUpToCursor.substring(bracketStart + 1);
    // Value completion for flatten= (boolean)
    if (/(?:^|,)\s*(?:(?:sf|struct_frame)\.)?flatten\s*=\s*$/.test(afterBracket)) {
      return [
        { label: 'true', kind: CompletionItemKind.Value },
        { label: 'false', kind: CompletionItemKind.Value }
      ];
    }
    return FIELD_OPTION_NAMES.map(opt => ({
      label: opt,
      kind: CompletionItemKind.Property,
      detail: 'Field option'
    }));
  }

  // Context detection for option completion
  const parsed = getOrParseDocument(params.textDocument.uri);
  const lineNum = params.position.line;
  const inOneof = parsed.messages.some(m =>
    lineNum > m.line && lineNum < m.endLine &&
    m.oneofs.some(o => lineNum > o.line && lineNum < o.endLine)
  );
  const inMessage = !inOneof && parsed.messages.some(m => lineNum > m.line && lineNum < m.endLine);

  // After "option "
  if (/^\s*option\s+$/.test(lineUpToCursor)) {
    const optNames = inOneof ? ONEOF_OPTION_NAMES : inMessage ? MESSAGE_OPTION_NAMES : FILE_OPTION_NAMES;
    return optNames.map(opt => ({
      label: opt,
      kind: CompletionItemKind.Property,
      detail: 'Option name'
    }));
  }

  // After "option discriminator ="
  if (/^\s*option\s+discriminator\s*=\s*$/.test(lineUpToCursor)) {
    return DISCRIMINATOR_VALUES.map(v => ({
      label: v,
      kind: CompletionItemKind.EnumMember,
      detail: 'Discriminator mode',
      insertText: `"${v}"`
    }));
  }

  // After "option variable =" or "option is_envelope ="
  if (/^\s*option\s+(variable|is_envelope)\s*=\s*$/.test(lineUpToCursor)) {
    return [
      { label: 'true', kind: CompletionItemKind.Value },
      { label: 'false', kind: CompletionItemKind.Value }
    ];
  }

  // After "option msgid =" or "option pkgid ="
  if (/^\s*option\s+(msgid|pkgid)\s*=\s*$/.test(lineUpToCursor)) {
    return [{
      label: '1',
      kind: CompletionItemKind.Value,
      detail: 'Numeric option value',
      documentation: 'Enter a numeric ID'
    }];
  }

  // At start of line (keywords)
  if (/^\s*$/.test(trimmedUpToCursor) || trimmedUpToCursor === '') {
    const items: CompletionItem[] = KEYWORDS.map(kw => ({
      label: kw,
      kind: CompletionItemKind.Keyword,
      detail: 'Keyword'
    }));
    return items;
  }

  // Typing the name of an oneof block — no completions needed
  if (/^\s*oneof\s+/.test(lineUpToCursor)) {
    return [];
  }

  const inEnum = parsed.enums.some(e => lineNum > e.line && lineNum < e.endLine);

  if ((inMessage || inOneof) && !inEnum) {
    const isAfterRepeated = /^\s*repeated\s+$/.test(lineUpToCursor);
    const isAtTypePosition = /^\s*(repeated\s+)?$/.test(lineUpToCursor) || isAfterRepeated;

    if (isAtTypePosition || /^\s*(repeated\s+)?[a-zA-Z_][a-zA-Z0-9_]*$/.test(lineUpToCursor)) {
      // Suggest primitive types + user-defined types
      const allDefs = getAllDefinitions(params.textDocument.uri);
      const primitiveItems: CompletionItem[] = PRIMITIVE_TYPES.map(t => ({
        label: t,
        kind: CompletionItemKind.TypeParameter,
        detail: 'Primitive type',
        documentation: PRIMITIVE_TYPE_DOCS[t]
      }));

      const messageItems: CompletionItem[] = allDefs.messages.map(m => ({
        label: m.name,
        kind: CompletionItemKind.Class,
        detail: 'Message type'
      }));

      const enumItems: CompletionItem[] = allDefs.enums.map(e => ({
        label: e.name,
        kind: CompletionItemKind.Enum,
        detail: 'Enum type'
      }));

      return [...primitiveItems, ...messageItems, ...enumItems, ...getCompileConfigCompletionItems(allDefs)];
    }

    // Inside message/oneof, at start of line - suggest keywords
    if (/^\s*$/.test(lineUpToCursor)) {
      const insideMessageKeywords: CompletionItem[] = [
        { label: 'option', kind: CompletionItemKind.Keyword },
        { label: 'repeated', kind: CompletionItemKind.Keyword },
        ...(inMessage && !inOneof ? [{ label: 'oneof', kind: CompletionItemKind.Keyword }] : [])
      ];
      const allDefs = getAllDefinitions(params.textDocument.uri);
      const primitiveItems: CompletionItem[] = PRIMITIVE_TYPES.map(t => ({
        label: t,
        kind: CompletionItemKind.TypeParameter,
        detail: 'Primitive type'
      }));
      const messageItems: CompletionItem[] = allDefs.messages.map(m => ({
        label: m.name,
        kind: CompletionItemKind.Class,
        detail: 'Message type'
      }));
      const enumItems: CompletionItem[] = allDefs.enums.map(e => ({
        label: e.name,
        kind: CompletionItemKind.Enum,
        detail: 'Enum type'
      }));
      return [...insideMessageKeywords, ...primitiveItems, ...messageItems, ...enumItems, ...getCompileConfigCompletionItems(allDefs)];
    }
  }

  // Default: suggest keywords
  return KEYWORDS.map(kw => ({
    label: kw,
    kind: CompletionItemKind.Keyword,
    detail: 'Keyword'
  }));
});

// Go-to-Definition
connection.onDefinition((params: TextDocumentPositionParams): Definition | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    connection.console.warn(`onDefinition: document not found: '${params.textDocument.uri}'`);
    return null;
  }

  const wordInfo = getWordAtPosition(doc.getText(), params.position);
  if (!wordInfo) return null;

  const { word } = wordInfo;

  // Oneof name go-to-definition → navigate to generated companion enum files
  {
    const parsed = getOrParseDocument(params.textDocument.uri);
    for (const msg of parsed.messages) {
      const oneof = msg.oneofs.find(o => o.name === word);
      if (oneof) {
        const rawDisc = (oneof.options['discriminator'] ?? 'auto').replace(/"/g, '');
        if (rawDisc !== 'none') {
          const enumName = word.charAt(0).toUpperCase() + word.slice(1);
          const enumEntry = sfCompileConfig?.enums.find(e => e.name === enumName) ?? null;
          if (enumEntry) {
            const locs = findGeneratedFileLocations(enumName);
            if (locs.length === 1) return locs[0];
            if (locs.length > 1) return locs;
          }
        }
        return null;
      }
    }
  }

  // Only look up PascalCase identifiers (user-defined types)
  if (!/^[A-Z]/.test(word)) return null;

  connection.console.log(`onDefinition: looking up '${word}' in '${params.textDocument.uri}'`);

  function findDefinition(uri: string, visited = new Set<string>()): Location | null {
    if (visited.has(uri)) return null;
    visited.add(uri);

    const parsed = getOrParseDocument(uri);

    const msg = parsed.messages.find(m => m.name === word);
    if (msg) {
      return Location.create(uri, Range.create(msg.line, 0, msg.line, word.length + 8));
    }

    const enm = parsed.enums.find(e => e.name === word);
    if (enm) {
      return Location.create(uri, Range.create(enm.line, 0, enm.line, word.length + 5));
    }

    // Search enum values (e.g. SCREAMING_SNAKE_CASE members)
    for (const e of parsed.enums) {
      const val = e.values.find(v => v.name === word);
      if (val) {
        return Location.create(uri, Range.create(val.line, 0, val.line, word.length));
      }
    }

    for (const imp of parsed.imports) {
      const importUri = resolveImportUri(imp, uri);
      const result = findDefinition(importUri, visited);
      if (result) return result;
    }

    return null;
  }

  const sfLocation = findDefinition(params.textDocument.uri);

  // Determine context: are we on the declaration line itself, or referencing a type in a field?
  const text = doc.getText();
  const lineText = text.split('\n')[params.position.line] || '';
  const isDeclaration = new RegExp(`^\\s*(message|enum)\\s+${word}\\b`).test(lineText);

  if (isDeclaration) {
    // On the declaration → peek all generated files (no .sf)
    const generatedLocations = findGeneratedFileLocations(word);
    if (generatedLocations.length === 0) {
      connection.console.warn(`onDefinition: no generated file locations found for declaration '${word}'.`);
      return null;
    }
    if (generatedLocations.length === 1) return generatedLocations[0];
    return generatedLocations;
  } else {
    // Field type reference → navigate to .sf definition only
    const result = sfLocation || findSfSourceLocation(word) || findEnumValueInCompileConfigSources(word);
    if (!result) {
      connection.console.warn(`onDefinition: could not resolve definition for '${word}' (not found in .sf files or compile config).`);
    }
    return result;
  }
});

function findElementLineInFile(filePath: string, elementName: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const re = new RegExp(`\\b${elementName}\\b`);
    const idx = lines.findIndex(l => re.test(l));
    return idx >= 0 ? idx : 0;
  } catch {
    return 0;
  }
}

function findSfSourceLocation(word: string): Location | null {
  if (!sfCompileConfig) {
    connection.console.warn(`findSfSourceLocation('${word}'): sfCompileConfig is not loaded.`);
    return null;
  }
  const entry = findInCompileConfig(word);
  if (!entry || !entry.source_file) {
    connection.console.log(`findSfSourceLocation('${word}'): no compile config entry found.`);
    return null;
  }
  const sourceDir = getCompileConfigSourceDir();
  if (!sourceDir) {
    connection.console.warn(`findSfSourceLocation('${word}'): could not determine source directory.`);
    return null;
  }
  const sourceFilePath = path.resolve(sourceDir, entry.source_file);
  try {
    if (!fs.statSync(sourceFilePath).isFile()) {
      connection.console.warn(`findSfSourceLocation('${word}'): '${sourceFilePath}' is not a file.`);
      return null;
    }
  } catch (err) {
    connection.console.error(`findSfSourceLocation('${word}'): cannot stat '${sourceFilePath}': ${err}`);
    return null;
  }
  const sourceUri = pathToFileURL(sourceFilePath).toString();
  const parsed = getOrParseDocument(sourceUri);
  const msg = parsed.messages.find(m => m.name === word);
  if (msg) return Location.create(sourceUri, Range.create(msg.line, 0, msg.line, word.length + 8));
  const enm = parsed.enums.find(e => e.name === word);
  if (enm) return Location.create(sourceUri, Range.create(enm.line, 0, enm.line, word.length + 5));
  connection.console.warn(`findSfSourceLocation('${word}'): definition not found in '${sourceFilePath}'.`);
  return null;
}

function findEnumValueInCompileConfigSources(word: string): Location | null {
  if (!sfCompileConfig) return null;
  const sourceDir = getCompileConfigSourceDir();
  if (!sourceDir) return null;
  const seenFiles = new Set<string>();
  for (const enumEntry of sfCompileConfig.enums) {
    if (!enumEntry.source_file) continue;
    const sourceFilePath = path.resolve(sourceDir, enumEntry.source_file);
    if (seenFiles.has(sourceFilePath)) continue;
    seenFiles.add(sourceFilePath);
    try {
      if (!fs.statSync(sourceFilePath).isFile()) continue;
    } catch {
      continue;
    }
    const sourceUri = pathToFileURL(sourceFilePath).toString();
    const parsed = getOrParseDocument(sourceUri);
    for (const e of parsed.enums) {
      const val = e.values.find(v => v.name === word);
      if (val) {
        return Location.create(sourceUri, Range.create(val.line, 0, val.line, word.length));
      }
    }
  }
  return null;
}

function findGeneratedFileLocations(word: string): Location[] {
  if (!sfCompileConfig) {
    connection.console.warn(`findGeneratedFileLocations('${word}'): sfCompileConfig is not loaded.`);
    return [];
  }
  const entry = findInCompileConfig(word);
  if (!entry) {
    connection.console.log(`findGeneratedFileLocations('${word}'): no compile config entry found.`);
    return [];
  }
  const sourceDir = getCompileConfigSourceDir();
  if (!sourceDir) {
    connection.console.warn(`findGeneratedFileLocations('${word}'): could not determine source directory.`);
    return [];
  }
  const locations: Location[] = [];
  const seen = new Set<string>();
  for (const fileEntry of Object.values(entry.generated_files)) {
    if (!fileEntry?.path) continue;
    const absPath = path.resolve(sourceDir, fileEntry.path);
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    try {
      if (!fs.statSync(absPath).isFile()) {
        connection.console.warn(`findGeneratedFileLocations('${word}'): '${absPath}' is not a file, skipping.`);
        continue;
      }
    } catch (err) {
      connection.console.error(`findGeneratedFileLocations('${word}'): cannot stat '${absPath}': ${err}`);
      continue;
    }
    const fileUri = pathToFileURL(absPath).toString();
    const line = findElementLineInFile(absPath, fileEntry.element);
    locations.push(Location.create(fileUri, Range.create(line, 0, line, fileEntry.element.length)));
  }
  if (locations.length === 0) {
    connection.console.warn(`findGeneratedFileLocations('${word}'): no generated files found on disk.`);
  }
  return locations;
}

function buildGeneratedFilesMarkdown(entry: SfCompileEntry): string {
  const files = entry.generated_files;
  const lines = Object.entries(files)
    .filter(([, v]) => v)
    .map(([lang, info]) => {
      const detail = info!.namespace
        ? `\`${info!.element}\` (ns: \`${info!.namespace}\`)`
        : `\`${info!.element}\``;
      return `- **${lang}**: \`${info!.path}\` — ${detail}`;
    });
  if (lines.length === 0) return '';
  const encodedArgs = encodeURIComponent(JSON.stringify([{ name: entry.name }]));
  const peekLink = `[Peek generated files](command:structFrameLs.showGeneratedFiles?${encodedArgs})`;
  return `\n\n---\n**Generated files** (source: \`${entry.source_file}\`) — ${peekLink}\n${lines.join('\n')}`;
}

// Hover
connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const wordInfo = getWordAtPosition(doc.getText(), params.position);
  if (!wordInfo) return null;

  const { word } = wordInfo;

  // Primitive type hover
  if (PRIMITIVE_TYPES.includes(word)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** (primitive type)\n\n${PRIMITIVE_TYPE_DOCS[word]}`
      }
    };
  }

  // User-defined type hover
  if (/^[A-Z]/.test(word)) {
    const text = doc.getText();
    const lineText = text.split('\n')[params.position.line] || '';
    const isDeclaration = new RegExp(`^\\s*(message|enum)\\s+${word}\\b`).test(lineText);
    const allDefs = getAllDefinitions(params.textDocument.uri);

    const msg = allDefs.messages.find(m => m.name === word);
    if (msg) {
      const compileEntry = findInCompileConfig(word);
      const generatedSection = compileEntry ? buildGeneratedFilesMarkdown(compileEntry) : '';
      if (isDeclaration) {
        // On the declaration line — just show generated files, no redundant struct body
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**message ${word}**${generatedSection}`
          }
        };
      }
      const fieldLines = msg.fields.map(f => `  ${f.repeated ? 'repeated ' : ''}${f.type} ${f.name} = ${f.tag};`).join('\n');
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**message ${word}**\n\`\`\`sf\nmessage ${word} {\n${fieldLines}\n}\n\`\`\`${generatedSection}`
        }
      };
    }

    const enm = allDefs.enums.find(e => e.name === word);
    if (enm) {
      const compileEntry = findInCompileConfig(word);
      const generatedSection = compileEntry ? buildGeneratedFilesMarkdown(compileEntry) : '';
      if (isDeclaration) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**enum ${word}**${enm.parentMessage ? ` (nested in \`${enm.parentMessage}\`)` : ''}${generatedSection}`
          }
        };
      }
      const valueLines = enm.values.map(v => `  ${v.name} = ${v.value};`).join('\n');
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**enum ${word}**${enm.parentMessage ? ` (nested in \`${enm.parentMessage}\`)` : ''}\n\`\`\`sf\nenum ${word} {\n${valueLines}\n}\n\`\`\`${generatedSection}`
        }
      };
    }

    // Not found via imports - check compile config for cross-file types
    const compileEntry = findInCompileConfig(word);
    if (compileEntry) {
      const generatedSection = buildGeneratedFilesMarkdown(compileEntry);
      const kind = isEnumInCompileConfig(word) ? 'enum' : 'message';
      const parentNote = compileEntry.parent_message ? ` (nested in \`${compileEntry.parent_message}\`)` : '';
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**${kind} ${word}** (package: \`${compileEntry.package}\`)${parentNote}${generatedSection}`
        }
      };
    }
  }

  // Oneof name hover — show generated discriminator enum
  {
    const parsed = getOrParseDocument(params.textDocument.uri);
    for (const msg of parsed.messages) {
      const oneof = msg.oneofs.find(o => o.name === word);
      if (!oneof) continue;

      const rawDisc = (oneof.options['discriminator'] ?? 'auto').replace(/"/g, '');
      const enumName = word.charAt(0).toUpperCase() + word.slice(1);

      // Look up the companion enum in the compile config (generated for field_order/auto)
      const compileEntry = sfCompileConfig?.enums.find(e => e.name === enumName) ?? null;
      const generatedSection = compileEntry ? buildGeneratedFilesMarkdown(compileEntry) : '';

      if (rawDisc === 'none') {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**oneof ${word}** (in \`${msg.name}\`)\n\ndiscriminator: \`none\` — no companion enum generated`
          }
        };
      }

      if (rawDisc === 'msgid') {
        const allDefs = getAllDefinitions(params.textDocument.uri);
        const variantLines = oneof.fields.map(f => {
          const variantMsg = allDefs.messages.find(m => m.name === f.type);
          const id = variantMsg?.options['msgid'] ?? '?';
          return `  // msgid ${id}\n  ${f.type} ${f.name};`;
        }).join('\n');
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**oneof ${word}** (in \`${msg.name}\`)\n\ndiscriminator: \`msgid\` (uint16)\n\n\`\`\`sf\noneof ${word} {\n${variantLines}\n}\n\`\`\`${generatedSection}`
          }
        };
      }

      // field_order or auto — build 1-based companion enum
      let effectiveMode = rawDisc;
      if (rawDisc === 'auto') {
        const allDefs = getAllDefinitions(params.textDocument.uri);
        const allHaveMsgid = oneof.fields.every(f => {
          const vm = allDefs.messages.find(m => m.name === f.type);
          return !!vm?.options['msgid'];
        });
        effectiveMode = allHaveMsgid ? 'msgid' : 'field_order';
        // If auto resolves to msgid, re-render as msgid
        if (effectiveMode === 'msgid') {
          const variantLines = oneof.fields.map(f => {
            const variantMsg = allDefs.messages.find(m => m.name === f.type);
            const id = variantMsg?.options['msgid'] ?? '?';
            return `  // msgid ${id}\n  ${f.type} ${f.name};`;
          }).join('\n');
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: `**oneof ${word}** (in \`${msg.name}\`)\n\ndiscriminator: \`auto\` → \`msgid\` (uint16)\n\n\`\`\`sf\noneof ${word} {\n${variantLines}\n}\n\`\`\`${generatedSection}`
            }
          };
        }
      }

      // field_order: generate 1-based companion enum
      const valueLines = oneof.fields.map((f, idx) =>
        `  ${f.name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()} = ${idx + 1};`
      ).join('\n');
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**oneof ${word}** (in \`${msg.name}\`)\n\ndiscriminator: \`${rawDisc}\`${rawDisc === 'auto' ? ' → `field_order`' : ''} (uint8)\n\n**Generated companion enum:**\n\`\`\`sf\nenum ${enumName} {\n${valueLines}\n}\n\`\`\`${generatedSection}`
        }
      };
    }
  }

  return null;
});

// Document Symbols
connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const parsed = getOrParseDocument(params.textDocument.uri);
  const symbols: DocumentSymbol[] = [];

  const msgSymbolMap = new Map<string, DocumentSymbol>();
  for (const msg of parsed.messages) {
    const msgRange = Range.create(msg.line, 0, msg.endLine + 1, 0);
    const msgSymbol: DocumentSymbol = {
      name: msg.name,
      kind: SymbolKind.Class,
      range: msgRange,
      selectionRange: Range.create(msg.line, 0, msg.line, msg.name.length + 8),
      children: msg.fields.map(f => ({
        name: f.name,
        detail: `${f.repeated ? 'repeated ' : ''}${f.type}`,
        kind: SymbolKind.Field,
        range: Range.create(f.line, 0, f.line + 1, 0),
        selectionRange: Range.create(f.line, 0, f.line, f.name.length)
      }))
    };
    msgSymbolMap.set(msg.name, msgSymbol);
    symbols.push(msgSymbol);
  }

  for (const enm of parsed.enums) {
    const enumRange = Range.create(enm.line, 0, enm.endLine + 1, 0);
    const enumSymbol: DocumentSymbol = {
      name: enm.name,
      kind: SymbolKind.Enum,
      range: enumRange,
      selectionRange: Range.create(enm.line, 0, enm.line, enm.name.length + 5),
      children: enm.values.map(v => ({
        name: v.name,
        detail: `= ${v.value}`,
        kind: SymbolKind.EnumMember,
        range: Range.create(v.line, 0, v.line + 1, 0),
        selectionRange: Range.create(v.line, 0, v.line, v.name.length)
      }))
    };
    if (enm.parentMessage) {
      const parentSymbol = msgSymbolMap.get(enm.parentMessage);
      if (parentSymbol) {
        parentSymbol.children!.push(enumSymbol);
        continue;
      }
    }
    symbols.push(enumSymbol);
  }

  return symbols;
});

documents.listen(connection);
connection.listen();
