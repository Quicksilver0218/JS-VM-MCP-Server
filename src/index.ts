import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ErrorCode,
  McpError,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ZodRawShapeCompat, AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat";
import ivm from "isolated-vm";
import esbuild from "esbuild";

// Limits applied to every VM tool call. A brand new isolate is created per call so
// no state, memory or globals can leak between runs.
const MEMORY_LIMIT_MB = 512;
const TIMEOUT_MS = 30_000;

/** Cap on buffered stdout/stderr per run so a noisy script cannot flood the response. */
const MAX_STREAM_CHARS = 262144; // 256 KB

/**
 * How many lines `wrapCode` inserts in front of the caller's snippet. Used to shift stack traces
 * and compiler diagnostics back onto the lines the caller actually wrote.
 */
const WRAPPER_PREFIX_LINES = 3;

/** Shared wording for the one failure mode both tools cannot recover from. */
const MODULE_SYNTAX_ERROR =
  "Module syntax (`import`/`export`) is not supported: the snippet runs as a standalone script and the isolate has no module resolver.";

/**
 * Runs inside the isolate before the user code. It builds a small `console` that forwards
 * everything to the host process, plus a `__ivmReport` helper used to serialize the outcome
 * of the user code back across the isolate boundary.
 *
 * Written with `String.raw` so the escape sequences below survive being embedded in a
 * TypeScript template literal.
 */
const BOOTSTRAP_SOURCE = String.raw`
(() => {
  "use strict";

  var MAX_DEPTH = 4;
  var MAX_ITEMS = 1000;
  var seen = new WeakSet();
  var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  var quote = function (str) {
    var out = '"';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      var point = str.charCodeAt(i);
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (point < 32 || point === 127) out += "\\x" + point.toString(16).padStart(2, "0");
      else out += ch;
    }
    return out + '"';
  };

  /** Node's util.inspect, minus the colour codes. */
  var inspect = function (value, depth) {
    var type = typeof value;
    if (value === null) return "null";
    if (type === "undefined") return "undefined";
    if (type === "string") return depth === 0 ? value : quote(value);
    if (type === "number" || type === "boolean") return String(value);
    if (type === "bigint") return String(value) + "n";
    if (type === "symbol") return value.toString();
    if (type === "function") {
      return value.name ? "[Function: " + value.name + "]" : "[Function (anonymous)]";
    }
    if (value instanceof Error) return value.stack || value.name + ": " + value.message;
    if (value instanceof Date) return isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (depth > MAX_DEPTH) return Array.isArray(value) ? "[Array]" : "[Object]";
    if (seen.has(value)) return "[Circular]";

    seen.add(value);
    try {
      if (Array.isArray(value)) {
        var items = [];
        var limit = Math.min(value.length, MAX_ITEMS);
        for (var i = 0; i < limit; i++) items.push(inspect(value[i], depth + 1));
        if (value.length > limit) items.push("... " + (value.length - limit) + " more");
        return "[ " + items.join(", ") + " ]";
      }
      if (value instanceof Map) {
        var pairs = [];
        value.forEach(function (v, k) {
          if (pairs.length < MAX_ITEMS) pairs.push(inspect(k, depth + 1) + " => " + inspect(v, depth + 1));
        });
        return "Map(" + value.size + ") { " + pairs.join(", ") + " }";
      }
      if (value instanceof Set) {
        var vals = [];
        value.forEach(function (v) {
          if (vals.length < MAX_ITEMS) vals.push(inspect(v, depth + 1));
        });
        return "Set(" + value.size + ") { " + vals.join(", ") + " }";
      }

      var ctor = value.constructor;
      var prefix = typeof ctor === "function" && ctor !== Object && ctor.name ? ctor.name + " " : "";
      var keys = Object.keys(value);
      if (keys.length === 0) return prefix + "{}";

      var parts = [];
      var shown = Math.min(keys.length, MAX_ITEMS);
      for (var j = 0; j < shown; j++) {
        var key = keys[j];
        var label = IDENTIFIER.test(key) ? key : quote(key);
        var entry;
        try {
          entry = value[key];
        } catch (error) {
          entry = "[getter threw: " + (error && error.message) + "]";
        }
        parts.push(label + ": " + inspect(entry, depth + 1));
      }
      if (keys.length > shown) parts.push("... " + (keys.length - shown) + " more");
      return prefix + "{ " + parts.join(", ") + " }";
    } finally {
      seen.delete(value);
    }
  };
  
  var renderArgs = function (args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(inspect(args[i], 0));
    return parts.join(" ");
  };

  var writer = function (stream) {
    return function () {
      __ivmWrite(stream, renderArgs(arguments) + "\n");
    };
  };

  var toStdout = writer("stdout");
  var toStderr = writer("stderr");

  globalThis.console = {
    log: toStdout,
    info: toStdout,
    debug: toStdout,
    dir: toStdout,
    warn: toStderr,
    error: toStderr,
  };

  console.trace = function () {
    var message = renderArgs(arguments);
    __ivmWrite("stderr", (message ? message + "\n" : "") + (new Error("trace").stack || "") + "\n");
  };

  console.assert = function (condition) {
    if (condition) return;
    var rest = Array.prototype.slice.call(arguments, 1);
    __ivmWrite("stderr", "Assertion failed" + (rest.length ? ": " + renderArgs(rest) : "") + "\n");
  };

  /**
   * Serializes the outcome of the user code to JSON. Done inside the isolate because the result
   * may hold functions, symbols or cyclic references that cannot cross the boundary intact.
   */
  globalThis.__ivmReport = function (ok, value) {
    return JSON.stringify({
      ok: ok,
      result: ok && value !== undefined ? inspect(value, 0) : undefined,
      error: ok ? undefined : inspect(value, 0),
    });
  };
})();
`;

