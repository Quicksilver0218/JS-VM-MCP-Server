/**
 * The URL class for the URL shim: constructor, every accessor, every setter, and the
 * searchParams live link.
 *
 * Setters that rewrite a single component re-run the parser over the *existing* record
 * with the entry state pinned (stateOverride), which is how the spec keeps the rest of
 * the URL intact. The protocol setter is the exception: changing between special and
 * non-special schemes is ignored outright, and dropping the port only applies when the
 * new scheme has a default.
 */

export const URL_CLASS = String.raw`
var urlSlots = new WeakMap();

var urlSlot = function (url) {
  var slot = urlSlots.get(url);
  if (!slot) throw new TypeError("Illegal invocation");
  return slot;
};

var URL = function (url, base) {
  if (!(this instanceof URL)) return new URL(url, base);
  var baseRecord = null;
  if (base !== undefined && base !== null) {
    if (base instanceof URL) {
      baseRecord = urlSlot(base).record;
    } else {
      var parsedBase = urlParse(String(base), null, undefined);
      if (parsedBase === null) throw new TypeError("Invalid base URL");
      baseRecord = parsedBase;
    }
  }
  var record = urlParse(url === undefined ? "undefined" : String(url), baseRecord, undefined);
  if (record === null) throw TypeError("Invalid URL");
  // Built lazily: the params object must exist before the first searchParams read,
  // and must keep pointing at this URL so mutations flow both ways.
  var slot = { record: record, params: null };
  urlSlots.set(this, slot);
};

Object.defineProperty(URL.prototype, "href", {
  get: function () { return urlSerialize(urlSlot(this).record); },
  set: function (value) {
    var record = urlParse(String(value), null, undefined);
    if (record === null) throw TypeError("Invalid URL");
    var slot = urlSlot(this);
    slot.record = record;
    // The params object now describes a different query string.
    if (slot.params) urlSearchSlots.get(slot.params).list = urlParseQuery(record.query);
  },
  enumerable: true,
});

Object.defineProperty(URL.prototype, "origin", {
  get: function () { return urlOrigin(urlSlot(this).record); },
  enumerable: true,
});

Object.defineProperty(URL.prototype, "protocol", {
  get: function () { return urlSlot(this).record.scheme + ":"; },
  set: function (value) {
    var slot = urlSlot(this);
    var record = slot.record;
    var candidate = String(value);
    // The setter accepts a bare scheme or one with a trailing colon.
    var scheme = candidate.replace(/:$/, "").toLowerCase();
    if (!/^[a-z][a-z0-9+\-.]*$/.test(scheme)) return;
    var wasSpecial = urlIsSpecial(record.scheme);
    var isSpecial = urlIsSpecial(scheme);
    // Switching between special and non-special is not allowed.
    if (wasSpecial !== isSpecial) return;
    if (wasSpecial && isSpecial && scheme !== record.scheme && scheme !== "file") {
      // Special schemes other than file are interchangeable, but the default port
      // may need dropping.
      record.scheme = scheme;
      if (record.port !== null && URL_DEFAULT_PORTS[record.scheme] === record.port) record.port = null;
      return;
    }
    if (wasSpecial && isSpecial && scheme === "file") {
      record.scheme = "file";
      return;
    }
    record.scheme = scheme;
  },
  enumerable: true,
});

/** Re-parses an authority-shaped string ("host[:port]") into the record. */
var urlApplyAuthority = function (record, value) {
  var probe = { scheme: record.scheme, cannotBeABase: false, path: [], query: null, fragment: null, username: "", password: "", host: null, port: null, hasHost: false };
  var parsed = urlParse(value, probe, "hostname");
  if (parsed === null) return false;
  record.host = parsed.host;
  record.hasHost = parsed.hasHost;
  record.port = parsed.port;
  return true;
};

Object.defineProperty(URL.prototype, "username", {
  get: function () { return urlSlot(this).record.username; },
  set: function (value) {
    urlSlot(this).record.username = urlPercentEncode(String(value), URL_USERINFO_SET, false);
  },
  enumerable: true,
});

Object.defineProperty(URL.prototype, "password", {
  get: function () { return urlSlot(this).record.password; },
  set: function (value) {
    urlSlot(this).record.password = urlPercentEncode(String(value), URL_USERINFO_SET, false);
  },
  enumerable: true,
});

Object.defineProperty(URL.prototype, "host", {
  get: function () {
    var record = urlSlot(this).record;
    if (record.host === null) return "";
    return record.host + (record.port === null ? "" : ":" + record.port);
  },
  set: function (value) {
    var record = urlSlot(this).record;
    // A URL without a host cannot gain one this way.
    if (record.host === null && !urlIsSpecial(record.scheme)) return;
    urlApplyAuthority(record, String(value));
  },
  enumerable: true,
});

Object.defineProperty(URL.prototype, "hostname", {
  get: function () {
    var record = urlSlot(this).record;
    return record.host === null ? "" : record.host;
  },
  set: function (value) {
    var record = urlSlot(this).record;
    if (record.host === null && !urlIsSpecial(record.scheme)) return;
    // The state override keeps the port while replacing the host.
    var parsed = urlParse(String(value), record, "hostname");
    if (parsed === null) return;
    record.host = parsed.host;
    record.hasHost = parsed.hasHost;
  },
  enumerable: true,
});

Object.defineProperty(URL.prototype, "port", {
  get: function () {
    var record = urlSlot(this).record;
    return record.port === null ? "" : String(record.port);
  },
  set: function (value) {
    var record = urlSlot(this).record;
    var text = String(value);
    if (text === "") {
      record.port = null;
      return;
    }
    if (!/^[0-9]+$/.test(text)) return;
    var port = parseInt(text, 10);
    if (port > 65535) return;
    record.port = URL_DEFAULT_PORTS[record.scheme] === port ? null : port;
  },
  enumerable: true,
});

Object.defineProperty(URL.prototype, "pathname", {
  get: function () {
    var record = urlSlot(this).record;
    if (record.host === null && !urlIsSpecial(record.scheme) && record.cannotBeABase) {
      return record.path[0];
    }
    return "/" + record.path.join("/");
  },
  set: function (value) {
    var record = urlSlot(this).record;
    // Re-parse just the path, starting from the path-start state.
    var parsed = urlParse(String(value), record, "path start");
    if (parsed === null) return;
    record.path = parsed.path;
    record.cannotBeABase = parsed.cannotBeABase;
  },
  enumerable: true,
});

Object.defineProperty(URL.prototype, "search", {
  get: function () {
    var record = urlSlot(this).record;
    return record.query === null ? "" : "?" + record.query;
  },
  set: function (value) {
    var record = urlSlot(this).record;
    var text = String(value);
    // A leading "?" is not part of the query string.
    var body = text.charAt(0) === "?" ? text.substring(1) : text;
    record.query = body === "" ? null : urlPercentEncode(
      body,
      urlIsSpecial(record.scheme) ? URL_QUERY_SET + "'" : URL_QUERY_SET,
      false
    );
    var slot = urlSlot(this);
    if (slot.params) urlSearchSlots.get(slot.params).list = urlParseQuery(record.query);
  },
  enumerable: true,
});

Object.defineProperty(URL.prototype, "hash", {
  get: function () {
    var record = urlSlot(this).record;
    return record.fragment === null ? "" : "#" + record.fragment;
  },
  set: function (value) {
    var record = urlSlot(this).record;
    var text = String(value);
    var body = text.charAt(0) === "#" ? text.substring(1) : text;
    record.fragment = body === "" ? null : urlPercentEncode(body, URL_FRAGMENT_SET, false);
  },
  enumerable: true,
});

/** Splits a serialized query string into the pair list the params object stores. */
var urlParseQuery = function (query) {
  var list = [];
  if (query === null || query === "") return list;
  var pairs = query.split("&");
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
  return list;
};

Object.defineProperty(URL.prototype, "searchParams", {
  get: function () {
    var slot = urlSlot(this);
    if (slot.params === null) {
      var params = new URLSearchParams();
      urlSearchSlots.get(params).list = urlParseQuery(slot.record.query);
      // Hand the params object a pointer back so its mutations rewrite the query.
      urlSearchSlots.get(params).url = slot.record;
      slot.params = params;
    } else {
      // The URL's query may have been replaced by the search setter since.
      var list = urlParseQuery(slot.record.query);
      var slotList = urlSearchSlots.get(slot.params).list;
      if (list.length !== slotList.length ||
          list.some(function (pair, i) { return pair[0] !== slotList[i][0] || pair[1] !== slotList[i][1]; })) {
        urlSearchSlots.get(slot.params).list = list;
      }
    }
    return slot.params;
  },
  enumerable: true,
});

URL.prototype.toJSON = function () { return urlSerialize(urlSlot(this).record); };
URL.prototype.toString = function () { return urlSerialize(urlSlot(this).record); };
URL.prototype[Symbol.toStringTag] = "URL";

/** True when input parses, optionally against base. Never throws. */
URL.canParse = function (input, base) {
  var baseRecord = null;
  if (base !== undefined && base !== null) {
    baseRecord = urlParse(String(base), null, undefined);
    if (baseRecord === null) return false;
  }
  return urlParse(String(input), baseRecord, undefined) !== null;
};

/** Parses input, returning a URL or null instead of throwing. */
URL.parse = function (input, base) {
  var baseRecord = null;
  if (base !== undefined && base !== null) {
    baseRecord = urlParse(String(base), null, undefined);
    if (baseRecord === null) return null;
  }
  var record = urlParse(String(input), baseRecord, undefined);
  if (record === null) return null;
  var url = Object.create(URL.prototype);
  urlSlots.set(url, { record: record, params: null });
  return url;
};

globalThis.URL = URL;
`;
