import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
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
  SymbolInformation,
  Definition,
  FileChangeType,
  Diagnostic,
  DiagnosticSeverity,
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  TextEdit,
  WorkspaceEdit,
  FoldingRange,
  FoldingRangeKind,
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
  nestedMessages: MessageDefinition[];
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
  importLines: Record<string, number>;
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
    importLines: {},
    messages: [],
    enums: [],
    fileOptions: {},
    fileOptionLines: {}
  };

  let currentMessage: MessageDefinition | null = null;
  let currentNestedMessage: MessageDefinition | null = null;
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
        doc.importLines[importMatch[1]] = i;
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
          nestedMessages: [],
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
      if (currentMessage && !currentNestedMessage && !currentNestedEnum && !currentOneof && braceDepth === 1) {
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

      // Detect nested message start (inside a message, before counting braces)
      if (currentMessage && !currentNestedMessage && !currentNestedEnum && !currentOneof && braceDepth === 1) {
        const nestedMsgMatch = trimmed.match(/^message\s+([A-Z][a-zA-Z0-9_]*)\s*\{/);
        if (nestedMsgMatch) {
          currentNestedMessage = {
            name: nestedMsgMatch[1],
            line: i,
            endLine: i,
            fields: [],
            oneofs: [],
            nestedMessages: [],
            options: {},
            optionLines: {}
          };
          braceDepth = 2;
          continue;
        }
      }

      // Detect oneof start (inside a message, before counting braces)
      if (currentMessage && !currentNestedMessage && !currentNestedEnum && !currentOneof && braceDepth === 1) {
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

      // Nested message closing (depth went from 2 back to 1)
      if (currentNestedMessage && braceDepth === 1) {
        currentNestedMessage.endLine = i;
        currentMessage!.nestedMessages.push(currentNestedMessage);
        // Also register as a top-level message so type resolution works across the file
        doc.messages.push(currentNestedMessage);
        currentNestedMessage = null;
        continue;
      }

      // Oneof closing (depth went from 2 back to 1)
      if (currentOneof && braceDepth === 1) {
        currentOneof.endLine = i;
        currentMessage!.oneofs.push(currentOneof);
        currentOneof = null;
        continue;
      }

      if (currentNestedMessage) {
        // Fields inside a nested message
        const optMatch = trimmed.match(/^option\s+(\w+)\s*=\s*(.+?)\s*;/);
        if (optMatch) {
          currentNestedMessage.options[optMatch[1]] = optMatch[2];
          currentNestedMessage.optionLines[optMatch[1]] = i;
          continue;
        }
        const fieldMatch = trimmed.match(
          /^(repeated\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([0-9]+)\s*(?:\[([^\]]*)\])?\s*;/
        );
        if (fieldMatch) {
          currentNestedMessage.fields.push({
            name: fieldMatch[3],
            type: fieldMatch[2],
            tag: parseInt(fieldMatch[4], 10),
            repeated: !!fieldMatch[1],
            options: fieldMatch[5] ? parseFieldOptions(fieldMatch[5]) : {},
            line: i
          });
        }
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

function makeDiagnostic(line: number, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error, data?: unknown): Diagnostic {
  return {
    severity,
    range: Range.create(line, 0, line, 10000),
    message,
    source: 'struct-frame',
    data
  };
}

function validateDocument(uri: string): void {
  const parsed = getOrParseDocument(uri);
  const diagnostics: Diagnostic[] = [];

  // All known message names (including imports) for type resolution
  const allDefs = getAllDefinitions(uri);
  const messageNames = new Set(allDefs.messages.map(m => m.name));

  // File-level: unknown option names
  const VALID_FILE_OPTIONS = new Set(['pkgid']);
  for (const optName of Object.keys(parsed.fileOptions)) {
    if (!VALID_FILE_OPTIONS.has(optName)) {
      diagnostics.push(makeDiagnostic(
        parsed.fileOptionLines[optName] ?? 0,
        `Unknown file-level option '${optName}'. Valid options: ${[...VALID_FILE_OPTIONS].join(', ')}`,
        DiagnosticSeverity.Warning
      ));
    }
  }

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
      if (!msg.options['msgid']) {
        diagnostics.push(makeDiagnostic(optLine,
          `is_envelope message '${msg.name}' should have option msgid for routing`,
          DiagnosticSeverity.Warning));
      }
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

    // Unknown message-level option names
    const VALID_MSG_OPTIONS = new Set(['msgid', 'variable', 'is_envelope']);
    for (const optName of Object.keys(msg.options)) {
      if (!VALID_MSG_OPTIONS.has(optName)) {
        diagnostics.push(makeDiagnostic(
          msg.optionLines[optName] ?? msg.line,
          `Unknown message option '${optName}'. Valid options: ${[...VALID_MSG_OPTIONS].join(', ')}`,
          DiagnosticSeverity.Warning
        ));
      }
    }

    // variable / is_envelope value validation
    if (msg.options['variable'] !== undefined && msg.options['variable'] !== 'true' && msg.options['variable'] !== 'false') {
      diagnostics.push(makeDiagnostic(msg.optionLines['variable'] ?? msg.line,
        `option variable must be 'true' or 'false', got '${msg.options['variable']}'`));
    }

    // variable=true with no max_size fields is pointless
    if (msg.options['variable'] === 'true') {
      const allFields = [...msg.fields, ...msg.oneofs.flatMap(o => o.fields)];
      const hasMaxSizeField = allFields.some(f => 'max_size' in f.options);
      if (!hasMaxSizeField) {
        diagnostics.push(makeDiagnostic(
          msg.optionLines['variable'] ?? msg.line,
          `option variable=true has no effect: no fields use [max_size=N] in '${msg.name}'`,
          DiagnosticSeverity.Warning
        ));
      }
    }
    if (msg.options['is_envelope'] !== undefined && msg.options['is_envelope'] !== 'true' && msg.options['is_envelope'] !== 'false') {
      diagnostics.push(makeDiagnostic(msg.optionLines['is_envelope'] ?? msg.line,
        `option is_envelope must be 'true' or 'false', got '${msg.options['is_envelope']}'`));
    }

    // Unknown oneof-level option names
    const VALID_ONEOF_OPTIONS = new Set(['discriminator']);
    for (const oneof of msg.oneofs) {
      for (const optName of Object.keys(oneof.options)) {
        if (!VALID_ONEOF_OPTIONS.has(optName)) {
          diagnostics.push(makeDiagnostic(
            oneof.line,
            `Unknown oneof option '${optName}'. Valid options: ${[...VALID_ONEOF_OPTIONS].join(', ')}`,
            DiagnosticSeverity.Warning
          ));
        }
      }
    }

    // oneof discriminator validation
    for (const oneof of msg.oneofs) {
      const disc = (oneof.options['discriminator'] ?? '').replace(/"/g, '').trim();
      if (disc !== '' && !DISCRIMINATOR_VALUES.includes(disc)) {
        diagnostics.push(makeDiagnostic(
          oneof.line,
          `Unknown discriminator value '${disc}'. Valid values: ${DISCRIMINATOR_VALUES.join(', ')}`,
          DiagnosticSeverity.Error
        ));
      }
      if (disc === 'msgid') {
        for (const field of oneof.fields) {
          const variantMsg = allDefs.messages.find(m => m.name === field.type);
          if (!variantMsg) {
            diagnostics.push(makeDiagnostic(field.line,
              `discriminator=msgid: variant '${field.name}' type '${field.type}' is not a known message`));
          } else if (!variantMsg.options['msgid']) {
            diagnostics.push(makeDiagnostic(field.line,
              `discriminator=msgid: variant '${field.name}' (type '${field.type}') does not have msgid`,
              DiagnosticSeverity.Error,
              { fix: 'add_msgid', fieldLine: field.line, msgName: field.type }));
          }
        }
      }
    }

    // Field number uniqueness within message (fields + all oneof variants share the same namespace)
    {
      const allTags = new Map<number, string>();
      for (const field of msg.fields) {
        if (allTags.has(field.tag)) {
          diagnostics.push(makeDiagnostic(field.line,
            `Duplicate field number ${field.tag} in '${msg.name}' (already used by '${allTags.get(field.tag)}')`));
        } else {
          allTags.set(field.tag, field.name);
        }
      }
      for (const oneof of msg.oneofs) {
        for (const field of oneof.fields) {
          if (allTags.has(field.tag)) {
            diagnostics.push(makeDiagnostic(field.line,
              `Duplicate field number ${field.tag} in '${msg.name}' (already used by '${allTags.get(field.tag)}')`));
          } else {
            allTags.set(field.tag, field.name);
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
            `String field '${field.name}' requires [size=N] or [max_size=N]`,
            DiagnosticSeverity.Error, { fix: 'add_size', fieldLine: field.line }));
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
            `Repeated string field '${field.name}' requires [size=N] or [max_size=N]`,
            DiagnosticSeverity.Error, { fix: 'add_size', fieldLine: field.line }));
        } else if (hasSize && hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated string field '${field.name}' cannot have both size and max_size`));
        }
        if (!hasElementSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated string field '${field.name}' requires [element_size=M]`,
            DiagnosticSeverity.Error, { fix: 'add_element_size', fieldLine: field.line }));
        }
      } else if (field.repeated && PRIMITIVE_TYPES.includes(field.type)) {
        // repeated primitive (array): size or max_size
        if (!hasSize && !hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated field '${field.name}' requires [size=N] or [max_size=N]`,
            DiagnosticSeverity.Error, { fix: 'add_size', fieldLine: field.line }));
        } else if (hasSize && hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated field '${field.name}' cannot have both size and max_size`));
        }
        if (hasElementSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `element_size is only valid on repeated string fields`));
        }
      } else if (field.repeated && messageNames.has(field.type)) {
        // repeated message field: size or max_size
        if (!hasSize && !hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated message field '${field.name}' requires [size=N] or [max_size=N]`,
            DiagnosticSeverity.Error, { fix: 'add_size', fieldLine: field.line }));
        } else if (hasSize && hasMaxSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `Repeated message field '${field.name}' cannot have both size and max_size`));
        }
        if (hasElementSize) {
          diagnostics.push(makeDiagnostic(field.line,
            `element_size is only valid on repeated string fields`));
        }
      }

      // Validate size and max_size values are positive integers (1–65535)
      if (hasSize) {
        const sizeVal = parseInt(field.options['size'], 10);
        if (isNaN(sizeVal) || sizeVal <= 0) {
          diagnostics.push(makeDiagnostic(field.line,
            `'size' must be a positive integer, got '${field.options['size']}'`));
        }
      }
      if (hasMaxSize) {
        const maxSizeVal = parseInt(field.options['max_size'], 10);
        if (isNaN(maxSizeVal) || maxSizeVal <= 0) {
          diagnostics.push(makeDiagnostic(field.line,
            `'max_size' must be a positive integer, got '${field.options['max_size']}'`));
        } else if (maxSizeVal > 65535) {
          diagnostics.push(makeDiagnostic(field.line,
            `'max_size' must be ≤ 65535, got ${maxSizeVal}`));
        }
      }

      // flatten: only on message-type fields; check name collisions with parent
      if (field.options['flatten'] === 'true') {
        if (!messageNames.has(field.type)) {
          diagnostics.push(makeDiagnostic(field.line,
            `flatten is only valid on message-type fields ('${field.type}' is not a known message)`));
        } else {
          diagnostics.push(makeDiagnostic(field.line,
            `flatten=true only affects Python and GraphQL output; has no effect on C, C++, C#, TypeScript, or Rust`,
            DiagnosticSeverity.Information));
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

  // Enum value number uniqueness
  for (const enm of parsed.enums) {
    const valueNumMap = new Map<number, string>();
    for (const val of enm.values) {
      if (valueNumMap.has(val.value)) {
        diagnostics.push(makeDiagnostic(val.line,
          `Duplicate enum value ${val.value} in '${enm.name}' (already used by '${valueNumMap.get(val.value)}')`));
      } else {
        valueNumMap.set(val.value, val.name);
      }
    }
  }

  // Import file existence
  for (const imp of parsed.imports) {
    const importUri = resolveImportUri(imp, uri);
    const importPath = importUri.startsWith('file://') ? fileURLToPath(importUri) : importUri;
    if (!fs.existsSync(importPath)) {
      const impLine = parsed.importLines[imp] ?? 0;
      diagnostics.push(makeDiagnostic(impLine, `Cannot resolve import: '${imp}' not found`));
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
      return { uri, packageName: '', imports: [], importLines: {}, messages: [], enums: [], fileOptions: {}, fileOptionLines: {} };
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

/**
 * Text-scan based context detection. Works even when blocks are unclosed (actively being typed).
 * Uses a keyword-labelled brace stack so it handles oneof/enum/message nesting correctly.
 */
function getContextAtLine(text: string, lineNum: number): { inMessage: boolean; inOneof: boolean; inEnum: boolean } {
  const lines = text.split('\n');
  const stack: Array<'message' | 'oneof' | 'enum' | 'other'> = [];

  for (let i = 0; i <= lineNum && i < lines.length; i++) {
    const rawLine = lines[i];
    const commentIdx = rawLine.indexOf('//');
    const line = commentIdx >= 0 ? rawLine.substring(0, commentIdx) : rawLine;
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Determine the keyword for the first `{` on this line
    let lineKind: 'message' | 'oneof' | 'enum' | 'other' = 'other';
    if (/^message\s+/.test(trimmed)) lineKind = 'message';
    else if (/^oneof\s+/.test(trimmed)) lineKind = 'oneof';
    else if (/^enum\s+/.test(trimmed)) lineKind = 'enum';

    let lineKindUsed = false;
    for (const ch of trimmed) {
      if (ch === '{') {
        stack.push(!lineKindUsed ? lineKind : 'other');
        lineKindUsed = true;
      } else if (ch === '}') {
        stack.pop();
      }
    }
  }

  // Find the innermost named context
  const lastSignificant = [...stack].reverse().find(k => k !== 'other');
  return {
    inMessage: lastSignificant === 'message',
    inOneof: lastSignificant === 'oneof',
    inEnum: lastSignificant === 'enum'
  };
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
      documentSymbolProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      foldingRangeProvider: true,
      referencesProvider: true,
      workspaceSymbolProvider: true,
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

function getImportPathCompletions(currentUri: string, _typedPath: string): CompletionItem[] {
  if (!workspaceRoot) return [];
  const currentDir = path.dirname(currentUri.startsWith('file://') ? fileURLToPath(currentUri) : currentUri);
  const currentFilePath = currentUri.startsWith('file://') ? fileURLToPath(currentUri) : currentUri;
  const items: CompletionItem[] = [];

  function scanDir(dir: string, prefix: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          scanDir(path.join(dir, entry.name), prefix + entry.name + '/');
        } else if (entry.isFile() && entry.name.endsWith('.sf')) {
          const absPath = path.join(dir, entry.name);
          if (absPath !== currentFilePath) {
            const relPath = prefix + entry.name;
            items.push({
              label: relPath,
              kind: CompletionItemKind.File,
              detail: '.sf import',
              insertText: relPath + '"',
            });
          }
        }
      }
    } catch { /* ignore unreadable dirs */ }
  }

  scanDir(currentDir, '');
  return items;
}

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const lines = text.split('\n');
  const lineText = lines[params.position.line] || '';
  const lineUpToCursor = lineText.substring(0, params.position.character);

  // ── 0. Inside import "..." string ─────────────────────────────────────
  const importPathMatch = lineUpToCursor.match(/^\s*import\s+"([^"]*)$/);
  if (importPathMatch) {
    return getImportPathCompletions(params.textDocument.uri, importPathMatch[1]);
  }

  // ── 1. Inside [ ] — field options ───────────────────────────────────────
  const bracketStart = lineUpToCursor.lastIndexOf('[');
  const bracketEnd = lineUpToCursor.lastIndexOf(']');
  if (bracketStart > bracketEnd && bracketStart >= 0) {
    const afterBracket = lineUpToCursor.substring(bracketStart + 1);
    // Value completion for flatten=
    if (/(?:^|,)\s*(?:(?:sf|struct_frame)\.)?flatten\s*=\s*$/.test(afterBracket)) {
      return [
        { label: 'true', kind: CompletionItemKind.Value },
        { label: 'false', kind: CompletionItemKind.Value }
      ];
    }
    // Suggest keys only at start of bracket content or after a comma (not after =)
    if (/(?:^|,)\s*(?:(?:sf|struct_frame)\.)?[a-zA-Z_]*$/.test(afterBracket)) {
      const FIELD_OPT_COMPLETIONS: Record<string, { detail: string; documentation: string }> = {
        'size=': { detail: 'Field option', documentation: 'Fixed-size allocation. Strings padded to exactly N bytes; arrays always have exactly N elements. Must be a positive integer.' },
        'max_size=': { detail: 'Field option', documentation: 'Bounded variable-size (1–65535). Strings get a length prefix + up to N bytes. Arrays get a count prefix + up to N elements. Uses a 1-byte (uint8) count prefix if max_size ≤ 255, or a 2-byte (uint16) count prefix if max_size > 255.' },
        'element_size=': { detail: 'Field option', documentation: 'Only for `repeated string` arrays. Size of each individual string element. Must be combined with `size=` or `max_size=`.' },
        'flatten=': { detail: 'Field option', documentation: 'Only on message-type fields. Inlines the nested message fields directly into the parent. Field names must not collide.' },
      };
      // Parse the field declaration before the [ to determine what options are applicable
      const beforeBracket = lineText.substring(0, bracketStart).trimEnd();
      const isRepeated = /^\s*repeated\b/.test(lineText);
      const fieldTypeMatch = beforeBracket.match(/(?:repeated\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*\d+\s*$/);
      const fieldType = fieldTypeMatch ? fieldTypeMatch[1] : '';
      const isPrimitiveType = PRIMITIVE_TYPES.includes(fieldType);
      const isStringType = fieldType === 'string';
      const isMsgType = !isPrimitiveType && /^[A-Z]/.test(fieldType);

      const applicableOpts = FIELD_OPTION_NAMES.filter(opt => {
        if (opt === 'element_size=') return isRepeated && isStringType;
        if (opt === 'flatten=') return !isRepeated && isMsgType;
        return true; // size= and max_size= always applicable
      });

      const optItems: CompletionItem[] = applicableOpts.map(opt => ({
        label: opt,
        kind: CompletionItemKind.Property,
        detail: FIELD_OPT_COMPLETIONS[opt]?.detail ?? 'Field option',
        documentation: FIELD_OPT_COMPLETIONS[opt]?.documentation,
      }));

      // For repeated string fields, offer combined snippets at the top
      if (isRepeated && isStringType) {
        optItems.unshift(
          {
            label: 'max_size=, element_size=',
            kind: CompletionItemKind.Snippet,
            detail: 'Bounded repeated string (combined)',
            insertText: 'max_size=${1:10}, element_size=${2:32}',
            insertTextFormat: InsertTextFormat.Snippet,
            documentation: 'Bounded array of strings: up to N strings (with 1-byte count prefix), each up to M bytes.',
          },
          {
            label: 'size=, element_size=',
            kind: CompletionItemKind.Snippet,
            detail: 'Fixed repeated string (combined)',
            insertText: 'size=${1:10}, element_size=${2:32}',
            insertTextFormat: InsertTextFormat.Snippet,
            documentation: 'Fixed array of strings: exactly N strings, each up to M bytes.',
          }
        );
      }
      return optItems;
    }
    return [];
  }

  // ── 2. Context detection (stack-based scan, works for unclosed blocks) ──
  const { inMessage, inOneof, inEnum } = getContextAtLine(text, params.position.line);

  // ── 3. option <name> ── suggest context-appropriate option names ─────────
  if (/^\s*option\s+$/.test(lineUpToCursor)) {
    const optNames = inOneof ? ONEOF_OPTION_NAMES
      : inMessage ? MESSAGE_OPTION_NAMES
      : FILE_OPTION_NAMES;
    const OPT_DOCS: Record<string, string> = {
      pkgid: 'Package identifier (0–255). Enables 16-bit message addressing: `(pkgid << 8) | msgid`.',
      msgid: 'Unique message identifier (0–255, or 0–65535 with pkgid). Required for top-level routable messages.',
      variable: 'Enables variable-length encoding. Bounded (`max_size`) fields only transmit used bytes, reducing bandwidth.',
      is_envelope: 'Marks this message as a container/envelope. Must have exactly one `oneof` whose variants are all message types.',
      discriminator: 'Controls how the active oneof variant is identified: `"auto"` | `"msgid"` | `"field_order"` | `"none"`.',
    };
    return optNames.map(opt => ({ label: opt, kind: CompletionItemKind.Property, detail: 'Option name', documentation: OPT_DOCS[opt] }));
  }

  // ── 4. option value completions ─────────────────────────────────────────
  if (/^\s*option\s+discriminator\s*=\s*$/.test(lineUpToCursor)) {
    return DISCRIMINATOR_VALUES.map(v => ({
      label: v,
      kind: CompletionItemKind.EnumMember,
      detail: 'Discriminator mode',
      documentation: {
        auto: 'Default. Uses `msgid` (uint16, 2 bytes) if all variants have msgid; otherwise `field_order` (uint8, 1 byte).',
        msgid: 'uint16 discriminator set to the message ID of the active variant. All variants must have `msgid`.',
        field_order: 'uint8 discriminator set to 1-based declaration order. Generates a typed companion enum.',
        none: 'No discriminator stored (0 bytes). The application must track the active variant out-of-band.',
      }[v],
      insertText: v
    }));
  }
  if (/^\s*option\s+(variable|is_envelope)\s*=\s*$/.test(lineUpToCursor)) {
    return [
      { label: 'true', kind: CompletionItemKind.Value },
      { label: 'false', kind: CompletionItemKind.Value }
    ];
  }
  if (/^\s*option\s+(msgid|pkgid)\s*=\s*$/.test(lineUpToCursor)) {
    const isMsgid = /msgid/.test(lineUpToCursor);
    if (isMsgid) {
      const parsedDoc = getOrParseDocument(params.textDocument.uri);
      const usedIds = new Set(parsedDoc.messages.map(m => parseInt(m.options['msgid'] ?? '-1', 10)).filter(n => !isNaN(n) && n >= 0));
      let nextFree = 1;
      while (usedIds.has(nextFree)) nextFree++;
      return [{ label: String(nextFree), kind: CompletionItemKind.Value, detail: 'Next available msgid' }];
    }
    return [{ label: '1', kind: CompletionItemKind.Value, detail: 'Enter a numeric ID' }];
  }

  // ── 5. Suppress completions while naming a oneof block ──────────────────
  if (/^\s*oneof\s+/.test(lineUpToCursor)) {
    return [];
  }

  // ── 6. Field number suggestion (field declaration `Type name = `) ────────
  if ((inMessage || inOneof) && !inEnum && !/^\s*option\s+/.test(lineUpToCursor)) {
    if (/^\s*(repeated\s+)?[a-zA-Z_]\w*\s+[a-zA-Z_]\w*\s*=\s*$/.test(lineUpToCursor)) {
      const parsedDoc = getOrParseDocument(params.textDocument.uri);
      const currentLine = params.position.line;
      const containingMsg = parsedDoc.messages
        .filter(m => m.line <= currentLine && currentLine <= (m.endLine ?? Infinity))
        .sort((a, b) => b.line - a.line)[0]; // innermost (latest start)
      if (containingMsg) {
        const usedTags = new Set<number>([
          ...containingMsg.fields.map(f => f.tag),
          ...containingMsg.oneofs.flatMap(o => o.fields.map(f => f.tag))
        ]);
        let nextTag = 1;
        while (usedTags.has(nextTag)) nextTag++;
        return [{ label: String(nextTag), kind: CompletionItemKind.Value, detail: 'Next available field number', sortText: '0' }];
      }
    }
  }

  // ── 7. Inside enum ──────────────────────────────────────────────────────
  if (inEnum) {
    if (/^\s*[A-Za-z_]*$/.test(lineUpToCursor)) {
      const parsedDoc = getOrParseDocument(params.textDocument.uri);
      const currentLine = params.position.line;
      const containingEnum = parsedDoc.enums.find(
        e => e.line <= currentLine && currentLine <= (e.endLine ?? Infinity)
      );
      let nextVal = 0;
      if (containingEnum && containingEnum.values.length > 0) {
        nextVal = Math.max(...containingEnum.values.map(v => v.value)) + 1;
      }
      return [
        {
          label: `VALUE_NAME = ${nextVal};`,
          kind: CompletionItemKind.Snippet,
          detail: nextVal === 0 ? 'First enum value' : `Next enum value (${nextVal})`,
          insertText: `\${1:VALUE_NAME} = \${2:${nextVal}};`,
          insertTextFormat: InsertTextFormat.Snippet,
        }
      ];
    }
    return [];
  }

  // ── 7. Inside oneof ──────────────────────────────────────────────────────
  if (inOneof && !inEnum) {
    if (/^\s*(repeated\s+)?[a-zA-Z_]*$/.test(lineUpToCursor)) {
      const allDefs = getAllDefinitions(params.textDocument.uri);
      return [
        { label: 'option', kind: CompletionItemKind.Keyword },
        {
          label: 'string (fixed)',
          kind: CompletionItemKind.Snippet,
          detail: 'Fixed-size string field',
          insertText: 'string ${1:field_name} = ${2:1} [size=${3:16}];',
          insertTextFormat: InsertTextFormat.Snippet,
          documentation: 'Fixed-size UTF-8 string. Always uses exactly N bytes (padded with nulls).',
        },
        {
          label: 'string (variable)',
          kind: CompletionItemKind.Snippet,
          detail: 'Variable-size string field',
          insertText: 'string ${1:field_name} = ${2:1} [max_size=${3:64}];',
          insertTextFormat: InsertTextFormat.Snippet,
          documentation: 'Variable-length UTF-8 string. Stores up to N chars plus a 1-byte length prefix.',
        },
        ...PRIMITIVE_TYPES.map(t => ({
          label: t, kind: CompletionItemKind.TypeParameter,
          detail: 'Primitive type', documentation: PRIMITIVE_TYPE_DOCS[t]
        })),
        ...allDefs.messages.map(m => ({ label: m.name, kind: CompletionItemKind.Class, detail: 'Message type' })),
        ...allDefs.enums.map(e => ({ label: e.name, kind: CompletionItemKind.Enum, detail: 'Enum type' })),
        ...getCompileConfigCompletionItems(allDefs)
      ];
    }
    return [];
  }

  // ── 8. Inside message (not in oneof) ────────────────────────────────────
  if (inMessage && !inEnum) {
    if (/^\s*(repeated\s+)?[a-zA-Z_]*$/.test(lineUpToCursor)) {
      const allDefs = getAllDefinitions(params.textDocument.uri);
      return [
        { label: 'option', kind: CompletionItemKind.Keyword },
        {
          label: 'repeated <primitive>',
          kind: CompletionItemKind.Snippet,
          detail: 'Repeated primitive field (fixed or bounded array)',
          insertText: 'repeated ${1|int8,uint8,int16,uint16,int32,uint32,int64,uint64,float,double,bool|} ${2:field_name} = ${3:1} [${4|size=4,max_size=16|}];',
          insertTextFormat: InsertTextFormat.Snippet,
          documentation: 'Array of primitive values. Use size= for fixed count, max_size= (\u226455 elements) for variable count with 1-byte prefix.',
        },
        {
          label: 'repeated string',
          kind: CompletionItemKind.Snippet,
          detail: 'Repeated string field (string array)',
          insertText: 'repeated string ${1:field_name} = ${2:1} [${3|max_size=10,size=10|}, element_size=${4:32}];',
          insertTextFormat: InsertTextFormat.Snippet,
          documentation: 'Array of strings. Requires size/max_size for the array count and element_size for each string byte limit.',
        },
        {
          label: 'repeated <message>',
          kind: CompletionItemKind.Snippet,
          detail: 'Repeated message field (message array)',
          insertText: 'repeated ${1:MessageType} ${2:field_name} = ${3:1} [${4|size=4,max_size=8|}];',
          insertTextFormat: InsertTextFormat.Snippet,
          documentation: 'Array of nested message values. Use size= for fixed count, max_size= (\u226455) for variable count.',
        },
        {
          label: 'string (fixed)',
          kind: CompletionItemKind.Snippet,
          detail: 'Fixed-size string field',
          insertText: 'string ${1:field_name} = ${2:1} [size=${3:16}];',
          insertTextFormat: InsertTextFormat.Snippet,
          documentation: 'Fixed-size UTF-8 string. Always uses exactly N bytes (padded with nulls).',
        },
        {
          label: 'string (variable)',
          kind: CompletionItemKind.Snippet,
          detail: 'Variable-size string field',
          insertText: 'string ${1:field_name} = ${2:1} [max_size=${3:64}];',
          insertTextFormat: InsertTextFormat.Snippet,
          documentation: 'Variable-length UTF-8 string. Stores up to N chars plus a 1-byte length prefix.',
        },
        {
          label: 'oneof',
          kind: CompletionItemKind.Snippet,
          detail: 'Oneof union field',
          insertText: 'oneof ${1:name} {\n  ${2:TypeA} ${3:field_a} = ${4:1};\n  ${5:TypeB} ${6:field_b} = ${7:2};\n}',
          insertTextFormat: InsertTextFormat.Snippet,
        },
        {
          label: 'oneof (with discriminator)',
          kind: CompletionItemKind.Snippet,
          detail: 'Oneof union field with explicit discriminator option',
          insertText: 'oneof ${1:name} {\n  option discriminator = ${2|auto,msgid,field_order,none|};\n  ${3:TypeA} ${4:field_a} = ${5:1};\n  ${6:TypeB} ${7:field_b} = ${8:2};\n}',
          insertTextFormat: InsertTextFormat.Snippet,
          documentation: 'auto: msgid if all variants have one, else field_order.\nmsgid: uint16 by message ID.\nfield_order: uint8 1-based index + companion enum.\nnone: no discriminator stored.',
        },
        {
          label: 'enum',
          kind: CompletionItemKind.Snippet,
          detail: 'Nested enum definition',
          insertText: 'enum ${1:EnumName} {\n  ${2:VALUE_A} = 0;\n  ${3:VALUE_B} = 1;\n}',
          insertTextFormat: InsertTextFormat.Snippet,
        },
        {
          label: 'message',
          kind: CompletionItemKind.Snippet,
          detail: 'Nested message definition',
          insertText: 'message ${1:NestedName} {\n  ${2:uint32} ${3:field_name} = 1;\n}',
          insertTextFormat: InsertTextFormat.Snippet,
        },
        ...PRIMITIVE_TYPES.map(t => ({
          label: t, kind: CompletionItemKind.TypeParameter,
          detail: 'Primitive type', documentation: PRIMITIVE_TYPE_DOCS[t]
        })),
        ...allDefs.messages.map(m => ({ label: m.name, kind: CompletionItemKind.Class, detail: 'Message type' })),
        ...allDefs.enums.map(e => ({ label: e.name, kind: CompletionItemKind.Enum, detail: 'Enum type' })),
        ...getCompileConfigCompletionItems(allDefs)
      ];
    }
    return [];
  }

  // ── 9. File level ────────────────────────────────────────────────────────
  if (/^\s*[a-zA-Z_]*$/.test(lineUpToCursor)) {
    return [
      {
        label: 'package',
        kind: CompletionItemKind.Snippet,
        detail: 'Package declaration',
        insertText: 'package ${1:name};',
        insertTextFormat: InsertTextFormat.Snippet,
      },
      {
        label: 'import',
        kind: CompletionItemKind.Snippet,
        detail: 'Import statement',
        insertText: 'import "${1:path.sf}";',
        insertTextFormat: InsertTextFormat.Snippet,
      },
      {
        label: 'message',
        kind: CompletionItemKind.Snippet,
        detail: 'Message definition',
        insertText: 'message ${1:MessageName} {\n  option msgid = ${2:1};\n\n  ${3:uint32} ${4:field_name} = ${5:1};\n}',
        insertTextFormat: InsertTextFormat.Snippet,
      },
      {
        label: 'message (variable)',
        kind: CompletionItemKind.Snippet,
        detail: 'Variable-length message definition',
        insertText: 'message ${1:MessageName} {\n  option msgid = ${2:1};\n  option variable = true;\n\n  string ${3:name} = 1 [max_size=${4:64}];\n  repeated uint8 ${5:data} = 2 [max_size=${6:128}];\n}',
        insertTextFormat: InsertTextFormat.Snippet,
        documentation: 'Message with variable=true: arrays and strings only transmit used bytes (max_size fields), reducing bandwidth.',
      },
      {
        label: 'enum',
        kind: CompletionItemKind.Snippet,
        detail: 'Enum definition',
        insertText: 'enum ${1:EnumName} {\n  ${2:VALUE_A} = 0;\n  ${3:VALUE_B} = 1;\n}',
        insertTextFormat: InsertTextFormat.Snippet,
      },
      {
        label: 'envelope',
        kind: CompletionItemKind.Snippet,
        detail: 'Envelope message pattern',
        insertText: 'message ${1:PayloadA} {\n  option msgid = ${2:100};\n\n  ${3:uint8} ${4:field} = 1;\n}\n\nmessage ${5:Envelope} {\n  option msgid = ${6:200};\n  option is_envelope = true;\n\n  oneof command {\n    ${1:PayloadA} ${7:payload_a} = 1;\n  }\n}',
        insertTextFormat: InsertTextFormat.Snippet,
      },
      {
        label: 'option',
        kind: CompletionItemKind.Snippet,
        detail: 'File-level option (pkgid)',
        insertText: 'option pkgid = ${1:1};',
        insertTextFormat: InsertTextFormat.Snippet,
      },
    ];
  }

  return [];
});

