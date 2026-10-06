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

// Limits for the host-side `fetch` bridge. The isolate has no network stack of its own,
// so every request is performed by the host process, which enforces these same bounds.
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_BODY_BYTES = 8 * 1024 * 1024;

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
 * everything to the host process, a `fetch` shim (plus the `Headers`, `Response`,
 * `AbortController`, `TextEncoder` and `TextDecoder` pieces it needs) wired to the host's
 * network, and a `__ivmReport` helper used to serialize the outcome of the user code back
 * across the isolate boundary.
 *
 * Evaluated with `context.evalClosure` rather than `context.eval`: `$0` is a Reference to
 * the host-side fetch handler and `$1` is the shared body cap. Both are captured by the
 * closure below so they never become reachable from user code.
 *
 * Written with `String.raw` so the escape sequences below survive being embedded in a
 * TypeScript template literal.
 */
const BOOTSTRAP_SOURCE = String.raw`
((hostFetchRef, MAX_FETCH_BODY_BYTES) => {
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

  // ---- fetch bridge, part 1: helpers and Headers -----------------------------
  // The isolate has no network stack, so the fetch installed further down is a shim
  // over a host-side Reference that evalClosure injected as $0 (the shared body cap
  // arrives as $1). Both stay inside this closure: user code only ever sees the
  // globals installed at the end of this section.
  var noop = function () {};

  var makeError = function (name, message) {
    var error = name === "TypeError" ? new TypeError(message) : new Error(message);
    if (error.name !== name) error.name = name;
    return error;
  };

  /** Replacement-character UTF-8 decoder; the isolate has no built-in TextDecoder. */
  var utf8Decode = function (bytes) {
    var out = "";
    var i = 0;
    var length = bytes.length;
    while (i < length) {
      var lead = bytes[i++];
      if (lead < 0x80) {
        out += String.fromCharCode(lead);
        continue;
      }
      var codePoint = 0;
      var extra = 0;
      var min = 0;
      if ((lead & 0xE0) === 0xC0) { codePoint = lead & 0x1F; extra = 1; min = 0x80; }
      else if ((lead & 0xF0) === 0xE0) { codePoint = lead & 0x0F; extra = 2; min = 0x800; }
      else if ((lead & 0xF8) === 0xF0) { codePoint = lead & 0x07; extra = 3; min = 0x10000; }
      else {
        // Stray continuation byte or an out-of-range lead byte.
        out += "\uFFFD";
        continue;
      }
      var consumed = 0;
      while (consumed < extra) {
        var next = i + consumed < length ? bytes[i + consumed] : -1;
        if (next === -1 || (next & 0xC0) !== 0x80) break;
        codePoint = (codePoint << 6) | (next & 0x3F);
        consumed++;
      }
      i += consumed;
      if (consumed < extra) {
        // Malformed or truncated sequence: one U+FFFD for the maximal subpart.
        out += "\uFFFD";
        continue;
      }
      if (codePoint < min || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
        out += "\uFFFD";
        continue;
      }
      if (codePoint < 0x10000) {
        out += String.fromCharCode(codePoint);
      } else {
        var offset = codePoint - 0x10000;
        out += String.fromCharCode(0xD800 + (offset >> 10), 0xDC00 + (offset & 0x3FF));
      }
    }
    return out;
  };

  /** UTF-8 encoder used for string bodies and TextEncoder. Always returns an exact-size view. */
  var utf8Encode = function (text) {
    var bytes = new Uint8Array(text.length * 3 + 4);
    var offset = 0;
    for (var i = 0; i < text.length; i++) {
      var unit = text.charCodeAt(i);
      if (unit < 0x80) {
        bytes[offset++] = unit;
      } else if (unit < 0x800) {
        bytes[offset++] = 0xC0 | (unit >> 6);
        bytes[offset++] = 0x80 | (unit & 0x3F);
      } else if (unit >= 0xD800 && unit <= 0xDBFF && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          var point = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
          bytes[offset++] = 0xF0 | (point >> 18);
          bytes[offset++] = 0x80 | ((point >> 12) & 0x3F);
          bytes[offset++] = 0x80 | ((point >> 6) & 0x3F);
          bytes[offset++] = 0x80 | (point & 0x3F);
          i++;
          continue;
        }
        bytes[offset++] = 0xEF;
        bytes[offset++] = 0xBF;
        bytes[offset++] = 0xBD;
      } else if (unit >= 0xD800) {
        // Lone surrogate: encode U+FFFD instead of emitting invalid UTF-8.
        bytes[offset++] = 0xEF;
        bytes[offset++] = 0xBF;
        bytes[offset++] = 0xBD;
      } else if (unit < 0x10000) {
        bytes[offset++] = 0xE0 | (unit >> 12);
        bytes[offset++] = 0x80 | ((unit >> 6) & 0x3F);
        bytes[offset++] = 0x80 | (unit & 0x3F);
      } else {
        bytes[offset++] = 0xEF;
        bytes[offset++] = 0xBF;
        bytes[offset++] = 0xBD;
      }
    }
    return offset === bytes.length ? bytes : bytes.slice(0, offset);
  };

  // Minimal, case-insensitive header map. The backing list lives in a WeakMap so it stays
  // out of reach of user code and out of inspect output, much like real Headers slots.
  var headerSlots = new WeakMap();

  var headerList = function (headers) {
    var list = headerSlots.get(headers);
    if (!list) throw new TypeError("Illegal invocation");
    return list;
  };

  var normalizeHeaderName = function (name) {
    return String(name).toLowerCase().trim();
  };

  var appendHeader = function (list, name, value) {
    var key = normalizeHeaderName(name);
    var entry = String(value);
    for (var i = 0; i < list.length; i++) {
      if (list[i][0] === key) {
        list[i][1] = list[i][1] + ", " + entry;
        return;
      }
    }
    list.push([key, entry]);
  };

  var setHeader = function (list, name, value) {
    var key = normalizeHeaderName(name);
    var entry = String(value);
    for (var i = 0; i < list.length; i++) {
      if (list[i][0] === key) {
        list[i][1] = entry;
        return;
      }
    }
    list.push([key, entry]);
  };

  var snapshotHeaders = function (list) {
    var copy = [];
    for (var i = 0; i < list.length; i++) copy.push([list[i][0], list[i][1]]);
    return copy;
  };

  var Headers = function (init) {
    if (!(this instanceof Headers)) return new Headers(init);
    var list = [];
    headerSlots.set(this, list);
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      var source = headerList(init);
      for (var i = 0; i < source.length; i++) list.push([source[i][0], source[i][1]]);
      return;
    }
    if (Array.isArray(init)) {
      for (var j = 0; j < init.length; j++) {
        var pair = init[j];
        if (!Array.isArray(pair) || pair.length < 2) {
          throw new TypeError("Headers: each entry must be a [name, value] pair");
        }
        appendHeader(list, pair[0], pair[1]);
      }
      return;
    }
    if (typeof init === "object") {
      for (var key in init) {
        if (Object.prototype.hasOwnProperty.call(init, key)) appendHeader(list, key, init[key]);
      }
      return;
    }
    throw new TypeError("Headers: init must be an object, an array of pairs or a Headers");
  };

  Headers.prototype.append = function (name, value) { appendHeader(headerList(this), name, value); };
  Headers.prototype.set = function (name, value) { setHeader(headerList(this), name, value); };
  Headers.prototype.delete = function (name) {
    var list = headerList(this);
    var key = normalizeHeaderName(name);
    for (var i = list.length - 1; i >= 0; i--) if (list[i][0] === key) list.splice(i, 1);
  };
  Headers.prototype.get = function (name) {
    var list = headerList(this);
    var key = normalizeHeaderName(name);
    var values = [];
    for (var i = 0; i < list.length; i++) if (list[i][0] === key) values.push(list[i][1]);
    return values.length ? values.join(", ") : null;
  };
  Headers.prototype.has = function (name) {
    var list = headerList(this);
    var key = normalizeHeaderName(name);
    for (var i = 0; i < list.length; i++) if (list[i][0] === key) return true;
    return false;
  };
  Headers.prototype.forEach = function (callback, thisArg) {
    if (typeof callback !== "function") throw new TypeError("Headers.forEach: callback must be a function");
    var list = snapshotHeaders(headerList(this));
    for (var i = 0; i < list.length; i++) callback.call(thisArg, list[i][1], list[i][0], this);
  };
  Headers.prototype.entries = function () { return snapshotHeaders(headerList(this))[Symbol.iterator](); };
  Headers.prototype.keys = function () {
    var list = snapshotHeaders(headerList(this));
    var keys = [];
    for (var i = 0; i < list.length; i++) keys.push(list[i][0]);
    return keys[Symbol.iterator]();
  };
  Headers.prototype.values = function () {
    var list = snapshotHeaders(headerList(this));
    var values = [];
    for (var i = 0; i < list.length; i++) values.push(list[i][1]);
    return values[Symbol.iterator]();
  };
  Headers.prototype[Symbol.iterator] = Headers.prototype.entries;

  // ---- fetch bridge, part 2: Response, abort signals and text codecs ---------
  // The response body is buffered up front: the isolate has no ReadableStream, so
  // body is always null and the bytes are kept in a WeakMap until read.
  var responseSlots = new WeakMap();

  var copyToArrayBuffer = function (bytes) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };

  var Response = function (body, init) {
    if (!(this instanceof Response)) return new Response(body, init);
    init = init || {};
    var bytes;
    if (body === undefined || body === null) {
      bytes = new Uint8Array(0);
    } else if (typeof body === "string") {
      bytes = utf8Encode(body);
    } else if (body instanceof ArrayBuffer) {
      bytes = new Uint8Array(body);
    } else if (ArrayBuffer.isView(body)) {
      bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } else {
      bytes = utf8Encode(String(body));
    }
    var status = init.status === undefined ? 200 : Number(init.status);
    if (!isFinite(status)) status = 200;
    status = Math.floor(status);
    if (status < 0) status = 0;
    if (status > 999) status = 999;
    responseSlots.set(this, bytes);
    this.status = status;
    this.statusText = init.statusText === undefined ? "" : String(init.statusText);
    this.ok = status >= 200 && status < 300;
    this.url = init.url === undefined ? "" : String(init.url);
    this.redirected = !!init.redirected;
    this.type = init.type === undefined ? "default" : String(init.type);
    this.headers = new Headers(init.headers);
    this.body = null; // no ReadableStream inside the isolate
    this.bodyUsed = false;
  };

  var unreadBody = function (response) {
    if (!responseSlots.has(response)) return new TypeError("Illegal invocation");
    if (response.bodyUsed) return new TypeError("Body is unusable: it has already been read");
    return null;
  };

  Response.prototype.text = function () {
    var failure = unreadBody(this);
    if (failure) return Promise.reject(failure);
    this.bodyUsed = true;
    return Promise.resolve(utf8Decode(responseSlots.get(this)));
  };

  Response.prototype.json = function () {
    return this.text().then(function (text) { return JSON.parse(text); });
  };

  Response.prototype.arrayBuffer = function () {
    var failure = unreadBody(this);
    if (failure) return Promise.reject(failure);
    this.bodyUsed = true;
    return Promise.resolve(copyToArrayBuffer(responseSlots.get(this)));
  };

  Response.prototype.clone = function () {
    if (!responseSlots.has(this)) throw new TypeError("Illegal invocation");
    if (this.bodyUsed) throw new TypeError("Cannot clone a response whose body has already been read");
    return new Response(responseSlots.get(this).slice(), {
      status: this.status,
      statusText: this.statusText,
      url: this.url,
      redirected: this.redirected,
      type: this.type,
      headers: this.headers,
    });
  };

  // AbortController/AbortSignal shim. There are no timers inside the isolate, so
  // AbortSignal.timeout cannot exist; signals are aborted from promise-driven code.
  var signalSlots = new WeakMap();

  var triggerAbort = function (signal, reason) {
    if (!signal || signal.aborted) return;
    signal.aborted = true;
    signal.reason = reason === undefined ? makeError("AbortError", "The operation was aborted") : reason;
    var slot = signalSlots.get(signal);
    var listeners = slot ? slot.listeners.slice() : [];
    if (typeof signal.onabort === "function") {
      try { signal.onabort.call(signal, signal.reason); } catch (error) { /* user callback */ }
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i].call(signal, signal.reason); } catch (error) { /* user callback */ }
    }
  };

  var AbortSignal = function () {
    if (!(this instanceof AbortSignal)) return new AbortSignal();
    this.aborted = false;
    this.reason = undefined;
    this.onabort = null;
    signalSlots.set(this, { listeners: [] });
  };

  AbortSignal.prototype.addEventListener = function (type, listener) {
    if (type !== "abort" || typeof listener !== "function") return;
    var slot = signalSlots.get(this);
    if (!slot) throw new TypeError("Illegal invocation");
    if (slot.listeners.indexOf(listener) === -1) slot.listeners.push(listener);
  };

  AbortSignal.prototype.removeEventListener = function (type, listener) {
    var slot = signalSlots.get(this);
    if (!slot) return;
    var index = slot.listeners.indexOf(listener);
    if (index !== -1) slot.listeners.splice(index, 1);
  };

  AbortSignal.prototype.throwIfAborted = function () {
    if (this.aborted) throw this.reason;
  };

  AbortSignal.abort = function (reason) {
    var signal = new AbortSignal();
    triggerAbort(signal, reason);
    return signal;
  };

  var AbortController = function () {
    if (!(this instanceof AbortController)) return new AbortController();
    this.signal = new AbortSignal();
  };

  AbortController.prototype.abort = function (reason) {
    triggerAbort(this.signal, reason);
  };

  var TextDecoder = function (label) {
    if (!(this instanceof TextDecoder)) return new TextDecoder(label);
    var encoding = label === undefined ? "utf-8" : String(label).trim().toLowerCase();
    if (encoding !== "utf-8" && encoding !== "utf8" && encoding !== "unicode-1-1-utf-8") {
      throw new RangeError("TextDecoder: unsupported encoding " + label);
    }
    this.encoding = "utf-8";
    this.fatal = false;
    this.ignoreBOM = false;
  };

  TextDecoder.prototype.decode = function (input) {
    if (input === undefined || input === null) return "";
    if (typeof input === "string") return input; // lenient: the spec only accepts BufferSource
    if (input instanceof ArrayBuffer) return utf8Decode(new Uint8Array(input));
    if (ArrayBuffer.isView(input)) {
      return utf8Decode(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    }
    throw new TypeError("TextDecoder.decode: expected an ArrayBuffer or a typed array");
    // The { stream: true } option is ignored: there is no streaming source to carry
    // incomplete sequences over.
  };

  var TextEncoder = function () {
    if (!(this instanceof TextEncoder)) return new TextEncoder();
    this.encoding = "utf-8";
    this.fatal = false;
    this.ignoreBOM = false;
  };

  TextEncoder.prototype.encode = function (text) {
    return utf8Encode(text === undefined ? "" : String(text));
  };

  // ---- fetch bridge, part 3: fetch itself ------------------------------------
  var nextFetchId = 0;

  var encodeFetchBody = function (body) {
    if (body === undefined || body === null) return { bytes: undefined, wasString: false };
    if (typeof body === "string") return { bytes: utf8Encode(body), wasString: true };
    if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body), wasString: false };
    if (ArrayBuffer.isView(body)) {
      return { bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), wasString: false };
    }
    // Anything else is stringified, matching the BodyInit conversion in the fetch spec.
    return { bytes: utf8Encode(String(body)), wasString: true };
  };

  /**
   * fetch shim: everything runs in the isolate except the request itself, which is
   * performed by the host process through hostFetchRef. The returned promise settles
   * exactly once; aborting a request also cancels it host-side and discards the reply.
   */
  var fetch = function (input, init) {
    return new Promise(function (resolve, reject) {
      var url;
      var template = null;
      if (typeof input === "string") {
        url = input;
      } else if (input && typeof input === "object" && typeof input.url === "string") {
        template = input;
        url = input.url;
      } else {
        reject(new TypeError("fetch: input must be a URL string or an object with a string url property"));
        return;
      }

      var pick = function (key, fallback) {
        if (init && typeof init === "object" && Object.prototype.hasOwnProperty.call(init, key)) {
          return init[key];
        }
        if (template && template[key] !== undefined) return template[key];
        return fallback;
      };

      var method = pick("method", "GET");
      if (typeof method !== "string") {
        reject(new TypeError("fetch: method must be a string"));
        return;
      }
      method = method.toUpperCase();

      var redirect = pick("redirect", "follow");
      if (redirect !== "follow" && redirect !== "error" && redirect !== "manual") {
        reject(new TypeError("fetch: redirect must be one of follow, error or manual"));
        return;
      }

      var signal = pick("signal", undefined);
      if (signal !== undefined && signal !== null && !signalSlots.has(signal)) {
        reject(new TypeError("fetch: signal must be an AbortSignal"));
        return;
      }
      if (signal && signal.aborted) {
        reject(signal.reason);
        return;
      }

      var encoded = encodeFetchBody(pick("body", undefined));
      if (encoded.bytes !== undefined) {
        if (method === "GET" || method === "HEAD") {
          reject(new TypeError("fetch: Request with GET/HEAD method cannot have body."));
          return;
        }
        if (encoded.bytes.byteLength > MAX_FETCH_BODY_BYTES) {
          reject(new TypeError(
            "fetch: request body of " + encoded.bytes.byteLength + " bytes exceeds the " +
            MAX_FETCH_BODY_BYTES + "-byte limit"
          ));
          return;
        }
      }

      var headers = new Headers(pick("headers", undefined));
      if (encoded.wasString && !headers.has("content-type")) {
        // The fetch spec defaults string bodies to text/plain.
        headers.append("content-type", "text/plain;charset=UTF-8");
      }

      var id = ++nextFetchId;
      var settled = false;
      var cleanup = function () {
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      var onAbort = function (reason) {
        if (settled) return;
        settled = true;
        cleanup();
        // Ask the host to cancel the in-flight request; its late reply is dropped by
        // the settled guards in the handlers below.
        hostFetchRef.apply(undefined, [{ action: "abort", id: id }], {
          arguments: { copy: true },
          result: { promise: true, copy: true },
        }).then(noop, noop);
        reject(reason === undefined ? makeError("AbortError", "The operation was aborted") : reason);
      };
      if (signal) signal.addEventListener("abort", onAbort);

      hostFetchRef.apply(undefined, [{
        action: "fetch",
        id: id,
        url: url,
        method: method,
        headers: headerSlots.get(headers),
        body: encoded.bytes,
        redirect: redirect,
      }], {
        arguments: { copy: true },
        result: { promise: true, copy: true },
      }).then(function (reply) {
        if (settled) return;
        settled = true;
        cleanup();
        if (!reply || reply.ok !== true) {
          var name = reply && reply.name ? reply.name : "TypeError";
          reject(makeError(name, (reply && reply.error) || "fetch failed"));
          return;
        }
        resolve(new Response(reply.body, {
          status: reply.status,
          statusText: reply.statusText,
          headers: reply.headers,
          url: reply.url,
          redirected: reply.redirected,
          type: "basic",
        }));
      }, function (error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(makeError("TypeError", "fetch bridge failed: " + ((error && error.message) || error)));
      });
    });
  };

  globalThis.fetch = fetch;
  globalThis.Headers = Headers;
  globalThis.Response = Response;
  globalThis.AbortController = AbortController;
  globalThis.AbortSignal = AbortSignal;
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;

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
})($0, $1);
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

// ---- host-side `fetch` bridge ------------------------------------------------

/** Discriminated message the isolate sends over the injected fetch `Reference`. */
type FetchRequest = { action: "fetch"; id: number } & Request | { action: "abort"; id: number };

/** What comes back across the boundary: a fully buffered response or a transport failure. */
type FetchReply =
  | {
      ok: true;
      url: string;
      status: number;
      statusText: string;
      headers: [string, string][];
      redirected: boolean;
      body: Uint8Array;
    }
  | { ok: false; name: string; error: string };

/** Keeps undici's `fetch failed` wrapper and its usually more useful `cause` together. */
function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

/** Reads a whole response body into one buffer, refusing anything past the shared cap. */
async function readFetchBody(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FETCH_BODY_BYTES) {
          throw new Error(`Response body exceeded the ${MAX_FETCH_BODY_BYTES}-byte fetch limit.`);
        }
        chunks.push(value);
      }
    } finally {
      // Frees the connection when the size cap aborts the read early.
      reader.cancel().catch(() => { /* nothing left to read */ });
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Builds the host half of the `fetch` bridge: the function the isolate calls through the
 * injected `Reference`. State is per run, so one call's in-flight requests can be cancelled
 * without ever touching another call's, and nothing survives the run.
 */
function createFetchHandler(): (request: FetchRequest) => Promise<FetchReply | null> {
  const inFlight = new Map<number, AbortController>();

  return async (request: FetchRequest): Promise<FetchReply | null> => {
    if (request.action === "abort") {
      inFlight.get(request.id)?.abort();
      return null;
    }

    const controller = new AbortController();
    inFlight.set(request.id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    timer.unref();

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: request.redirect,
        signal: controller.signal,
      });

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_FETCH_BODY_BYTES) {
        throw new Error(
          `Response declared ${declared} bytes, over the ${MAX_FETCH_BODY_BYTES}-byte fetch limit.`
        );
      }

      return {
        ok: true,
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers) as [string, string][],
        redirected: response.redirected,
        body: await readFetchBody(response),
      };
    } catch (error) {
      if (timedOut) {
        return { ok: false, name: "TimeoutError", error: `fetch timed out after ${FETCH_TIMEOUT_MS}ms.` };
      }
      if (controller.signal.aborted) {
        return { ok: false, name: "AbortError", error: describeFetchFailure(error) };
      }
      // Real `fetch` rejects with a TypeError for every transport-level failure, so keep
      // that contract even when the underlying error is something else.
      return { ok: false, name: "TypeError", error: describeFetchFailure(error) };
    } finally {
      clearTimeout(timer);
      inFlight.delete(request.id);
    }
  };
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
    await context.global.set("__ivmWrite", (stream: string, text: string) => {
      append(stream === "stderr" ? "stderr" : "stdout", String(text));
    });

    // Host half of the `fetch` bridge: a Reference the bootstrap captures through
    // evalClosure's `$0` (the shared body cap is `$1`), so neither ever lands on the
    // isolate's global object and user code can only reach them via the `fetch` shim.
    const fetchReference = new ivm.Reference(createFetchHandler());
    await context.evalClosure(BOOTSTRAP_SOURCE, [fetchReference, MAX_FETCH_BODY_BYTES], {
      filename: `file:///${toolName}/bootstrap.js`,
    });

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
    "`process`, timer or file-system API available.",
    "",
    "Limits, per call:",
    `- ${MEMORY_LIMIT_MB} MB of V8 heap.`,
    `- ${TIMEOUT_MS / 1000} seconds of wall time; the isolate is disposed when the limit is hit.`,
    "",
    "`fetch` is available: the isolate has no network stack of its own, so each request is " +
    "performed by the host process and the response is copied back in. Per request:",
    `- ${FETCH_TIMEOUT_MS / 1000} seconds of wall time; a slower request rejects with a \`TimeoutError\`.`,
    `- Bodies in either direction are capped at ${MAX_FETCH_BODY_BYTES} bytes.`,
    "- `http:` and `https:` URLs only; the host sends no cookies and follows redirects unless " +
    "`redirect` says otherwise.",
    "",
    "Language notes:",
    "- The first line of the response reports how long the run took.",
    ...extraNotes,
    "- The snippet runs as the body of an async function, so top-level `await` and top-level " +
    "`return` are both allowed.",
    "- `console.log`/`console.info`/`console.debug` are captured as stdout; `console.warn`, " +
    "`console.error` and `console.trace` are captured as stderr.",
    "- `fetch`, `Headers`, `Response`, `AbortController`, `TextEncoder` and `TextDecoder` are " +
    "minimal shims: `response.text()`, `response.json()`, `response.arrayBuffer()` and " +
    "`response.clone()` work, but `response.body` is `null` (no streams, no `blob()`), " +
    "`URL`/`Request`/`FormData`/`Blob` do not exist, and the isolate has no timers, so " +
    "`setTimeout` and `AbortSignal.timeout` are unavailable.",
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
    // fetch can reach (and mutate) the outside world through the host process.
    annotations: { openWorldHint: true }
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
    // fetch can reach (and mutate) the outside world through the host process.
    annotations: { openWorldHint: true }
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
