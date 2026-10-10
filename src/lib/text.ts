import { Context } from "isolated-vm";

const SHIM = String.raw`
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

globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
`;

export default async function inject(context: Context) {
  await context.evalClosure(SHIM, undefined, {
    filename: `text.js`,
  });
}