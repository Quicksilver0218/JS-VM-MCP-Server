export const BLOB = String.raw`
// Blob shim. Each blob keeps its bytes and MIME type in a WeakMap so the slot stays out of
// inspect output; the isolate has no file system or stream machinery behind it.
var blobSlots = new WeakMap();

var blobBytes = function (blob) {
  var slot = blobSlots.get(blob);
  if (!slot) throw new TypeError("Illegal invocation");
  return slot.bytes;
};

var blobType = function (blob) {
  var slot = blobSlots.get(blob);
  if (!slot) throw new TypeError("Illegal invocation");
  return slot.type;
};

// Normalize one constructor part (a string, ArrayBuffer, ArrayBufferView or Blob) to bytes.
var blobPartToBytes = function (part) {
  if (typeof part === "string") return encoder.encode(part);
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (ArrayBuffer.isView(part)) {
    return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
  }
  if (typeof Blob !== "undefined" && part instanceof Blob) return blobBytes(part).slice();
  throw new TypeError("Blob: each part must be a string, ArrayBuffer, ArrayBufferView or Blob");
};

// The MIME type is the token up to the first ";", ASCII-only and lowercased; parameters are
// dropped, matching how the WHATWG Blob/Response type members normalize a type string.
var blobNormalizeType = function (type) {
  if (type === undefined || type === null) return "";
  var s = String(type);
  var semi = s.indexOf(";");
  if (semi !== -1) s = s.slice(0, semi);
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code >= 0x80) continue;
    out += s.charAt(i).toLowerCase();
  }
  var start = 0;
  while (start < out.length && out.charCodeAt(start) <= 0x20) start++;
  var stop = out.length;
  while (stop > start && out.charCodeAt(stop - 1) <= 0x20) stop--;
  return out.slice(start, stop);
};

var Blob = function (parts, options) {
  if (!(this instanceof Blob)) return new Blob(parts, options);
  var input = parts === undefined || parts === null ? [] : parts;
  if (typeof input !== "string" && !Array.isArray(input)) {
    throw new TypeError("Blob: parts must be an array or string of parts");
  }
  var chunks = [];
  var total = 0;
  for (var i = 0; i < input.length; i++) {
    var bytes = blobPartToBytes(input[i]);
    chunks.push(bytes);
    total += bytes.length;
  }
  var data = new Uint8Array(total);
  var offset = 0;
  for (var j = 0; j < chunks.length; j++) {
    data.set(chunks[j], offset);
    offset += chunks[j].length;
  }
  var type = blobNormalizeType(options && options.type);
  blobSlots.set(this, { bytes: data, type: type });
  this.size = data.length;
  this.type = type;
};

Blob.prototype.text = function () {
  return Promise.resolve(new TextDecoder().decode(blobBytes(this)));
};

Blob.prototype.arrayBuffer = function () {
  var bytes = blobBytes(this);
  return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

// slice returns a new blob over the requested range, inheriting the type unless one is given.
Blob.prototype.slice = function (start, end, type) {
  var bytes = blobBytes(this);
  var len = bytes.byteLength;
  var s = start === undefined ? 0 : Math.trunc(start);
  var e = end === undefined ? len : Math.trunc(end);
  if (s < 0) s = Math.max(len + s, 0); else s = Math.min(s, len);
  if (e < 0) e = Math.max(len + e, 0); else e = Math.min(e, len);
  var count = Math.max(0, e - s);
  var out = new Uint8Array(count);
  out.set(bytes.subarray(s, s + count), 0);
  var nextType = type === undefined || type === null ? blobType(this) : type;
  return new Blob([out], { type: nextType });
};

globalThis.Blob = Blob;
`;
