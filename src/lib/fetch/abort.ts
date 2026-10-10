export const ABORT = String.raw`
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

globalThis.AbortController = AbortController;
globalThis.AbortSignal = AbortSignal;
`;