/**
 * The user's code is wrapped in an async IIFE so that both top-level `await` and top-level
 * `return` work, exactly as if the snippet were the body of an async function.
 *
 * The user code starts on line 4 of this wrapper, hence the `lineOffset: -3` used at compile
 * time — that keeps stack traces pointing at the line the caller actually wrote.
 */
const wrapCode = (code: string) =>
  [
    `(async () => {`,
    `  try {`,
    `    return __ivmReport(true, await (async () => {`,
    code,
    `    })());`,
    `  } catch (error) {`,
    `    return __ivmReport(false, error);`,
    `  }`,
    `})()`,
  ].join("\n");

type IsolateRun = {
  stdout: string;
  stderr: string;
  result?: string;
  error?: string;
  truncated: boolean;
  durationMs: number; // Wall time spent in `runInIsolate`, measured up to the moment the code finished.
};

/** Translates the raw isolated-vm failures into something the model can act on. */
function describeVmFailure(error: unknown, timedOut: boolean): string {
  if (!(error instanceof Error)) return String(error);

  const { message } = error;
  if (timedOut) return `Execution timed out after ${TIMEOUT_MS}ms and the isolate was terminated.`;
  if (/timed out/i.test(message)) return `Execution timed out after ${TIMEOUT_MS}ms.`;
  if (/memory limit/i.test(message)) return `Execution exceeded the ${MEMORY_LIMIT_MB}MB memory limit.`;
  if (/abandoned/i.test(message)) return "Execution was aborted.";
  if (message.includes("Cannot use import statement outside a module") || message.includes("Unexpected token 'export'")) {
    return MODULE_SYNTAX_ERROR;
  }

  // isolated-vm folds the host-side stack into `message` when compilation fails, and V8's
  // SyntaxError message already carries the location. Keep the error class and that location,
  // drop the host frames rather than leaking the server's own paths back to the caller.
  const label = error.name && !message.startsWith(error.name) ? `${error.name}: ` : "";
  return label + message.split("\n    at ")[0];
}

/**
 * Runs an already-wrapped snippet in a throwaway isolate. `toolName` only shows up in stack traces
 * and keeps the two VMs apart in the debugger.
 *
 * Takes the wrapped source rather than the raw snippet so that wrapping happens exactly once:
 * `run_typescript` hands over a source that `wrapCode` has already been applied to before esbuild
 * saw it.
 */
