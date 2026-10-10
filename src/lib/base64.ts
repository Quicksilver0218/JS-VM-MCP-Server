import { Context } from "isolated-vm";

/**
 * The base64/hex shim, exported as source for the bootstrap closure.
 *
 * The isolate's V8 is built without --js-base-64 and ships no atob/btoa, so all six
 * methods of the TC39 "Uint8Array to/from base64 and hex" proposal are installed from
 * scratch. Everything a caller can observe -- decoded bytes, `{ read, written }`
 * positions, error classes and messages, property descriptors, even the
 * "incompatible receiver" labels V8 prints -- is matched against Node's native
 * implementation (verified by scratch/base64-diff-test.ts running under --js-base-64).
 *
 * The embedded source deliberately avoids backticks and dollar-brace sequences, because
 * it lives inside a String.raw template literal. These outer comments avoid them too,
 * so nothing in this file can terminate a template early.
 */

export const SHIM = String.raw`
// ---- Uint8Array base64 / hex -------------------------------------------------
// A pure-JS polyfill for the TC39 proposal "Uint8Array to/from base64 and hex".
// Behaviour follows V8 (which implements it on top of simdutf), including its three
// distinct SyntaxError messages and its side-effect-free receiver labels.

var B64_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
var B64_HEX_DIGITS = "0123456789abcdef";

// The five ASCII whitespace code units a decoder skips anywhere in the input:
// space, tab, LF, FF, CR. VT (0x0B), NEL, NBSP, U+2028/U+2029 and friends are not.
var b64IsSpace = function (code) {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
};

// Maps one code unit to its 6-bit value under alphabet, or -1 when the character
// cannot appear in a valid base64 string under that alphabet.
var b64CharValue = function (code, alphabet) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (alphabet === "base64") {
    if (code === 43) return 62;
    if (code === 47) return 63;
  } else {
    if (code === 45) return 62;
    if (code === 95) return 63;
  }
  return -1;
};

// The three SyntaxError messages V8 distinguishes for base64 input.
var b64ErrInvalidChar = function () {
  return new SyntaxError("Found a character that cannot be part of a valid base64 string.");
};
var b64ErrRemainder = function () {
  return new SyntaxError("The base64 input terminates with a single character, excluding padding (=).");
};
var b64ErrPaddingBits = function () {
  return new SyntaxError("The base64 input terminates with non-zero padding bits.");
};
// V8 reports both an odd input length and a non-hex character with this one message.
var b64ErrHex = function () {
  return new SyntaxError("Input string must contain hex characters in even length");
};

/**
 * Reads the options bag for a decoding entry point. V8 ignores a non-object options
 * argument entirely (unlike the current spec draft, which throws), so only objects
 * and functions are consulted. alphabet is read and validated first, then
 * lastChunkHandling; unknown properties such as omitPadding are never touched.
 */
var b64ReadDecodeOptions = function (options) {
  var result = { alphabet: "base64", lastChunkHandling: "loose" };
  if (options !== null && options !== undefined &&
      (typeof options === "object" || typeof options === "function")) {
    var alphabet = options.alphabet;
    if (alphabet !== undefined) {
      if (alphabet !== "base64" && alphabet !== "base64url") {
        throw new TypeError("invalid option " + b64ReceiverLabel(alphabet));
      }
      result.alphabet = alphabet;
    }
    var mode = options.lastChunkHandling;
    if (mode !== undefined) {
      if (mode !== "loose" && mode !== "strict" && mode !== "stop-before-partial") {
        throw new TypeError("invalid option " + b64ReceiverLabel(mode));
      }
      result.lastChunkHandling = mode;
    }
  }
  return result;
};

/** Same bag for toBase64: alphabet first, then omitPadding; lastChunkHandling is never read. */
var b64ReadEncodeOptions = function (options) {
  var result = { alphabet: "base64", omitPadding: false };
  if (options !== null && options !== undefined &&
      (typeof options === "object" || typeof options === "function")) {
    var alphabet = options.alphabet;
    if (alphabet !== undefined) {
      if (alphabet !== "base64" && alphabet !== "base64url") {
        throw new TypeError("invalid option " + b64ReceiverLabel(alphabet));
      }
      result.alphabet = alphabet;
    }
    result.omitPadding = !!options.omitPadding;
  }
  return result;
};

/** Function#toString with V8's 128-character truncation of long sources. */
var b64FunctionLabel = function (fn) {
  var source;
  try {
    source = Function.prototype.toString.call(fn);
  } catch (error) {
    return "function () { [native code] }";
  }
  if (source.length > 128) return source.slice(0, 111) + "...<omitted>..." + source.slice(-2);
  return source;
};

/**
 * Reconstructs what V8's Object::NoSideEffectsToString prints for a wrong receiver:
 * primitives verbatim, functions as source, arrays and primitive wrappers via the
 * Object.prototype.toString tag, plain objects as "#<CtorName>", other typed arrays
 * as "undefined", proxies by the tag their target exposes. V8 never invokes getters
 * here, so the toStringTag lookup below only walks data properties.
 */
var b64ReceiverLabel = function (value) {
  if (value === null) return "null";
  var type = typeof value;
  if (type === "undefined") return "undefined";
  if (type === "string") return value;
  if (type === "number" || type === "boolean" || type === "bigint") return String(value);
  if (type === "symbol") return String(value);
  if (type === "function") return b64FunctionLabel(value);

  // Non-Uint8Array typed arrays never reach here as valid receivers; V8 prints them
  // as "undefined". DataView is a view but falls through to the ordinary-object path.
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return "undefined";
  if (Array.isArray(value)) return "[object Array]";
  if (value instanceof Error) {
    try {
      return Error.prototype.toString.call(value);
    } catch (error) {
      // Fall through to the generic tag below.
    }
  }

  var toStringFn;
  try {
    toStringFn = value.toString;
  } catch (error) {
    toStringFn = undefined;
  }
  if (toStringFn === Object.prototype.toString) {
    var ctor;
    try {
      ctor = value.constructor;
    } catch (error) {
      ctor = undefined;
    }
    if (typeof ctor === "function") {
      var ctorName;
      try {
        ctorName = ctor.name;
      } catch (error) {
        ctorName = undefined;
      }
      if (typeof ctorName === "string" && ctorName.length > 0) return "#<" + ctorName + ">";
    }
  }

  // "[object Tag]": V8 reads a string @@toStringTag as a data property only. An
  // accessor makes it fall back to the receiver's builtin class name: "Object" for
  // plain receivers, while a proxy of a typed array (whose toStringTag getter lives
  // on %TypedArray%.prototype) reports the concrete typed-array name it forwards.
  var tag;
  try {
    tag = undefined;
    var walker = value;
    while (walker !== null) {
      var descriptor = Object.getOwnPropertyDescriptor(walker, Symbol.toStringTag);
      if (descriptor !== undefined) {
        if (Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          if (typeof descriptor.value === "string") tag = descriptor.value;
          // Non-string data: leave tag undefined; Object.prototype.toString re-reads
          // it as data (no getters run) and reports the builtin name.
        } else if (walker === Object.getPrototypeOf(Uint8Array.prototype)) {
          var forwardedCtor;
          try {
            forwardedCtor = value.constructor;
          } catch (error) {
            forwardedCtor = undefined;
          }
          tag = typeof forwardedCtor === "function" && forwardedCtor.name
            ? forwardedCtor.name
            : "Uint8Array";
        } else {
          tag = "Object";
        }
        break;
      }
      walker = Object.getPrototypeOf(walker);
    }
  } catch (error) {
    tag = undefined;
  }
  if (tag === undefined) {
    try {
      tag = Object.prototype.toString.call(value).slice(8, -1);
    } catch (error) {
      tag = "Object";
    }
  }
  return "[object " + tag + "]";
};

/**
 * ValidateUint8Array, with V8's exact message shape. ArrayBuffer.isView is part of the
 * brand test because instanceof alone is fooled by proxies: their getPrototypeOf trap
 * forwards to Uint8Array.prototype and would pass the check.
 */
var b64CheckReceiver = function (receiver, methodName) {
  if (!ArrayBuffer.isView(receiver) || !(receiver instanceof Uint8Array)) {
    throw new TypeError(
      "Method " + methodName + " called on incompatible receiver " + b64ReceiverLabel(receiver)
    );
  }
};

/**
 * V8 rejects every Uint8Array that views a resizable ArrayBuffer outright, with the
 * receiver-shaped message and "undefined" as the receiver -- and it does so before it
 * looks at the options bag (a bad alphabet loses to this check, and an option getter
 * never runs). Detaching does not clear the resizable flag, so this check comes first.
 */
var b64CheckResizable = function (receiver, methodName) {
  if (receiver.buffer.resizable === true) {
    throw new TypeError("Method " + methodName + " called on incompatible receiver undefined");
  }
};

/** The spec's out-of-bounds check for a detached buffer (after the options bag). */
var b64CheckAttached = function (ta, methodName) {
  if (ta.buffer.detached === true) {
    throw new TypeError("Cannot perform " + methodName + " on a detached ArrayBuffer");
  }
};

/**
 * The decoder. One forward pass over the string, matching V8's classification:
 *
 *   - a character outside the alphabet, anything after the padding run, or more than
 *     two "=" signs is an immediate invalid-character error;
 *   - a data length of 4k+1 terminates with a single character, in every mode;
 *   - otherwise the final chunk is resolved per lastChunkHandling: "loose" decodes it
 *     (padding mismatch becomes an invalid-character error), "strict" requires exact
 *     padding plus zero leftover bits (otherwise remainder/extra-bits errors), and
 *     "stop-before-partial" returns only the completed 4-character groups.
 *
 * maxLength (Infinity outside setFromBase64) stops the scan before a character that
 * could not fit, mirroring the spec's remaining/chunkLength conditions. The returned
 * bytes hold whatever was completed at the moment of a failure, because setFromBase64
 * writes them before it throws.
 */
var b64Decode = function (string, alphabet, lastChunkHandling, maxLength) {
  var length = string.length;
  var bytes = [];
  var read = 0;
  var chunk = [];
  var padCount = 0;
  var inPadding = false;
  var index = 0;

  var complete = function () {
    bytes.push((chunk[0] << 2) | (chunk[1] >> 4));
    bytes.push(((chunk[1] & 15) << 4) | (chunk[2] >> 2));
    bytes.push(((chunk[2] & 3) << 6) | chunk[3]);
    chunk = [];
  };

  while (true) {
    while (index < length && b64IsSpace(string.charCodeAt(index))) index++;
    if (index >= length) break;

    var code = string.charCodeAt(index);
    var charIndex = index;
    index++;

    if (inPadding) {
      if (code === 61) {
        padCount++;
        if (padCount > 2) return { bytes: bytes, error: b64ErrInvalidChar() };
        continue;
      }
      return { bytes: bytes, error: b64ErrInvalidChar() };
    }
    if (code === 61) {
      inPadding = true;
      padCount = 1;
      continue;
    }

    var value = b64CharValue(code, alphabet);
    if (value < 0) return { bytes: bytes, error: b64ErrInvalidChar() };

    var remaining = maxLength - bytes.length;
    if (remaining === 0 ||
        (remaining === 1 && chunk.length === 2) ||
        (remaining === 2 && chunk.length === 3)) {
      return { bytes: bytes, read: read };
    }

    chunk.push(value);
    if (chunk.length === 4) {
      complete();
      read = charIndex + 1;
      if (bytes.length === maxLength) return { bytes: bytes, read: read };
    }
  }

  var partial = chunk.length;
  if (inPadding) {
    if (partial === 1) return { bytes: bytes, error: b64ErrRemainder() };
    var expected = partial === 2 ? 2 : partial === 3 ? 1 : 0;
    if (padCount === expected && partial !== 0) {
      if (lastChunkHandling === "strict") {
        if (partial === 2 && (chunk[1] & 15) !== 0) return { bytes: bytes, error: b64ErrPaddingBits() };
        if (partial === 3 && (chunk[2] & 3) !== 0) return { bytes: bytes, error: b64ErrPaddingBits() };
      }
      bytes.push((chunk[0] << 2) | (chunk[1] >> 4));
      if (partial === 3) bytes.push(((chunk[1] & 15) << 4) | (chunk[2] >> 2));
      return { bytes: bytes, read: length };
    }
    if (lastChunkHandling === "loose") return { bytes: bytes, error: b64ErrInvalidChar() };
    if (lastChunkHandling === "strict") return { bytes: bytes, error: b64ErrRemainder() };
    return { bytes: bytes, read: read };
  }

  if (partial === 1) return { bytes: bytes, error: b64ErrRemainder() };
  if (partial === 0) return { bytes: bytes, read: length };
  if (lastChunkHandling === "loose") {
    bytes.push((chunk[0] << 2) | (chunk[1] >> 4));
    if (partial === 3) bytes.push(((chunk[1] & 15) << 4) | (chunk[2] >> 2));
    return { bytes: bytes, read: length };
  }
  if (lastChunkHandling === "strict") return { bytes: bytes, error: b64ErrRemainder() };
  return { bytes: bytes, read: read };
};

/** Standard hex decode: even length required first, then pairs; one shared message for both failures. */
var b64DecodeHex = function (string, maxLength) {
  var length = string.length;
  var bytes = [];
  if (length % 2 === 1) return { bytes: bytes, read: 0, error: b64ErrHex() };
  var read = 0;
  var hexValue = function (code) {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 97 && code <= 102) return code - 97 + 10;
    if (code >= 65 && code <= 70) return code - 65 + 10;
    return -1;
  };
  while (read < length && bytes.length < maxLength) {
    var high = hexValue(string.charCodeAt(read));
    var low = hexValue(string.charCodeAt(read + 1));
    if (high < 0 || low < 0) return { bytes: bytes, read: read, error: b64ErrHex() };
    bytes.push(high * 16 + low);
    read += 2;
  }
  return { bytes: bytes, read: read };
};

/** Encodes the bytes to base64 (or base64url), appending "=" padding unless omitted. */
var b64Encode = function (ta, alphabet, omitPadding) {
  var table = alphabet === "base64url" ? B64_URL_ALPHABET : B64_STD_ALPHABET;
  var length = ta.length;
  var out = [];
  var index = 0;
  while (index + 2 < length) {
    var triple = (ta[index] << 16) | (ta[index + 1] << 8) | ta[index + 2];
    out.push(
      table.charAt(triple >> 18), table.charAt((triple >> 12) & 63),
      table.charAt((triple >> 6) & 63), table.charAt(triple & 63)
    );
    index += 3;
  }
  var rest = length - index;
  if (rest === 1) {
    var single = ta[index] << 16;
    out.push(table.charAt(single >> 18), table.charAt((single >> 12) & 63));
    if (!omitPadding) out.push("=", "=");
  } else if (rest === 2) {
    var pair = (ta[index] << 16) | (ta[index + 1] << 8);
    out.push(table.charAt(pair >> 18), table.charAt((pair >> 12) & 63), table.charAt((pair >> 6) & 63));
    if (!omitPadding) out.push("=");
  }
  return out.join("");
};

/** Lowercase hex, two digits per byte. */
var b64EncodeHex = function (ta) {
  var out = [];
  for (var index = 0; index < ta.length; index++) {
    out.push(B64_HEX_DIGITS[ta[index] >> 4], B64_HEX_DIGITS[ta[index] & 15]);
  }
  return out.join("");
};

/** Installs a method with the descriptors the native builtins use. */
var b64Install = function (target, name, method) {
  Object.defineProperty(target, name, {
    value: method,
    writable: true,
    enumerable: false,
    configurable: true,
  });
};

// Named function expressions give every method its native .name; the declared
// parameter list fixes .length (only required parameters are declared).

var b64ToBase64 = function toBase64() {
  b64CheckReceiver(this, "Uint8Array.prototype.toBase64");
  b64CheckResizable(this, "Uint8Array.prototype.toBase64");
  var options = b64ReadEncodeOptions(arguments[0]);
  b64CheckAttached(this, "Uint8Array.prototype.toBase64");
  return b64Encode(this, options.alphabet, options.omitPadding);
};

var b64ToHex = function toHex() {
  b64CheckReceiver(this, "Uint8Array.prototype.toHex");
  b64CheckResizable(this, "Uint8Array.prototype.toHex");
  b64CheckAttached(this, "Uint8Array.prototype.toHex");
  return b64EncodeHex(this);
};

var b64FromBase64 = function fromBase64(string) {
  if (typeof string !== "string") throw new TypeError("input argument must be a string");
  var options = b64ReadDecodeOptions(arguments[1]);
  var outcome = b64Decode(string, options.alphabet, options.lastChunkHandling, Infinity);
  if (outcome.error) throw outcome.error;
  return new Uint8Array(outcome.bytes);
};

var b64FromHex = function fromHex(string) {
  if (typeof string !== "string") throw new TypeError("input argument must be a string");
  var outcome = b64DecodeHex(string, Infinity);
  if (outcome.error) throw outcome.error;
  return new Uint8Array(outcome.bytes);
};

var b64SetFromBase64 = function setFromBase64(string) {
  b64CheckReceiver(this, "Uint8Array.prototype.setFromBase64");
  b64CheckResizable(this, "Uint8Array.prototype.setFromBase64");
  if (typeof string !== "string") throw new TypeError("input argument must be a string");
  var options = b64ReadDecodeOptions(arguments[1]);
  b64CheckAttached(this, "Uint8Array.prototype.setFromBase64");
  var outcome = b64Decode(string, options.alphabet, options.lastChunkHandling, this.length);
  // The spec writes the bytes decoded so far and only then throws, so callers that
  // catch the error still observe the partial result in the buffer.
  this.set(outcome.bytes);
  if (outcome.error) throw outcome.error;
  return { read: outcome.read, written: outcome.bytes.length };
};

var b64SetFromHex = function setFromHex(string) {
  b64CheckReceiver(this, "Uint8Array.prototype.setFromHex");
  b64CheckResizable(this, "Uint8Array.prototype.setFromHex");
  if (typeof string !== "string") throw new TypeError("input argument must be a string");
  b64CheckAttached(this, "Uint8Array.prototype.setFromHex");
  var outcome = b64DecodeHex(string, this.length);
  this.set(outcome.bytes);
  if (outcome.error) throw outcome.error;
  return { read: outcome.read, written: outcome.bytes.length };
};

b64Install(Uint8Array.prototype, "toBase64", b64ToBase64);
b64Install(Uint8Array.prototype, "toHex", b64ToHex);
b64Install(Uint8Array.prototype, "setFromBase64", b64SetFromBase64);
b64Install(Uint8Array.prototype, "setFromHex", b64SetFromHex);
b64Install(Uint8Array, "fromBase64", b64FromBase64);
b64Install(Uint8Array, "fromHex", b64FromHex);
`;

export default async function inject(context: Context) {
  await context.evalClosure(SHIM, undefined, {
    filename: `base64.js`,
  });
}