// Go-to-Definition
connection.onDefinition((params: TextDocumentPositionParams): Definition | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    connection.console.warn(`onDefinition: document not found: '${params.textDocument.uri}'`);
    return null;
  }

  const text = doc.getText();
  const lineText = text.split('\n')[params.position.line] || '';

  // Import path go-to-definition: click inside `import "path.sf"` string
  {
    const importMatch = lineText.match(/^\s*import\s+"([^"]+)"/);
    if (importMatch) {
      const quoteStart = lineText.indexOf('"');
      const quoteEnd = lineText.lastIndexOf('"');
      if (params.position.character > quoteStart && params.position.character <= quoteEnd) {
        const importUri = resolveImportUri(importMatch[1], params.textDocument.uri);
        return Location.create(importUri, Range.create(0, 0, 0, 0));
      }
    }
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

    // Use the unqualified name (strip leading namespace qualifiers like "ns::Name")
    const unqualified = elementName.includes('::')
      ? elementName.substring(elementName.lastIndexOf('::') + 2)
      : elementName;
    const escaped = unqualified.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Prefer a line that looks like a definition (struct/class/enum/typedef/using)
    const defRe = new RegExp(`\\b(?:struct|class|enum(?:\\s+class)?|typedef|using)\\s+${escaped}\\b`);
    const defIdx = lines.findIndex(l => defRe.test(l));
    if (defIdx >= 0) return defIdx;

    // Fall back to any line containing the unqualified name as a whole word
    const re = new RegExp(`\\b${escaped}\\b`);
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

  // Import path hover: hovering inside `import "path.sf"` string
  {
    const lineText = doc.getText().split('\n')[params.position.line] || '';
    const importMatch = lineText.match(/^\s*import\s+"([^"]+)"/);
    if (importMatch) {
      const quoteStart = lineText.indexOf('"');
      const quoteEnd = lineText.lastIndexOf('"');
      if (params.position.character > quoteStart && params.position.character <= quoteEnd) {
        const importPath = importMatch[1];
        const importUri = resolveImportUri(importPath, params.textDocument.uri);
        try {
          const importedDoc = getOrParseDocument(importUri);
          const msgList = importedDoc.messages.map(m => `- **message** \`${m.name}\``).join('\n');
          const enumList = importedDoc.enums.map(e => `- **enum** \`${e.name}\``).join('\n');
          const pkgLine = importedDoc.packageName ? `**package** \`${importedDoc.packageName}\`\n\n` : '';
          const body = [msgList, enumList].filter(Boolean).join('\n') || '*No top-level messages or enums*';
          return { contents: { kind: MarkupKind.Markdown, value: `${pkgLine}**\`${importPath}\`**\n\n${body}` } };
        } catch {
          return { contents: { kind: MarkupKind.Markdown, value: `Import: \`${importPath}\`` } };
        }
      }
    }
  }

  // Option name hover (e.g. hovering over `msgid` in `option msgid = 1;`)
  {
    const lineText = doc.getText().split('\n')[params.position.line] || '';
    const optMatch = lineText.match(/^\s*option\s+(\w+)\s*=/);
    if (optMatch && word === optMatch[1]) {
      const OPT_DOCS: Record<string, string> = {
        pkgid: '**pkgid** *(file option)*\n\nPackage identifier (0–255). Enables 16-bit addressing: `(pkgid << 8) | msgid`, allowing 256 packages × 256 messages = 65,536 unique IDs.',
        msgid: '**msgid** *(message option)*\n\nUnique message identifier for routing and deserialization (0–255 without pkgid, 0–65535 with pkgid). Required on most messages.',
        variable: '**variable** *(message option)*\n\nEnables variable-length encoding. Bounded fields (`max_size`) transmit only actual bytes instead of full allocated size.',
        is_envelope: '**is_envelope** *(message option)*\n\nMarks message as a container/wrapper. Must have exactly one `oneof` field whose variants are all message types.',
        discriminator: '**discriminator** *(oneof option)*\n\nControls how the oneof variant is identified during deserialization:\n- `"auto"` — uses `msgid` if all variants have one, otherwise `field_order`\n- `"msgid"` — uint16 discriminator by message ID\n- `"field_order"` — uint8 1-based field index; generates a companion enum\n- `"none"` — no discriminator stored; caller handles disambiguation manually'
      };
      if (OPT_DOCS[word]) {
        return { contents: { kind: MarkupKind.Markdown, value: OPT_DOCS[word] } };
      }
    }
  }

  // Discriminator value hover (e.g. hovering over "auto" in `option discriminator = "auto";`)
  {
    const lineText = doc.getText().split('\n')[params.position.line] || '';
    if (/option\s+discriminator\s*=/.test(lineText)) {
      const DISC_DOCS: Record<string, string> = {
        auto: '**auto** *(discriminator mode)*\n\nDefault mode. Uses `msgid` (uint16, 2 bytes) if all oneof variants are messages with `msgid`; otherwise falls back to `field_order` (uint8, 1 byte).',
        msgid: '**msgid** *(discriminator mode)*\n\nUses the message ID as the discriminator value. Generates a `uint16` (2-byte) prefix. All oneof variants must be messages with `msgid`. Error if any variant lacks one.',
        field_order: '**field_order** *(discriminator mode)*\n\nUses 1-based declaration order as the discriminator. Generates a `uint8` (1-byte) prefix and a typed companion enum `{MessageName}{OneofName}Field` with one entry per variant.',
        none: '**none** *(discriminator mode)*\n\nNo discriminator field is generated (0 bytes of overhead). The application must track which variant is active out-of-band. Reduces message size at the cost of type safety.',
      };
      if (DISC_DOCS[word]) {
        return { contents: { kind: MarkupKind.Markdown, value: DISC_DOCS[word] } };
      }
    }
  }

  // Field option name hover (e.g. hovering over `size` inside `[size=16]`)
  {
    const lineText = doc.getText().split('\n')[params.position.line] || '';
    const bracketStart = lineText.lastIndexOf('[', params.position.character);
    const bracketEnd = lineText.indexOf(']', params.position.character);
    if (bracketStart >= 0 && (bracketEnd < 0 || bracketEnd > bracketStart)) {
      const FIELD_OPT_DOCS: Record<string, string> = {
        size: '**size=N** *(field option)*\n\nFixed-size allocation (1–65535). Strings are padded to exactly N bytes; arrays always contain exactly N elements.',
        max_size: '**max_size=N** *(field option)*\n\nBounded variable-size (1–65535). Strings get a 1–2 byte length prefix + up to N chars. Arrays get a count prefix + up to N elements — uses a 1-byte (`uint8`) count if N ≤ 255, or a 2-byte (`uint16`) count if N > 255.',
        element_size: '**element_size=M** *(field option)*\n\nSize of each string in a `repeated string` array (1–65535). Must be combined with `size` or `max_size`.',
        flatten: '**flatten=true** *(field option)*\n\nOnly on message-type fields. Inlines the nested message\'s fields directly into the parent struct. Field names must not collide with the parent\'s existing fields.'
      };
      if (FIELD_OPT_DOCS[word]) {
        return { contents: { kind: MarkupKind.Markdown, value: FIELD_OPT_DOCS[word] } };
      }
    }
  }

  // Field tag number or enum value number hover
  if (/^\d+$/.test(word)) {
    const lineText = doc.getText().split('\n')[params.position.line] || '';
    // Field tag: `Type fieldname = N;` or `repeated Type fieldname = N [opts];`
    const fieldTagMatch = lineText.match(
      /^\s*(repeated\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*(\d+)\s*(?:\[([^\]]*)\])?\s*;/
    );
    if (fieldTagMatch && fieldTagMatch[2] === word) {
      const tag = parseInt(word, 10);
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**Field number ${tag}**\n\nUnique tag within this message/oneof. Identifies the field in binary layout and code generation. Must be unique across all fields and oneof variants in the same message.`
        }
      };
    }
    // Enum value: `VALUE_NAME = N;`
    const enumValMatch = lineText.match(/^\s*[A-Za-z][A-Za-z0-9_]*\s*=\s*(\d+)\s*;/);
    if (enumValMatch && enumValMatch[1] === word) {
      const val = parseInt(word, 10);
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**Enum value ${val}** (0x${val.toString(16).toUpperCase().padStart(2, '0')})\n\nStored as \`uint8\` (1 byte). Valid range: 0\u2013255.`
        }
      };
    }
  }

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
      const optLines = Object.entries(msg.options).map(([k, v]) => `  option ${k} = ${v};`).join('\n');
      const body = [optLines, fieldLines].filter(Boolean).join('\n');
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**message ${word}**\n\`\`\`sf\nmessage ${word} {\n${body}\n}\n\`\`\`${generatedSection}`
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

  // Field name hover — show type, tag, and options inline
  {
    const lineText = doc.getText().split('\n')[params.position.line] || '';
    const fieldMatch = lineText.match(
      /^(\s*)(repeated\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([0-9]+)\s*(?:\[([^\]]*)\])?\s*;/
    );
    if (fieldMatch && word === fieldMatch[4]) {
      const repeated = !!fieldMatch[2];
      const type = fieldMatch[3];
      const tag = fieldMatch[5];
      const opts = fieldMatch[6] ? `  // [${fieldMatch[6]}]` : '';
      const typeLabel = repeated ? `repeated ${type}` : type;
      const sizeNotes: string[] = [];
      if (fieldMatch[6]) {
        const parsedOpts = parseFieldOptions(fieldMatch[6]);
        if (parsedOpts['size']) sizeNotes.push(`fixed size: **${parsedOpts['size']}** bytes/elements`);
        if (parsedOpts['max_size']) sizeNotes.push(`max size: **${parsedOpts['max_size']}** (+ count prefix)`);
        if (parsedOpts['element_size']) sizeNotes.push(`element size: **${parsedOpts['element_size']}** bytes each`);
        if (parsedOpts['flatten'] === 'true') sizeNotes.push('fields flattened into parent');
      }
      const notes = sizeNotes.length ? `\n\n${sizeNotes.map(n => `- ${n}`).join('\n')}` : '';
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**${word}** *(field)*\n\`\`\`sf\n${typeLabel} ${word} = ${tag};${opts}\n\`\`\`${notes}`
        }
      };
    }
  }

  // Keyword hover — brief docs for language keywords
  {
    const KEYWORD_DOCS: Record<string, string> = {
      package: '**package** *(keyword)*\n\nDeclares the namespace for all messages/enums in this file. Used as a prefix or namespace in generated code.\n\n```sf\npackage sensor_data;\n```',
      import: '**import** *(keyword)*\n\nIncludes types from another `.sf` file. Imported message and enum types can be used as field types.\n\n```sf\nimport "types.sf";\n```',
      message: '**message** *(keyword)*\n\nDefines a fixed-size packed struct. Requires `option msgid` for top-level routable messages. Fields must have unique field numbers.\n\n```sf\nmessage Heartbeat {\n  option msgid = 1;\n  uint64 timestamp = 1;\n}\n```',
      enum: '**enum** *(keyword)*\n\nDefines an enumeration stored as `uint8` (1 byte). Values must be unique within the enum. Can be defined at file level or nested inside a message.\n\n```sf\nenum State { IDLE = 0; RUNNING = 1; }\n```',
      repeated: '**repeated** *(keyword)*\n\nDeclares an array field. Must specify `[size=N]` (fixed array) or `[max_size=N]` (variable-count array, 1–65535 elements). For `repeated string` arrays, also requires `[element_size=M]`.\n\nThe count prefix size is automatic: `uint8` (1 byte) when `max_size` ≤ 255, `uint16` (2 bytes) when `max_size` > 255.\n\nAvailable snippets:\n- `repeated <primitive>` — fixed/bounded array of primitive values\n- `repeated string` — array of strings with element_size\n- `repeated <message>` — array of nested messages',
      oneof: '**oneof** *(keyword)*\n\nDeclares a union field where only one variant is active at a time. All variants share the same memory (size of largest type). Generates an auto-discriminator field.',
      option: '**option** *(keyword)*\n\nSets a message, oneof, or file-level option. Common options: `msgid`, `pkgid`, `variable`, `is_envelope`, `discriminator`.',
    };
    if (KEYWORD_DOCS[word]) {
      return { contents: { kind: MarkupKind.Markdown, value: KEYWORD_DOCS[word] } };
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
    const fieldSymbols: DocumentSymbol[] = msg.fields.map(f => ({
      name: f.name,
      detail: `${f.repeated ? 'repeated ' : ''}${f.type}`,
      kind: SymbolKind.Field,
      range: Range.create(f.line, 0, f.line + 1, 0),
      selectionRange: Range.create(f.line, 0, f.line, f.name.length)
    }));
    const oneofSymbols: DocumentSymbol[] = msg.oneofs.map(o => ({
      name: o.name,
      detail: 'oneof',
      kind: SymbolKind.Namespace,
      range: Range.create(o.line, 0, o.endLine + 1, 0),
      selectionRange: Range.create(o.line, 0, o.line, o.name.length),
      children: o.fields.map(f => ({
        name: f.name,
        detail: f.type,
        kind: SymbolKind.Field,
        range: Range.create(f.line, 0, f.line + 1, 0),
        selectionRange: Range.create(f.line, 0, f.line, f.name.length)
      }))
    }));
    const msgSymbol: DocumentSymbol = {
      name: msg.name,
      kind: SymbolKind.Class,
      range: msgRange,
      selectionRange: Range.create(msg.line, 0, msg.line, msg.name.length + 8),
      children: [...fieldSymbols, ...oneofSymbols]
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

// ── Code Actions (Quick-Fixes) ─────────────────────────────────────────────
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const actions: CodeAction[] = [];

  for (const diag of params.context.diagnostics) {
    if (diag.source !== 'struct-frame') continue;
    const data = diag.data as Record<string, unknown> | undefined;
    if (!data) continue;

    const lineNum = diag.range.start.line;
    const lineText = doc.getText().split('\n')[lineNum] ?? '';

    if (data.fix === 'add_size') {
      // Strip semicolon from end so we can append before it
      const trimmedLine = lineText.trimEnd();
      const hasSemicolon = trimmedLine.endsWith(';');
      const insertPos = hasSemicolon
        ? Position.create(lineNum, trimmedLine.length - 1)
        : Position.create(lineNum, trimmedLine.length);

      for (const [label, snippet] of [
        ['Add [size=16]', ' [size=16]'],
        ['Add [max_size=64]', ' [max_size=64]'],
      ] as [string, string][]) {
        const edit: WorkspaceEdit = {
          changes: {
            [params.textDocument.uri]: [
              TextEdit.insert(insertPos, snippet)
            ]
          }
        };
        actions.push({
          title: label,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          edit,
        });
      }
    }

    if (data.fix === 'add_element_size') {
      // Field already has [size=...] or [max_size=...]; insert element_size after it
      const closingBracket = lineText.lastIndexOf(']');
      if (closingBracket >= 0) {
        const insertPos = Position.create(lineNum, closingBracket);
        const edit: WorkspaceEdit = {
          changes: {
            [params.textDocument.uri]: [
              TextEdit.insert(insertPos, ', element_size=32')
            ]
          }
        };
        actions.push({
          title: 'Add [element_size=32]',
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          edit,
        });
      } else {
        // No bracket at all — append before semicolon
        const trimmedLine = lineText.trimEnd();
        const insertPos = trimmedLine.endsWith(';')
          ? Position.create(lineNum, trimmedLine.length - 1)
          : Position.create(lineNum, trimmedLine.length);
        const edit: WorkspaceEdit = {
          changes: {
            [params.textDocument.uri]: [
              TextEdit.insert(insertPos, ' [element_size=32]')
            ]
          }
        };
        actions.push({
          title: 'Add [element_size=32]',
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          edit,
        });
      }
    }

    if (data.fix === 'add_msgid') {
      const targetMsgName = (data as Record<string, unknown>).msgName as string | undefined;
      if (targetMsgName) {
        const parsedDoc = getOrParseDocument(params.textDocument.uri);
        const targetMsg = parsedDoc.messages.find(m => m.name === targetMsgName);
        if (targetMsg) {
          const usedIds = new Set(parsedDoc.messages
            .map(m => parseInt(m.options['msgid'] ?? '-1', 10))
            .filter(n => !isNaN(n) && n >= 0));
          let nextFree = 1;
          while (usedIds.has(nextFree)) nextFree++;
          const insertLine = targetMsg.line + 1;
          const edit: WorkspaceEdit = {
            changes: {
              [params.textDocument.uri]: [
                TextEdit.insert(Position.create(insertLine, 0), `  option msgid = ${nextFree};\n`)
              ]
            }
          };
          actions.push({
            title: `Add 'option msgid = ${nextFree}' to '${targetMsgName}'`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diag],
            edit,
          });
        }
      }
    }
  }

  return actions;
});

