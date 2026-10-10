export const FORMDATA = String.raw`
// FormData shim: an ordered bag of form entries. Each value is either a string or a Blob
// (which may carry a filename for the multipart content-disposition). The entry list lives
// in a WeakMap so it never leaks into inspect output.
var formDataSlots = new WeakMap();

var fdEntries = function (fd) {
  var slot = formDataSlots.get(fd);
  if (!slot) throw new TypeError("Illegal invocation");
  return slot.entries;
};

var FormData = function (form) {
  if (!(this instanceof FormData)) return new FormData(form);
  // No DOM in the isolate, so only the empty constructor is meaningful; a form-element
  // argument is accepted and ignored rather than throwing.
  var entries = [];
  formDataSlots.set(this, { entries: entries });
};

// value is a string, or a Blob whose optional filename is the third argument.
FormData.prototype.append = function (name, value, filename) {
  var entries = fdEntries(this);
  var key = String(name);
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    entries.push({
      name: key,
      kind: "blob",
      value: value,
      filename: filename === undefined ? "" : String(filename)
    });
  } else {
    entries.push({ name: key, kind: "string", value: String(value) });
  }
};

// set removes any existing entries with the same name, then appends.
FormData.prototype.set = function (name, value, filename) {
  var entries = fdEntries(this);
  var key = String(name);
  for (var i = entries.length - 1; i >= 0; i--) if (entries[i].name === key) entries.splice(i, 1);
  this.append(key, value, filename);
};

FormData.prototype.get = function (name) {
  var entries = fdEntries(this);
  var key = String(name);
  for (var i = 0; i < entries.length; i++) if (entries[i].name === key) return entries[i].value;
  return null;
};

FormData.prototype.getAll = function (name) {
  var entries = fdEntries(this);
  var key = String(name);
  var out = [];
  for (var i = 0; i < entries.length; i++) if (entries[i].name === key) out.push(entries[i].value);
  return out;
};

FormData.prototype.has = function (name) {
  var entries = fdEntries(this);
  var key = String(name);
  for (var i = 0; i < entries.length; i++) if (entries[i].name === key) return true;
  return false;
};

FormData.prototype.delete = function (name) {
  var entries = fdEntries(this);
  var key = String(name);
  for (var i = entries.length - 1; i >= 0; i--) if (entries[i].name === key) entries.splice(i, 1);
};

FormData.prototype.forEach = function (callback, thisArg) {
  if (typeof callback !== "function") throw new TypeError("FormData.forEach: callback must be a function");
  var snapshot = fdEntries(this).slice();
  for (var i = 0; i < snapshot.length; i++) {
    callback.call(thisArg, snapshot[i].value, snapshot[i].name, this);
  }
};

// A real FormData iterator is also iterable: it exposes Symbol.iterator returning itself, so
// for...of over fd.keys() works exactly like calling .next() repeatedly. This mirrors the built-ins.
var fdIterator = function (next) {
  var iter = { next: next };
  iter[Symbol.iterator] = function () { return iter; };
  return iter;
};

// The iterators hand out [name, value] pairs; a snapshot is iterated so mid-iteration
// mutation of the form data cannot shift the entries under the caller.
FormData.prototype.entries = function () {
  var snapshot = fdEntries(this).slice();
  var i = 0;
  return fdIterator(function () {
    if (i >= snapshot.length) return { done: true };
    var entry = snapshot[i++];
    return { done: false, value: [entry.name, entry.value] };
  });
};

FormData.prototype.keys = function () {
  var snapshot = fdEntries(this).slice();
  var i = 0;
  return fdIterator(function () {
    if (i >= snapshot.length) return { done: true };
    return { done: false, value: snapshot[i++].name };
  });
};

FormData.prototype.values = function () {
  var snapshot = fdEntries(this).slice();
  var i = 0;
  return fdIterator(function () {
    if (i >= snapshot.length) return { done: true };
    return { done: false, value: snapshot[i++].value };
  });
};

FormData.prototype[Symbol.iterator] = function () { return this.entries(); };

// Serialize a FormData as an application/x-www-form-urlencoded-safe multipart/form-data
// body: one part per entry, terminated by a closing boundary. Returns the bytes plus the
// content-type the caller must send so the boundary is discoverable.
var CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
var encodeFormData = function (fd) {
  var entries = fdEntries(fd);
  var boundary = "----WebKitFormBoundary";
  for (var i = 0; i < 16; i++) boundary += CHARACTERS[Math.random() * CHARACTERS.length | 0];
  var chunks = [];
  var addStr = function (text) { chunks.push(encoder.encode(text)); };

  for (var e = 0; e < entries.length; e++) {
    var entry = entries[e];
    addStr("--" + boundary + "\r\n");
    if (entry.kind === "blob") {
      var disposition = 'Content-Disposition: form-data; name="' + entry.name + '"';
      if (entry.filename) disposition += '; filename="' + entry.filename + '"';
      addStr(disposition + "\r\n");
      var contentType = blobType(entry.value);
      if (contentType) addStr("Content-Type: " + contentType + "\r\n");
      addStr("\r\n");
      chunks.push(blobBytes(entry.value));
      addStr("\r\n");
    } else {
      addStr('Content-Disposition: form-data; name="' + entry.name + '"\r\n\r\n');
      addStr(entry.value);
      addStr("\r\n");
    }
  }
  addStr("--" + boundary + "--\r\n");

  var total = 0;
  for (var c = 0; c < chunks.length; c++) total += chunks[c].length;
  var out = new Uint8Array(total);
  var offset = 0;
  for (var d = 0; d < chunks.length; d++) {
    out.set(chunks[d], offset);
    offset += chunks[d].length;
  }
  return { bytes: out, contentType: "multipart/form-data; boundary=" + boundary };
};

globalThis.FormData = FormData;
`;
