export const RESPONSE = `
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
    bytes = encoder.encode(body);
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else if (typeof Blob !== "undefined" && body instanceof Blob) {
    bytes = blobBytes(body);
  } else {
    bytes = encoder.encode(String(body));
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
  return Promise.resolve(new TextDecoder().decode(responseSlots.get(this)));
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

// Wrap the buffered body in a Blob, deriving its type from the response content-type.
Response.prototype.blob = function () {
  var failure = unreadBody(this);
  if (failure) return Promise.reject(failure);
  this.bodyUsed = true;
  var bytes = responseSlots.get(this);
  var type = this.headers.get("content-type");
  return Promise.resolve(new Blob([bytes], { type: type }));
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

globalThis.Response = Response;
`;