# struct-frame-ls

VSCode Language Server for struct-frame (.sf files)

## Features

- **Syntax Highlighting** — Full highlighting for messages, enums, primitive types, keywords, comments, field options, and string literals
- **Go-to-Definition** — Click on a message or enum type name to jump to its definition, including across imported files
- **Autocomplete** — Context-aware suggestions:
  - Top-level keywords (`message`, `enum`, `package`, `import`, `option`, `repeated`, `oneof`)
  - Field types: all primitive types plus user-defined messages and enums from the current file and its imports
  - Inside `[...]`: field option names (`size=`, `max_size=`, `element_size=`, `flatten=`, `default=`)
  - After `option`: context-aware option names (`msgid`, `pkgid`, `variable`, `magic_bytes`, `extensions_start`, and oneof options)
- **Hover Documentation** — Hover over a type name to see its definition summary or a description of the primitive type
- **Document Symbols / Outline** — All messages and enums listed in the outline with their fields and enum values

## struct-frame Syntax

struct-frame uses a protobuf-like syntax with `.sf` file extension:

```sf
package sensor_data;

option pkgid = 1;

import "other_file.sf";

enum SensorStatus {
  OFFLINE = 0;
  ONLINE  = 1;
  ERROR   = 2;
}

message SensorReading {
  option msgid = 1;
  option variable = true;

  SensorStatus status    = 1;
  float        value     = 2;
  string       name      = 3 [size=16];
  repeated uint8 data    = 4 [max_size=200];
  uint32       timestamp = 5;
}

message Container {
  option msgid = 2;
  SensorReading reading = 1 [flatten=true];
}
```

**Primitive types**: `int8`, `int16`, `int32`, `int64`, `uint8`, `uint16`, `uint32`, `uint64`, `float`, `double`, `bool`, `string`

**Field options** (in `[...]`): `size`, `max_size`, `element_size`, `flatten`, `default`

**Message options**: `msgid`, `variable`, `is_envelope`, `magic_bytes`, `extensions_start`

**Oneof options**: `discriminator`, `variable`, `max_size`, `min_size`, `extensions_start`

### Default values

`default` is an initialization and decode-fallback value. It does not change wire layout,
field size, or magic bytes. It is supported for integer types, `bool`, `float`, `double`,
enum members, and fixed or bounded strings:

```sf
enum State { IDLE = 0; READY = 1; }

message Defaults {
  State state = 1 [default=READY];
  bool enabled = 2 [default=true];
  string label = 3 [size=16, default="ready"];
}
```

Defaults are not supported on repeated fields, message-typed fields, or fields inside a
`oneof`.

### Diagnostics

The language server validates duplicate and unknown field options, default values and their
type ranges, magic-byte format, extension anchors, oneof size rules, and oneof variant fields.
Unknown option names are warnings so newer generator options remain forward-compatible.

## Development

```bash
npm install
cd client && npm install
cd ../server && npm install
cd ..
npm run compile
```

Open the project in VSCode and press **F5** to launch the Extension Development Host.