// ── Folding Ranges ─────────────────────────────────────────────────────────
connection.onFoldingRanges((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const parsed = getOrParseDocument(params.textDocument.uri);
  const ranges: FoldingRange[] = [];

  for (const msg of parsed.messages) {
    if (msg.endLine > msg.line) {
      ranges.push(FoldingRange.create(msg.line, msg.endLine, undefined, undefined, FoldingRangeKind.Region));
    }
    for (const oneof of msg.oneofs) {
      if (oneof.endLine > oneof.line) {
        ranges.push(FoldingRange.create(oneof.line, oneof.endLine, undefined, undefined, FoldingRangeKind.Region));
      }
    }
    for (const nm of msg.nestedMessages) {
      if (nm.endLine > nm.line) {
        ranges.push(FoldingRange.create(nm.line, nm.endLine, undefined, undefined, FoldingRangeKind.Region));
      }
    }
  }

  for (const enm of parsed.enums) {
    if (enm.endLine > enm.line) {
      ranges.push(FoldingRange.create(enm.line, enm.endLine, undefined, undefined, FoldingRangeKind.Region));
    }
  }

  // Block comments
  const text = doc.getText();
  const blockCommentRe = /\/\*[\s\S]*?\*\//g;
  let match: RegExpExecArray | null;
  while ((match = blockCommentRe.exec(text)) !== null) {
    const startLine = doc.positionAt(match.index).line;
    const endLine = doc.positionAt(match.index + match[0].length).line;
    if (endLine > startLine) {
      ranges.push(FoldingRange.create(startLine, endLine, undefined, undefined, FoldingRangeKind.Comment));
    }
  }

  return ranges;
});

