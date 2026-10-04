# JS-VM-MCP-Server

## Usage
```json
{
  "mcpServers": {
    "JavaScript VM": {
      "command": "npx",
      "args": [
        "--allow-git",
        "all",
        "-y",
        "github:Quicksilver0218/JS-VM-MCP-Server"
      ]
    }
  }
}
```

## Tool
- `run_javascript`

Executes the submitted snippet inside a fresh [`isolated-vm`](https://github.com/laverdet/isolated-vm) V8
isolate and returns the captured `stdout`, `stderr`, the top-level `return` value and any failure.
The first line of the response is always `Code execution finished in #.### seconds.`.

Per call:

| Limit | Value |
| --- | --- |
| V8 heap | 512 MB |
| Wall clock | 30 seconds |
| Buffered output | 1,000,000 characters per stream |

The isolate is a separate heap with no access to the host process, so there is no `require`,
`process`, `fetch`, timer or file-system API. Each call gets a brand new isolate, so nothing is
shared between runs. The snippet is evaluated as the body of an async function, which means
top-level `await` and top-level `return` both work.