async function executeInIsolate(code: string, toolName: string): Promise<IsolateRun> {
  const startedAt = performance.now();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const counts = { stdout: 0, stderr: 0 };
  let truncated = false;

  const append = (stream: "stdout" | "stderr", text: string) => {
    if (counts[stream] >= MAX_STREAM_CHARS) {
      truncated = true;
      return;
    }
    const room = MAX_STREAM_CHARS - counts[stream];
    if (text.length > room) {
      counts[stream] = MAX_STREAM_CHARS;
      truncated = true;
    } else {
      counts[stream] += text.length;
    }
    (stream === "stdout" ? stdout : stderr).push(text.slice(0, room));
  };

  const isolate = new ivm.Isolate({
    memoryLimit: MEMORY_LIMIT_MB,
    onCatastrophicError: (message) => {
      console.error(`isolated-vm catastrophic error: ${message}`);
    },
  });

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    // isolated-vm's run-level timeout only covers synchronous work; it cannot interrupt an
    // isolate parked on a promise that never settles. Disposing the isolate is what unblocks
    // those runs, so this is the real 30 second ceiling.
    if (!isolate.isDisposed) isolate.dispose();
  }, TIMEOUT_MS);
  watchdog.unref();

  const collect = (overrides: Partial<IsolateRun> = {}): IsolateRun => ({
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    truncated,
    durationMs: performance.now() - startedAt,
    ...overrides,
  });

  try {
    const context = await isolate.createContext();

    // Host-side sink used by the bootstrap's console implementation.
    await context.global.setSync("__ivmWrite", (stream: string, text: string) => {
      append(stream === "stderr" ? "stderr" : "stdout", String(text));
    });

    await context.eval(BOOTSTRAP_SOURCE, { filename: `file:///${toolName}/console.js` });

    const script = await isolate.compileScript(code, {
      filename: `file:///${toolName}/main.js`,
      lineOffset: -WRAPPER_PREFIX_LINES,
    });

    const report = JSON.parse(
      (await script.run(context, { timeout: TIMEOUT_MS, promise: true, copy: true })) as string
    ) as { ok: boolean; result?: string; error?: string };

    return collect({ result: report.result, error: report.error });
  } catch (error) {
    return collect({ error: describeVmFailure(error, timedOut) });
  } finally {
    clearTimeout(watchdog);
    if (!isolate.isDisposed) isolate.dispose();
  }
}

type EsbuildFailure = Error & {
  errors?: { text: string; location: { line: number; column: number; lineText: string } | null }[];
};

/** Rewrites an esbuild `TransformFailure` onto the caller's own line numbers. */
function describeEsbuildFailure(error: unknown): string {
  const { errors } = (error ?? {}) as EsbuildFailure;
  if (!Array.isArray(errors) || errors.length === 0) {
    return error instanceof Error ? error.message : String(error);
  }

  return errors
    .map(({ text, location }) => {
      if (!location) return text;
      // Only safe because esbuild already flagged this exact line: the isolate has no module
      // resolver, so a real `import`/`export` can never run.
      if (/^\s*(import|export)\b/.test(location.lineText)) return MODULE_SYNTAX_ERROR;
      // esbuild reports positions in the wrapped source, so undo `wrapCode`'s prefix.
      const line = Math.max(location.line - WRAPPER_PREFIX_LINES, 1);
      return `line ${line}:${location.column}: ${text}`;
    })
    .join("\n");
}

/**
 * Strips the types off a TypeScript snippet with esbuild, returning the wrapped JavaScript.
 *
 * The *wrapped* source is handed to esbuild rather than the bare snippet on purpose: a snippet
 * with a top-level `await` makes esbuild infer an ECMAScript module, which then rejects the
 * top-level `return` that `wrapCode` is built around. Compiling the wrapper keeps both forms legal
 * and makes the emitted JavaScript run through exactly the same path as `run_javascript`.
 */
async function compileTypescript(code: string): Promise<string> {
  const { code: javascript } = await esbuild.transform(wrapCode(code), {
    loader: "ts",
    target: "esnext",
  });
  return javascript;
}

/** Same contract as `run_javascript`, with the snippet compiled by esbuild first. */
async function runTypescript(code: string): Promise<IsolateRun> {
  const startedAt = performance.now();

  let javascript: string;
  try {
    javascript = await compileTypescript(code);
  } catch (error) {
    return {
      stdout: "",
      stderr: "",
      error: describeEsbuildFailure(error),
      truncated: false,
      durationMs: performance.now() - startedAt,
    };
  }

  return executeInIsolate(javascript, "run_typescript");
}

/** Renders the wall time plus the collected streams, the return value and any failure. */
function buildResponseText(run: IsolateRun): string {
  // Always the first line, with a blank line after it to separate the headline from the
  // captured output that follows.
  const sections: string[] = [
    `Code execution finished in ${(run.durationMs / 1000).toFixed(3)} seconds.`
  ];
  const push = (label: string, body: string | undefined) => {
    if (body === undefined) return;
    sections.push(`${label}:\n${body.endsWith("\n") ? body.slice(0, -1) : body}`);
  };

  if (run.stdout) push("stdout", run.stdout);
  if (run.stderr) push("stderr", run.stderr);
  push("result", run.result);
  if (run.truncated) {
    sections.push(`note:\noutput was truncated after ${MAX_STREAM_CHARS} characters per stream.\n`);
  }
  push("error", run.error);

  return sections.join("\n\n");
}