// ── Find References ────────────────────────────────────────────────────────
connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const wordInfo = getWordAtPosition(doc.getText(), params.position);
  if (!wordInfo || !/^[A-Z]/.test(wordInfo.word)) return [];
  const targetName = wordInfo.word;

  // Collect all open .sf documents + any referenced via compile config
  const urisToSearch = new Set<string>([params.textDocument.uri]);
  for (const [uri] of parsedDocuments) {
    if (uri.endsWith('.sf')) urisToSearch.add(uri);
  }
  if (sfCompileConfig) {
    const sourceDir = getCompileConfigSourceDir();
    const allEntries = [...sfCompileConfig.messages, ...(sfCompileConfig.nested_messages ?? []), ...sfCompileConfig.enums];
    for (const entry of allEntries) {
      if (entry.source_file) {
        const absPath = path.resolve(sourceDir, entry.source_file);
        if (fs.existsSync(absPath)) urisToSearch.add(pathToFileURL(absPath).toString());
      }
    }
  }

  const locations: Location[] = [];
  const fieldTypeRe = new RegExp(`\\b${targetName}\\b`);

  for (const uri of urisToSearch) {
    const parsed = getOrParseDocument(uri);
    for (const msg of parsed.messages) {
      for (const field of msg.fields) {
        if (field.type === targetName) {
          locations.push(Location.create(uri, Range.create(field.line, 0, field.line, 10000)));
        }
      }
      for (const oneof of msg.oneofs) {
        for (const field of oneof.fields) {
          if (field.type === targetName) {
            locations.push(Location.create(uri, Range.create(field.line, 0, field.line, 10000)));
          }
        }
      }
      for (const nm of msg.nestedMessages) {
        for (const field of nm.fields) {
          if (field.type === targetName) {
            locations.push(Location.create(uri, Range.create(field.line, 0, field.line, 10000)));
          }
        }
      }
    }
  }

  return locations;
});

