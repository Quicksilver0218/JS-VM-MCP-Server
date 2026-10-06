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

## Tools

There are 2 available tools:
- `run_javascript` — runs the snippet as-is.
- `run_typescript` — compiles the snippet with [esbuild](https://esbuild.github.io/) (`loader: "ts"`, `target: "esnext"`), then runs the emitted JavaScript through the exact same path as `run_javascript`.

Both VM tools behave identically; `run_typescript` just strips the types off first.

### Run

Executes the submitted snippet inside a fresh [`isolated-vm`](https://github.com/laverdet/isolated-vm) V8
isolate and returns the captured `stdout`, `stderr`, the top-level `return` value and any failure.
The first line of the response is always `Code execution finished in #.### seconds.`.

Per call:

| Limit | Value |
| --- | --- |
| V8 heap | 512 MB |
| Wall clock | 30 seconds |
| Buffered output | 262,144 characters per stream |

The isolate is a separate heap with no access to the host process, so there is no `require`,
`process`, timer or file-system API. Each call gets a brand new isolate, so nothing is
shared between runs. The snippet is evaluated as the body of an async function, which means
top-level `await` and top-level `return` both work. `import`/`export` module syntax is not
supported in either tool.

### fetch

The isolate has no network stack of its own, so `fetch` is bridged to the host process, which
performs the actual request and copies the buffered response back into the isolate:

| Limit | Value |
| --- | --- |
| Timeout per request | 15 seconds (rejects with `TimeoutError`) |
| Request/response body | 8,388,608 bytes |

Only `http:` and `https:` URLs are allowed and the host sends no cookies. `fetch`, `Headers`,
`Response`, `AbortController`, `TextEncoder` and `TextDecoder` are minimal shims:
`response.text()`/`json()`/`arrayBuffer()`/`clone()` work, but `response.body` is `null`
(no streams, no `blob()`), `URL`/`Request`/`FormData`/`Blob` do not exist, and the isolate has
no timers, so `setTimeout` and `AbortSignal.timeout` are unavailable.

`run_typescript` caveats:

- Type annotations, interfaces, type aliases and generics are erased, and line numbers in runtime
  stack traces stay exact.
- `enum`, `namespace` and constructor parameter properties emit new code, which can push a runtime
  stack trace past the line you wrote.
- esbuild reports compile errors on the line numbers you submitted.