// Server setup
const server = new McpServer(
  {
    name: "js-vm-mcp-server",
    version: "0.0.1",
  },
  {
    // Shared conventions for every tool, stated once instead of repeating them in every
    // tool description. Clients that surface `instructions` pass this to the model.
    instructions:
      "",
  }
);

function checkSnakeCaseKeys<T>(toolName: string, obj: T, schema: unknown) {
  if (!schema || typeof obj !== 'object')
    return;
  if (Array.isArray(obj)) {
    if (!(schema instanceof z.ZodArray))
      return;
    obj.forEach(item => checkSnakeCaseKeys(toolName, item, schema.element));
  }
  if (!(schema instanceof z.ZodObject))
    return;
  const shape = schema.shape;
  const keys = new Set(Object.keys(obj as object));
  for (const key of keys) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!shape[key] && shape[camelKey] && !keys.has(camelKey))
      throw new McpError(
        ErrorCode.InvalidParams,
        `Input validation error: Invalid arguments for tool ${toolName}: Unrecognized key: "${key}". Do you mean "${camelKey}"?`
      );
  }
}

const registerTool = <
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>
): RegisteredTool => {
  const { title, description, inputSchema, outputSchema, annotations, _meta } = config;
  if (inputSchema instanceof z.ZodObject) {
    const origRun = inputSchema._zod.run.bind(inputSchema._zod);
    inputSchema._zod.run = (payload, ctx) => {
      checkSnakeCaseKeys(name, payload.value, inputSchema);
      return origRun(payload, ctx);
    };
  }

  return server.registerTool(
    name,
    {
      title,
      description,
      inputSchema,
      outputSchema,
      annotations,
      _meta
    },
    cb
  );
};

const codeSchema = (language: string) =>
  z.object({
    code: z.string().describe(`${language} code to run`)
  });

/** Shared prose for both VM tools, so the sandbox rules are stated exactly once. */
function describeVmTool(language: string, extraNotes: string[] = []): string {
  return [
    `Execute ${language} inside a hardened V8 isolate (isolated-vm) and return everything it printed.`,
    "",
    "Each call gets a brand new isolate, so no state, memory or globals are shared between runs. " +
    "The isolate is a separate heap with no access to the host process: there is no `require`, " +
    "`process`, `fetch`, timer or file-system API available.",
    "",
    "Limits, per call:",
    `- ${MEMORY_LIMIT_MB} MB of V8 heap.`,
    `- ${TIMEOUT_MS / 1000} seconds of wall time; the isolate is disposed when the limit is hit.`,
    "",
    "Language notes:",
    "- The first line of the response reports how long the run took.",
    ...extraNotes,
    "- The snippet runs as the body of an async function, so top-level `await` and top-level " +
    "`return` are both allowed.",
    "- `console.log`/`console.info`/`console.debug` are captured as stdout; `console.warn`, " +
    "`console.error` and `console.trace` are captured as stderr.",
    "- A top-level `return` value is reported back under `result:`. " +
    "- Uncaught exceptions, syntax errors and their stack traces are reported back under " +
    "`error:`, and the tool is flagged as an error."
  ].join("\n");
}

const TYPESCRIPT_NOTES = [
  "- The snippet is compiled with esbuild (types stripped) and then executed exactly like " +
  "`run_javascript`: same isolate, same limits, same output capture.",
  "- `import`/`export` module syntax is not supported: the isolate has no module resolver, so " +
  "the snippet has to be self-contained.",
  "- Constructs that emit new code (`enum`, `namespace`, constructor parameter properties) make " +
  "esbuild produce extra lines, so a runtime stack trace can point past the line you wrote. " +
  "Plain type annotations keep line numbers exact."
];

const javascriptSchema = codeSchema("JavaScript");
const typescriptSchema = codeSchema("TypeScript");

// Tool registrations

registerTool(
  "run_javascript",
  {
    title: "Run JavaScript",
    description: describeVmTool("JavaScript"),
    inputSchema: javascriptSchema,
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async (args: z.infer<typeof javascriptSchema>) => {
    const run = await executeInIsolate(wrapCode(args.code), "run_javascript");

    return {
      content: [{ type: "text" as const, text: buildResponseText(run) }],
      isError: run.error !== undefined
    };
  }
);

registerTool(
  "run_typescript",
  {
    title: "Run TypeScript",
    description: describeVmTool("TypeScript", TYPESCRIPT_NOTES),
    inputSchema: typescriptSchema,
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async (args: z.infer<typeof typescriptSchema>) => {
    const run = await runTypescript(args.code);

    return {
      content: [{ type: "text" as const, text: buildResponseText(run) }],
      isError: run.error !== undefined
    };
  }
);

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("JavaScript VM MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
