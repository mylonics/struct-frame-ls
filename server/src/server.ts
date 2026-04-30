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
  Definition
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

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

interface MessageDefinition {
  name: string;
  line: number;
  endLine: number;
  fields: FieldDefinition[];
  options: Record<string, string>;
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
}

interface ParsedDocument {
  uri: string;
  packageName: string;
  imports: string[];
  messages: MessageDefinition[];
  enums: EnumDefinition[];
}

const parsedDocuments = new Map<string, ParsedDocument>();

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
const OPTION_NAMES = ['msgid', 'pkgid', 'variable'];
const FIELD_OPTION_NAMES = ['size=', 'max_size=', 'element_size=', 'flatten='];

function parseDocument(uri: string, content: string): ParsedDocument {
  const lines = content.split('\n');
  const doc: ParsedDocument = {
    uri,
    packageName: '',
    imports: [],
    messages: [],
    enums: []
  };

  let currentMessage: MessageDefinition | null = null;
  let currentEnum: EnumDefinition | null = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Strip line comments
    const commentIdx = rawLine.indexOf('//');
    const line = commentIdx >= 0 ? rawLine.substring(0, commentIdx) : rawLine;
    const trimmed = line.trim();

    if (!trimmed) continue;

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

    // Message definition
    const msgMatch = trimmed.match(/^message\s+([A-Z][a-zA-Z0-9_]*)\s*\{/);
    if (msgMatch && braceDepth === 0) {
      currentMessage = {
        name: msgMatch[1],
        line: i,
        endLine: i,
        fields: [],
        options: {}
      };
      braceDepth = 1;
      continue;
    }

    // Enum definition
    const enumMatch = trimmed.match(/^enum\s+([A-Z][a-zA-Z0-9_]*)\s*\{/);
    if (enumMatch && braceDepth === 0) {
      currentEnum = {
        name: enumMatch[1],
        line: i,
        endLine: i,
        values: []
      };
      braceDepth = 1;
      continue;
    }

    if (braceDepth > 0) {
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

      if (currentEnum) {
        // Enum value: VALUE_NAME = number;
        const enumValMatch = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*([0-9]+)\s*;/);
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
          const options: Record<string, string> = {};
          if (optionsStr) {
            for (const opt of optionsStr.split(',')) {
              const kv = opt.trim().match(/^(\w+)\s*=\s*(.+)$/);
              if (kv) options[kv[1]] = kv[2].trim();
            }
          }
          currentMessage.fields.push({
            name: fieldName,
            type: fieldType,
            tag,
            repeated,
            options,
            line: i
          });
        }
      }
    }
  }

  return doc;
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
    } catch {
      return { uri, packageName: '', imports: [], messages: [], enums: [] };
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
  return `file://${resolvedPath}`;
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

  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
});

documents.onDidChangeContent(change => {
  parsedDocuments.delete(change.document.uri);
  getOrParseDocument(change.document.uri);
});

documents.onDidClose(e => {
  parsedDocuments.delete(e.document.uri);
});

// Completion
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
    return FIELD_OPTION_NAMES.map(opt => ({
      label: opt,
      kind: CompletionItemKind.Property,
      detail: 'Field option'
    }));
  }

  // After "option "
  if (/^\s*option\s+$/.test(lineUpToCursor)) {
    return OPTION_NAMES.map(opt => ({
      label: opt,
      kind: CompletionItemKind.Property,
      detail: 'Option name'
    }));
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

  // Check if we're inside a message
  const parsed = getOrParseDocument(params.textDocument.uri);
  const lineNum = params.position.line;

  const inMessage = parsed.messages.some(m => lineNum > m.line && lineNum < m.endLine);
  const inEnum = parsed.enums.some(e => lineNum > e.line && lineNum < e.endLine);

  if (inMessage && !inEnum) {
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

      return [...primitiveItems, ...messageItems, ...enumItems];
    }

    // Inside message, at start of line - suggest keywords for inside message
    if (/^\s*$/.test(lineUpToCursor)) {
      const insideMessageKeywords: CompletionItem[] = [
        { label: 'option', kind: CompletionItemKind.Keyword },
        { label: 'repeated', kind: CompletionItemKind.Keyword },
        { label: 'oneof', kind: CompletionItemKind.Keyword }
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
      return [...insideMessageKeywords, ...primitiveItems, ...messageItems, ...enumItems];
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
  if (!doc) return null;

  const wordInfo = getWordAtPosition(doc.getText(), params.position);
  if (!wordInfo) return null;

  const { word } = wordInfo;

  // Only look up PascalCase identifiers (user-defined types)
  if (!/^[A-Z]/.test(word)) return null;

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

    for (const imp of parsed.imports) {
      const importUri = resolveImportUri(imp, uri);
      const result = findDefinition(importUri, visited);
      if (result) return result;
    }

    return null;
  }

  return findDefinition(params.textDocument.uri);
});

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
    const allDefs = getAllDefinitions(params.textDocument.uri);

    const msg = allDefs.messages.find(m => m.name === word);
    if (msg) {
      const fieldLines = msg.fields.map(f => `  ${f.repeated ? 'repeated ' : ''}${f.type} ${f.name} = ${f.tag};`).join('\n');
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**message ${word}**\n\`\`\`sf\nmessage ${word} {\n${fieldLines}\n}\n\`\`\``
        }
      };
    }

    const enm = allDefs.enums.find(e => e.name === word);
    if (enm) {
      const valueLines = enm.values.map(v => `  ${v.name} = ${v.value};`).join('\n');
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**enum ${word}**\n\`\`\`sf\nenum ${word} {\n${valueLines}\n}\n\`\`\``
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

  for (const msg of parsed.messages) {
    const msgRange = Range.create(msg.line, 0, msg.endLine, 0);
    const msgSymbol: DocumentSymbol = {
      name: msg.name,
      kind: SymbolKind.Class,
      range: msgRange,
      selectionRange: Range.create(msg.line, 0, msg.line, msg.name.length + 8),
      children: msg.fields.map(f => ({
        name: f.name,
        detail: `${f.repeated ? 'repeated ' : ''}${f.type}`,
        kind: SymbolKind.Field,
        range: Range.create(f.line, 0, f.line, 0),
        selectionRange: Range.create(f.line, 0, f.line, f.name.length)
      }))
    };
    symbols.push(msgSymbol);
  }

  for (const enm of parsed.enums) {
    const enumRange = Range.create(enm.line, 0, enm.endLine, 0);
    const enumSymbol: DocumentSymbol = {
      name: enm.name,
      kind: SymbolKind.Enum,
      range: enumRange,
      selectionRange: Range.create(enm.line, 0, enm.line, enm.name.length + 5),
      children: enm.values.map(v => ({
        name: v.name,
        detail: `= ${v.value}`,
        kind: SymbolKind.EnumMember,
        range: Range.create(v.line, 0, v.line, 0),
        selectionRange: Range.create(v.line, 0, v.line, v.name.length)
      }))
    };
    symbols.push(enumSymbol);
  }

  return symbols;
});

documents.listen(connection);
connection.listen();
