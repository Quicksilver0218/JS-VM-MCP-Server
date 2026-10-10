import ivm from "isolated-vm";

/**
 * Serializes the outcome of the user code to JSON. Done inside the isolate because the result
 * may hold functions, symbols or cyclic references that cannot cross the boundary intact.
 */
export const INSPECT_SHIM = String.raw`
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
`;

const SHIM = String.raw`
var renderArgs = function (args) {
  var parts = [];
  for (var i = 0; i < args.length; i++) parts.push(inspect(args[i], 0));
  return parts.join(" ");
};

var write = (stream, message) => {
  $0.applySync(undefined, [stream, message + "\n"], { result: { copy: true } });
};

var toStdout = (...args) => write("stdout", renderArgs(args));
var toStderr = (...args) => write("stderr", renderArgs(args));

globalThis.console = {
  log: toStdout,
  info: toStdout,
  debug: toStdout,
  dir: toStdout,
  warn: toStderr,
  error: toStderr,
};

console.trace = () => {
  write("stderr", [renderArgs(arguments), new Error("trace").stack].join("\n"));
};

console.assert = (condition) => {
  if (condition) return;
  var rest = Array.prototype.slice.call(arguments, 1);
  write("stderr", "Assertion failed" + (rest.length ? ": " + renderArgs(rest) : ""));
};

globalThis.__ivmReport = function (ok, value) {
  return JSON.stringify({
    ok: ok,
    result: ok && value !== undefined ? inspect(value, 0) : undefined,
    error: ok ? undefined : inspect(value, 0),
  });
};
`;

export default async function inject(context: ivm.Context, appendOutput: (stream: string, message: unknown) => void) {
  await context.evalClosure(INSPECT_SHIM + SHIM, [new ivm.Reference(appendOutput)], {
    filename: `output.js`,
  });
}