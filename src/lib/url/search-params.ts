/**
 * URLSearchParams for the URL shim.
 *
 * Implements the application/x-www-form-urlencoded serialization: names and values are
 * percent-encoded with the form-urlencoded set (which encodes more than the query set),
 * spaces become "+", and "+" in input decodes back to a space.
 *
 * When a params object is owned by a URL, every mutation writes the new query string back
 * through the url slot, so params.append(...) is visible on url.href and vice versa.
 */

export const URL_SEARCH_PARAMS = String.raw`
var urlSearchSlots = new WeakMap();

// The form-urlencoded encode set: everything outside the safe ASCII alphanumerics and
// "-._*". "~" is deliberately encoded here, unlike in encodeURIComponent.
var URL_FORM_ENCODE_SET =
  "!\"#$%&'()+,/:;<=>?@[\\]^{|}" + String.fromCharCode(96) + "\u007f";

var urlFormDecode = function (text) {
  return urlPercentDecode(text.replace(/\+/g, " "));
};

var urlFormEncode = function (text) {
  return urlPercentEncode(text, URL_FORM_ENCODE_SET, true);
};

var paramsSlot = function (params) {
  var slot = urlSearchSlots.get(params);
  if (!slot) throw new TypeError("Illegal invocation");
  return slot;
};

/** Pushes the current list back onto the owning URL, if there is one. */
var paramsSyncUrl = function (params) {
  var slot = urlSearchSlots.get(params);
  if (!slot || !slot.url) return;
  var serialized = [];
  for (var i = 0; i < slot.list.length; i++) {
    serialized.push(urlFormEncode(slot.list[i][0]) + "=" + urlFormEncode(slot.list[i][1]));
  }
  var text = serialized.join("&");
  slot.url.query = text === "" ? null : text;
};

var URLSearchParams = function (init) {
  if (!(this instanceof URLSearchParams)) return new URLSearchParams(init);
  var list = [];
  if (init !== undefined && init !== null) {
    if (typeof init === "string") {
      // A leading "?" is not part of the query string.
      var body = init.charAt(0) === "?" ? init.substring(1) : init;
      if (body !== "") {
        var pairs = body.split("&");
        for (var i = 0; i < pairs.length; i++) {
          var pair = pairs[i];
          if (pair === "") continue;
          var eq = pair.indexOf("=");
          if (eq === -1) {
            list.push([urlFormDecode(pair), ""]);
          } else {
            list.push([urlFormDecode(pair.substring(0, eq)), urlFormDecode(pair.substring(eq + 1))]);
          }
        }
      }
    } else if (Array.isArray(init)) {
      for (var j = 0; j < init.length; j++) {
        var entry = init[j];
        if (!Array.isArray(entry) || entry.length < 2) {
          throw new TypeError("URLSearchParams: each entry must be a [name, value] pair");
        }
        list.push([String(entry[0]), String(entry[1])]);
      }
    } else if (init instanceof URLSearchParams) {
      list = paramsSlot(init).list.slice();
    } else if (typeof init === "object") {
      for (var key in init) {
        if (Object.prototype.hasOwnProperty.call(init, key)) list.push([String(key), String(init[key])]);
      }
    } else {
      throw new TypeError("URLSearchParams: init must be a string, an array of pairs, a record or URLSearchParams");
    }
  }
  urlSearchSlots.set(this, { list: list, url: null });
};

URLSearchParams.prototype.append = function (name, value) {
  var slot = paramsSlot(this);
  slot.list.push([String(name), String(value)]);
  paramsSyncUrl(this);
};

URLSearchParams.prototype.delete = function (name, value) {
  var slot = paramsSlot(this);
  var target = String(name);
  var hasValue = arguments.length > 1;
  var wanted = String(value);
  for (var i = slot.list.length - 1; i >= 0; i--) {
    if (slot.list[i][0] !== target) continue;
    if (hasValue && slot.list[i][1] !== wanted) continue;
    slot.list.splice(i, 1);
  }
  paramsSyncUrl(this);
};

URLSearchParams.prototype.get = function (name) {
  var slot = paramsSlot(this);
  var target = String(name);
  for (var i = 0; i < slot.list.length; i++) {
    if (slot.list[i][0] === target) return slot.list[i][1];
  }
  return null;
};

URLSearchParams.prototype.getAll = function (name) {
  var slot = paramsSlot(this);
  var target = String(name);
  var out = [];
  for (var i = 0; i < slot.list.length; i++) {
    if (slot.list[i][0] === target) out.push(slot.list[i][1]);
  }
  return out;
};

URLSearchParams.prototype.has = function (name) {
  var slot = paramsSlot(this);
  var target = String(name);
  for (var i = 0; i < slot.list.length; i++) {
    if (slot.list[i][0] === target) return true;
  }
  return false;
};

URLSearchParams.prototype.set = function (name, value) {
  var slot = paramsSlot(this);
  var target = String(name);
  var replacement = String(value);
  var out = [];
  var replaced = false;
  for (var i = 0; i < slot.list.length; i++) {
    if (slot.list[i][0] !== target) {
      out.push(slot.list[i]);
    } else if (!replaced) {
      // set keeps the first occurrence in place and drops the rest.
      out.push([target, replacement]);
      replaced = true;
    }
  }
  if (!replaced) out.push([target, replacement]);
  slot.list = out;
  paramsSyncUrl(this);
};

var encoder = new TextEncoder();
URLSearchParams.prototype.sort = function () {
  var slot = paramsSlot(this);
  slot.list.sort(function (a, b) {
    // Byte-wise comparison of the UTF-8 encoding, as the spec requires.
    var left = encoder.encode(a[0]);
    var right = encoder.encode(b[0]);
    var limit = Math.min(left.length, right.length);
    for (var i = 0; i < limit; i++) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return left.length - right.length;
  });
  paramsSyncUrl(this);
};

URLSearchParams.prototype.forEach = function (callback, thisArg) {
  var slot = paramsSlot(this);
  if (typeof callback !== "function") throw new TypeError("URLSearchParams.forEach: callback must be a function");
  // Iterate over a snapshot so removing entries mid-loop cannot skip one.
  var snapshot = slot.list.slice();
  for (var i = 0; i < snapshot.length; i++) {
    callback.call(thisArg, snapshot[i][1], snapshot[i][0], this);
  }
};

URLSearchParams.prototype.keys = function () {
  var slot = paramsSlot(this);
  var keys = [];
  for (var i = 0; i < slot.list.length; i++) keys.push(slot.list[i][0]);
  return keys[Symbol.iterator]();
};

URLSearchParams.prototype.values = function () {
  var slot = paramsSlot(this);
  var values = [];
  for (var i = 0; i < slot.list.length; i++) values.push(slot.list[i][1]);
  return values[Symbol.iterator]();
};

URLSearchParams.prototype.entries = function () {
  var slot = paramsSlot(this);
  var pairs = [];
  for (var i = 0; i < slot.list.length; i++) pairs.push([slot.list[i][0], slot.list[i][1]]);
  return pairs[Symbol.iterator]();
};

URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;

URLSearchParams.prototype.toString = function () {
  var slot = paramsSlot(this);
  var out = [];
  for (var i = 0; i < slot.list.length; i++) {
    out.push(urlFormEncode(slot.list[i][0]) + "=" + urlFormEncode(slot.list[i][1]));
  }
  return out.join("&");
};

Object.defineProperty(URLSearchParams.prototype, "size", {
  get: function () { return paramsSlot(this).list.length; },
  configurable: true,
});

URLSearchParams.prototype[Symbol.toStringTag] = "URLSearchParams";

globalThis.URLSearchParams = URLSearchParams;
`;
