import assert = require('node:assert/strict');
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test = require('node:test');

type JsonRpcMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  params?: {
    uri?: string;
    diagnostics?: Array<{
      message: string;
      severity?: number;
      range: { start: { character: number }; end: { character: number } };
    }>;
  };
};

type Diagnostics = NonNullable<NonNullable<JsonRpcMessage['params']>['diagnostics']>;

function startServer(): {
  process: ChildProcessWithoutNullStreams;
  request: (method: string, params: unknown, id: number) => Promise<JsonRpcMessage>;
  notify: (method: string, params: unknown) => void;
  waitForDiagnostics: (uri: string) => Promise<Diagnostics>;
} {
  const serverPath = resolve(__dirname, '..', 'server.js');
  assert.equal(existsSync(serverPath), true);
  const server = spawn(process.execPath, [serverPath, '--stdio']);
  let buffer = Buffer.alloc(0);
  const responses = new Map<number, (message: JsonRpcMessage) => void>();
  const diagnosticWaiters = new Map<string, (diagnostics: Diagnostics) => void>();

  server.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const separator = buffer.indexOf(Buffer.from('\r\n\r\n'));
      if (separator < 0) break;
      const header = buffer.subarray(0, separator).toString();
      const match = header.match(/Content-Length: (\d+)/);
      if (!match) break;
      const length = Number(match[1]);
      const bodyStart = separator + 4;
      if (buffer.length - bodyStart < length) break;
      const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString()) as JsonRpcMessage;
      buffer = buffer.subarray(bodyStart + length);
      if (message.id !== undefined) {
        responses.get(message.id)?.(message);
        responses.delete(message.id);
      } else if (message.method === 'textDocument/publishDiagnostics' && message.params?.uri) {
        diagnosticWaiters.get(message.params.uri)?.(message.params.diagnostics ?? []);
        diagnosticWaiters.delete(message.params.uri);
      }
    }
  });

  const write = (message: unknown): void => {
    const body = Buffer.from(JSON.stringify(message));
    server.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  const request = (method: string, params: unknown, id: number): Promise<JsonRpcMessage> => new Promise(resolveResponse => {
    responses.set(id, resolveResponse);
    write({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method: string, params: unknown): void => write({ jsonrpc: '2.0', method, params });
  const waitForDiagnostics = (uri: string): Promise<Diagnostics> => new Promise(resolveDiagnostics => {
    diagnosticWaiters.set(uri, resolveDiagnostics);
  });

  return { process: server, request, notify, waitForDiagnostics };
}

async function openDocument(
  client: ReturnType<typeof startServer>,
  rootUri: string,
  relativePath: string
): Promise<Diagnostics> {
  const uri = pathToFileURL(resolve(__dirname, '..', '..', '..', relativePath)).href;
  const text = readFileSync(resolve(__dirname, '..', '..', '..', relativePath), 'utf8');
  const diagnostics = client.waitForDiagnostics(uri);
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'struct-frame', version: 1, text }
  });
  return diagnostics;
}

test('publishes expected diagnostics for schema fixtures', async () => {
  const client = startServer();
  const rootUri = pathToFileURL(resolve(__dirname, '..', '..', '..') + '\\').href;
  try {
    const initialize = await client.request('initialize', {
      processId: null,
      rootUri,
      capabilities: { workspace: { configuration: false, workspaceFolders: false } },
      workspaceFolders: [{ uri: rootUri, name: 'struct-frame-ls' }]
    }, 1);
    assert.ok(initialize.result);
    client.notify('initialized', {});

    const cleanDiagnostics = await openDocument(client, rootUri, 'examples/example.sf');
    assert.equal(cleanDiagnostics.length, 0);

    const invalidDiagnostics = await openDocument(client, rootUri, 'examples/validation-fixtures.sf');
    assert.ok(invalidDiagnostics.some(diagnostic => diagnostic.message.includes("default is not supported on repeated field")));
    assert.ok(invalidDiagnostics.some(diagnostic => diagnostic.message.includes('message-level extensions_start cannot be combined')));
    const unknownOption = invalidDiagnostics.find(diagnostic => diagnostic.message.includes("Unknown field option 'defualt'"));
    assert.equal(unknownOption?.severity, 2);
    const repeatedDefault = invalidDiagnostics.find(diagnostic => diagnostic.message.includes("default is not supported on repeated field"));
    assert.deepEqual(repeatedDefault?.range, {
      start: { line: 12, character: 43 },
      end: { line: 12, character: 53 }
    });
  } finally {
    client.process.kill();
  }
});
