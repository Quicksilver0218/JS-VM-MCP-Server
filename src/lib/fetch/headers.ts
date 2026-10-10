export const HEADERS = String.raw`
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

globalThis.Headers = Headers;
`;