// ── Workspace Symbols ──────────────────────────────────────────────────────
connection.onWorkspaceSymbol((params) => {
  const query = params.query.toLowerCase();
  const results: SymbolInformation[] = [];

  // Collect from all parsed documents + compile config source files
  const urisToSearch = new Set<string>();
  for (const [uri] of parsedDocuments) {
    if (uri.endsWith('.sf')) urisToSearch.add(uri);
  }
  if (sfCompileConfig && workspaceRoot) {
    const sourceDir = getCompileConfigSourceDir();
    const allEntries = [...sfCompileConfig.messages, ...(sfCompileConfig.nested_messages ?? []), ...sfCompileConfig.enums];
    for (const entry of allEntries) {
      if (entry.source_file) {
        const absPath = path.resolve(sourceDir, entry.source_file);
        if (fs.existsSync(absPath)) urisToSearch.add(pathToFileURL(absPath).toString());
      }
    }
  }

  for (const uri of urisToSearch) {
    const parsed = getOrParseDocument(uri);
    for (const msg of parsed.messages) {
      if (!query || msg.name.toLowerCase().includes(query)) {
        results.push({
          name: msg.name,
          kind: SymbolKind.Class,
          location: Location.create(uri, Range.create(msg.line, 0, msg.endLine + 1, 0)),
          containerName: parsed.packageName || undefined,
        });
      }
      for (const nm of msg.nestedMessages) {
        if (!query || nm.name.toLowerCase().includes(query)) {
          results.push({
            name: nm.name,
            kind: SymbolKind.Class,
            location: Location.create(uri, Range.create(nm.line, 0, nm.endLine + 1, 0)),
            containerName: msg.name,
          });
        }
      }
    }
    for (const enm of parsed.enums) {
      if (!query || enm.name.toLowerCase().includes(query)) {
        results.push({
          name: enm.name,
          kind: SymbolKind.Enum,
          location: Location.create(uri, Range.create(enm.line, 0, enm.endLine + 1, 0)),
          containerName: enm.parentMessage ?? parsed.packageName ?? undefined,
        });
      }
    }
  }

  return results;
});

documents.listen(connection);
connection.listen();
