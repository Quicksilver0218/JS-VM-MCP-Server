import { Buffer } from 'buffer';
import ivm from 'isolated-vm';

// ---------------------------------------------------------------------------
// Shared Memory & Unified Wire Protocol Constants
// ---------------------------------------------------------------------------
const CTRL_G2H_CURSOR = 0;
const SLOTS_OFFSET = 8; // Int32 index where per-call slots begin
const SLOT_STRIDE = 6; // Int32s per slot: [kind, a, b, c, mutatedMask, flags]
const MAX_GUEST_SLOTS = 128; // Slots 0..127 owned by Guest -> Host calls
const MAX_HOST_SLOTS = 64; // Slots 128..191 owned by Host -> Guest calls

const S_KIND = 0;
const S_A = 1;
const S_B = 2;
const S_C = 3;
const S_MUTATED = 4;
const S_FLAGS = 5;

const HEADER_SIZE = 8192; // 2048 Int32s (covers 192 slots * 6 + control fields)
const G2H_BASE = HEADER_SIZE;
const G2H_SIZE = 1024 * 1024; // 1 MB: Guest -> Host binary args & sync write-back
const H2G_BASE = G2H_BASE + G2H_SIZE;
const H2G_RET_SIZE = 256 * 1024; // 256 KB ring: Host -> Guest sync return binaries
const H2G_PUSH_SIZE = 256 * 1024; // 256 KB stack: Host -> Guest settle/expose/push binaries
const H2G_SIZE = H2G_RET_SIZE + H2G_PUSH_SIZE;
const TOTAL_SAB_SIZE = H2G_BASE + H2G_SIZE;

// Unified transport tags
const T_DIRECT = 0;
const T_BIGINT = 1;
const T_HOST_OBJ = 2;
const T_HOST_BOUND = 3;
const T_GUEST_OBJ = 4;
const T_PROMISE = 5;
const T_UNWRAP_PROMISE = 6;
const T_BIN_SLAB = 7;
const T_BIN_COPY = 8;
const T_SAME_ARG = 9;
const T_SYM_WK = 10;
const T_SYM_FOR = 11;
const T_SYM_REF = 12;
const T_PLAIN_COPY = 13;
const T_ERROR = 14;

// Property key tags & Proxy trap opcodes
const P_STR = 0;
const P_SYM_WK = 1;
const P_SYM_FOR = 2;
const P_SYM_REF = 3;

const OP_GET = 0;
const OP_SET = 1;
const OP_HAS = 2;
const OP_DELETE = 3;
const OP_OWN_KEYS = 4;
const OP_GET_DESC = 5;
const OP_DEFINE = 6;

// Flags & Descriptor bitmasks
const FLAG_FUNC = 1;
const FLAG_ARRAY = 2;
const CACHE_IMMUTABLE = 1;
const CACHE_PROTO_FN = 2;

const DESC_WRITABLE = 1;
const DESC_ENUMERABLE = 2;
const DESC_CONFIGURABLE = 4;
const DESC_HAS_VALUE = 8;
const DESC_HAS_GET = 16;
const DESC_HAS_SET = 32;

const HOST_OPS = ['call', 'fallback', 'prop', 'settle', 'release'] as const;
const GUEST_OPS = ['expose', 'settle', 'call', 'prop', 'release'] as const;

const WELL_KNOWN_SYMBOL_NAMES = [
  'iterator', 'asyncIterator', 'hasInstance', 'isConcatSpreadable',
  'match', 'matchAll', 'replace', 'search', 'species', 'split',
  'toPrimitive', 'toStringTag', 'unscopables', 'dispose', 'asyncDispose',
] as const;

const symbolRecord = Symbol as unknown as Record<string, symbol | undefined>;
const HOST_WK_SYMBOLS: readonly (symbol | undefined)[] = WELL_KNOWN_SYMBOL_NAMES.map(
  (name) => symbolRecord[name],
);
const HOST_WK_SYM_TO_IDX = new Map<symbol, number>();
HOST_WK_SYMBOLS.forEach((sym, i) => {
  if (typeof sym === 'symbol') HOST_WK_SYM_TO_IDX.set(sym, i);
});

type BinViewCtor = new (ab: ArrayBuffer) => ArrayBufferView;
const globalRecord = globalThis as unknown as Record<string, unknown>;
const Float16Ctor: BinViewCtor | undefined =
  typeof globalRecord.Float16Array === 'function'
    ? (globalRecord.Float16Array as BinViewCtor)
    : undefined;

const BIN_VIEW_CTORS: readonly (BinViewCtor | undefined)[] = [
  undefined, Uint8Array, Int8Array, Uint8ClampedArray,
  Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
  DataView, Float16Ctor,
];

const ERROR_CTORS = new Map<string, ErrorConstructor>([
  ['Error', Error], ['TypeError', TypeError], ['RangeError', RangeError],
  ['SyntaxError', SyntaxError], ['ReferenceError', ReferenceError],
  ['URIError', URIError], ['EvalError', EvalError],
]);

// ---------------------------------------------------------------------------
// Strict Types
// ---------------------------------------------------------------------------
type HostOp = (typeof HOST_OPS)[number];
type GuestOp = (typeof GUEST_OPS)[number];
type RefKey = `h:${HostOp}` | `g:${GuestOp}`;
type PropKey = string | symbol;
type EncodedPropVal = string | number;
type WireValue = ivm.Transferable;
type GuestFn = (this: undefined, ...args: ivm.Transferable[]) => unknown;
type BridgeRef = ivm.Reference<object> | ivm.Reference<GuestFn>;
type AnyCallable = (...args: unknown[]) => unknown;

interface BoundHostMeta {
  fnId: number;
  receiverId: number;
}

interface PendingHostPromise {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  promise: Promise<unknown>;
}

interface EarlySettlement {
  isRejected: boolean;
  value: unknown;
}

interface TrackedSlabBin {
  argIndex: number;
  hostArg: ArrayBuffer | ArrayBufferView;
  hostBuf: Buffer;
  hostU8: Uint8Array;
  off: number;
  len: number;
}

interface PackedFallbackArg {
  k: number;
  a?: number | undefined;
  b?: number | undefined;
  v?: unknown;
}

// ---------------------------------------------------------------------------
// Host Utility Helpers
// ---------------------------------------------------------------------------
function isObjectLike(val: unknown): val is object {
  return val !== null && (typeof val === 'object' || typeof val === 'function');
}

function getBinTypeCode(val: unknown): number {
  if (val instanceof Uint8Array) return 1;
  if (val instanceof ArrayBuffer) return 0;
  if (!ArrayBuffer.isView(val)) return -1;
  for (let i = 2; i < BIN_VIEW_CTORS.length; i++) {
    const Ctor = BIN_VIEW_CTORS[i];
    if (Ctor !== undefined && val instanceof Ctor) return i;
  }
  return -1;
}

function allocFastArrayBuffer(byteLength: number): ArrayBuffer {
  if (byteLength === 0) return new ArrayBuffer(0);
  const buf = Buffer.allocUnsafeSlow(byteLength);
  if (
    buf.byteOffset === 0 &&
    buf.buffer instanceof ArrayBuffer &&
    buf.buffer.byteLength === byteLength
  ) {
    return buf.buffer;
  }
  return new ArrayBuffer(byteLength);
}

function wrapArrayBuffer(typeCode: number, ab: ArrayBuffer): ArrayBuffer | ArrayBufferView {
  if (typeCode === 0) return ab;
  const Ctor = BIN_VIEW_CTORS[typeCode];
  return Ctor !== undefined ? new Ctor(ab) : new Uint8Array(ab);
}

function asUint8View(val: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (val instanceof Uint8Array && !Buffer.isBuffer(val)) return val;
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
}

function isThenable(val: unknown): val is PromiseLike<unknown> {
  if (!isObjectLike(val)) return false;
  if (val instanceof Promise) return true;
  try {
    return typeof (val as { then?: unknown }).then === 'function';
  } catch {
    return false;
  }
}

function encodeErrorString(err: unknown): string {
  return err instanceof Error
    ? `${err.name || 'Error'}\0${err.message || ''}\0${err.stack || ''}`
    : `Error\0${String(err)}\0`;
}

function decodeErrorString(encoded: string): Error {
  const i1 = encoded.indexOf('\0');
  const i2 = i1 >= 0 ? encoded.indexOf('\0', i1 + 1) : -1;
  const name = i1 >= 0 ? encoded.slice(0, i1) : 'Error';
  const msg = i1 >= 0 && i2 >= 0 ? encoded.slice(i1 + 1, i2) : encoded;
  const stack = i2 >= 0 ? encoded.slice(i2 + 1) : '';
  const Ctor = ERROR_CTORS.get(name) ?? Error;
  const err = new Ctor(msg);
  if (!ERROR_CTORS.has(name)) err.name = name;
  if (stack) err.stack = stack;
  return err;
}

// ---------------------------------------------------------------------------
// Guest Isolate Runtime (Zero globalThis Pollution)
// ---------------------------------------------------------------------------
function buildGuestBootstrapCode(): string {
  return `(function initIvmBridge(sab, hCall, hFallback, hProp, hSettle, hRelease) {
  'use strict';

  const CTRL_G2H_CURSOR = ${CTRL_G2H_CURSOR};
  const SLOTS_OFFSET = ${SLOTS_OFFSET}, SLOT_STRIDE = ${SLOT_STRIDE};
  const S_KIND = ${S_KIND}, S_A = ${S_A}, S_B = ${S_B}, S_C = ${S_C}, S_MUTATED = ${S_MUTATED}, S_FLAGS = ${S_FLAGS};
  const MAX_GUEST_SLOTS = ${MAX_GUEST_SLOTS};

  const G2H_BASE = ${G2H_BASE}, G2H_SIZE = ${G2H_SIZE};
  const H2G_BASE = ${H2G_BASE}, H2G_SIZE = ${H2G_SIZE};

  const T_DIRECT = ${T_DIRECT}, T_BIGINT = ${T_BIGINT}, T_HOST_OBJ = ${T_HOST_OBJ};
  const T_HOST_BOUND = ${T_HOST_BOUND}, T_GUEST_OBJ = ${T_GUEST_OBJ}, T_PROMISE = ${T_PROMISE};
  const T_UNWRAP_PROMISE = ${T_UNWRAP_PROMISE}, T_BIN_SLAB = ${T_BIN_SLAB}, T_BIN_COPY = ${T_BIN_COPY};
  const T_SAME_ARG = ${T_SAME_ARG}, T_SYM_WK = ${T_SYM_WK}, T_SYM_FOR = ${T_SYM_FOR};
  const T_SYM_REF = ${T_SYM_REF}, T_PLAIN_COPY = ${T_PLAIN_COPY}, T_ERROR = ${T_ERROR};

  const P_STR = ${P_STR}, P_SYM_WK = ${P_SYM_WK}, P_SYM_FOR = ${P_SYM_FOR}, P_SYM_REF = ${P_SYM_REF};
  const OP_GET = ${OP_GET}, OP_SET = ${OP_SET}, OP_HAS = ${OP_HAS}, OP_DELETE = ${OP_DELETE};
  const OP_OWN_KEYS = ${OP_OWN_KEYS}, OP_GET_DESC = ${OP_GET_DESC}, OP_DEFINE = ${OP_DEFINE};
  const FLAG_FUNC = ${FLAG_FUNC}, FLAG_ARRAY = ${FLAG_ARRAY};
  const DESC_WRITABLE = ${DESC_WRITABLE}, DESC_ENUMERABLE = ${DESC_ENUMERABLE}, DESC_CONFIGURABLE = ${DESC_CONFIGURABLE};
  const DESC_HAS_VALUE = ${DESC_HAS_VALUE}, DESC_HAS_GET = ${DESC_HAS_GET}, DESC_HAS_SET = ${DESC_HAS_SET};

  const ctrl = new Int32Array(sab, 0, ${HEADER_SIZE >>> 2});
  const g2hU8 = new Uint8Array(sab, G2H_BASE, G2H_SIZE);
  const h2gU8 = new Uint8Array(sab, H2G_BASE, H2G_SIZE);

  // Per-call slot pool (prevents interleaved settle/microtask calls from clobbering return slots)
  const freeSlots = [];
  for (let i = MAX_GUEST_SLOTS - 1; i >= 0; i--) freeSlots.push(i);
  function allocSlot() {
    const slot = freeSlots.pop();
    if (slot === undefined) throw new RangeError('Bridge call nesting limit exceeded');
    return slot;
  }

  const WK_SYMS = ${JSON.stringify(WELL_KNOWN_SYMBOL_NAMES)}.map(n => Symbol[n]);
  const WK_SYM_TO_IDX = new Map();
  WK_SYMS.forEach((s, i) => { if (typeof s === 'symbol') WK_SYM_TO_IDX.set(s, i); });

  const BIN_CTORS = [
    undefined, Uint8Array, Int8Array, Uint8ClampedArray,
    Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, BigInt64Array, BigUint64Array,
    DataView, typeof Float16Array !== 'undefined' ? Float16Array : undefined,
  ];
  const ERR_CTORS = new Map([
    ['Error', Error], ['TypeError', TypeError], ['RangeError', RangeError],
    ['SyntaxError', SyntaxError], ['ReferenceError', ReferenceError],
    ['URIError', URIError], ['EvalError', EvalError],
  ]);

  const hostIdToProxy = new Map();
  const hostProxyMeta = new WeakMap();
  const boundProxyCache = new Map();

  let nextGuestId = 1;
  const guestIdToTarget = new Map();
  const guestTargetToId = new WeakMap();

  let nextGuestSymId = -1;
  const symIdToSym = new Map();
  const symToSymId = new Map();

  const pendingFromHost = new Map();
  const earlyFromHost = new Map();
  let nextGuestPid = 1;
  const activeGuestPromises = new Map();

  const releasedHostIds = [];
  const hostFinalizer = new FinalizationRegistry((hostId) => {
    const ref = hostIdToProxy.get(hostId);
    if (ref && ref.deref() !== undefined) return;
    hostIdToProxy.delete(hostId);
    releasedHostIds.push(hostId);
    if (releasedHostIds.length >= 256) {
      try { hRelease.applySync(undefined, releasedHostIds.splice(0, releasedHostIds.length)); } catch {}
    }
  });
  const boundFinalizer = new FinalizationRegistry((key) => {
    const ref = boundProxyCache.get(key);
    if (ref && ref.deref() === undefined) boundProxyCache.delete(key);
  });

  function getBinTypeCode(val) {
    if (val instanceof Uint8Array) return 1;
    if (val instanceof ArrayBuffer) return 0;
    if (!ArrayBuffer.isView(val)) return -1;
    for (let i = 2; i < BIN_CTORS.length; i++) {
      const C = BIN_CTORS[i];
      if (C !== undefined && val instanceof C) return i;
    }
    return -1;
  }

  function wrapArrayBuffer(typeCode, ab) {
    if (typeCode === 0) return ab;
    const C = BIN_CTORS[typeCode];
    return C !== undefined ? new C(ab) : new Uint8Array(ab);
  }

  function asU8(val) {
    if (val instanceof Uint8Array) return val;
    if (val instanceof ArrayBuffer) return new Uint8Array(val);
    return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
  }

  function writeBinToTarget(target, srcU8) {
    if (target instanceof Uint8Array) target.set(srcU8);
    else if (target instanceof ArrayBuffer) new Uint8Array(target).set(srcU8);
    else new Uint8Array(target.buffer, target.byteOffset, srcU8.byteLength).set(srcU8);
  }

  function readBinFromH2g(typeCode, off, len) {
    const copy = h2gU8.slice(off, off + len);
    return typeCode === 1 ? copy : wrapArrayBuffer(typeCode, copy.buffer);
  }

  function isThenable(val) {
    if (val === null || (typeof val !== 'object' && typeof val !== 'function')) return false;
    if (val instanceof Promise) return true;
    try { return typeof val.then === 'function'; } catch { return false; }
  }

  function encodeErrorStr(err) {
    return err instanceof Error
      ? (err.name || 'Error') + '\\0' + (err.message || '') + '\\0' + (err.stack || '')
      : 'Error\\0' + String(err) + '\\0';
  }

  function decodeErrorStr(encoded) {
    const i1 = encoded.indexOf('\\0');
    const i2 = i1 >= 0 ? encoded.indexOf('\\0', i1 + 1) : -1;
    const name = i1 >= 0 ? encoded.slice(0, i1) : 'Error';
    const msg = i1 >= 0 && i2 >= 0 ? encoded.slice(i1 + 1, i2) : encoded;
    const stack = i2 >= 0 ? encoded.slice(i2 + 1) : '';
    const Ctor = ERR_CTORS.get(name) || Error;
    const err = new Ctor(msg);
    if (!ERR_CTORS.has(name)) err.name = name;
    if (stack) err.stack = stack;
    return err;
  }

  function registerGuestObj(obj) {
    let id = guestTargetToId.get(obj);
    if (id !== undefined) return id;
    id = nextGuestId++;
    guestTargetToId.set(obj, id);
    guestIdToTarget.set(id, obj);
    return id;
  }

  function getObjFlags(val) {
    return typeof val === 'function' ? FLAG_FUNC : (Array.isArray(val) ? FLAG_ARRAY : 0);
  }

  function getOrCreateGuestSym(symId, desc) {
    let s = symIdToSym.get(symId);
    if (s !== undefined) return s;
    s = Symbol(desc);
    symIdToSym.set(symId, s);
    symToSymId.set(s, symId);
    return s;
  }

  function getOrCreateSymId(sym) {
    let id = symToSymId.get(sym);
    if (id !== undefined) return id;
    id = nextGuestSymId--;
    symToSymId.set(sym, id);
    symIdToSym.set(id, sym);
    return id;
  }

  function encodePropKey(prop) {
    if (typeof prop === 'string') return [P_STR, prop];
    const wk = WK_SYM_TO_IDX.get(prop);
    if (wk !== undefined) return [P_SYM_WK, wk];
    const fk = Symbol.keyFor(prop);
    if (fk !== undefined) return [P_SYM_FOR, fk];
    return [P_SYM_REF, getOrCreateSymId(prop), prop.description];
  }

  function decodePropKey(pKind, pVal, pDesc) {
    if (pKind === P_STR) return pVal;
    if (pKind === P_SYM_WK) return WK_SYMS[pVal];
    if (pKind === P_SYM_FOR) return Symbol.for(pVal);
    return getOrCreateGuestSym(pVal, pDesc);
  }

  function registerGuestPromise(promise) {
    const gpid = nextGuestPid++;
    activeGuestPromises.set(gpid, promise);
    Promise.resolve(promise).then(
      (val) => {
        activeGuestPromises.delete(gpid);
        settleHostFromGuest(gpid, false, val);
      },
      (err) => {
        activeGuestPromises.delete(gpid);
        settleHostFromGuest(gpid, true, err);
      }
    );
    return gpid;
  }

  function createPendingHostPromise(hostPid) {
    const early = earlyFromHost.get(hostPid);
    if (early !== undefined) {
      earlyFromHost.delete(hostPid);
      return early.isRejected ? Promise.reject(early.val) : Promise.resolve(early.val);
    }
    return new Promise((resolve, reject) => pendingFromHost.set(hostPid, { resolve, reject }));
  }

  function decodeValue(kind, a, b, c, raw) {
    if (kind === T_DIRECT || kind === T_PLAIN_COPY) return raw;
    switch (kind) {
      case T_BIN_SLAB: return readBinFromH2g(a, b, c);
      case T_BIN_COPY:
        return a === 1 && raw instanceof Uint8Array
          ? raw
          : wrapArrayBuffer(a, raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      case T_HOST_OBJ: return getOrCreateHostProxy(a, b);
      case T_HOST_BOUND: return getOrCreateBoundProxy(a, b);
      case T_GUEST_OBJ: return guestIdToTarget.get(a);
      case T_PROMISE: return createPendingHostPromise(a);
      case T_UNWRAP_PROMISE: return activeGuestPromises.get(a);
      case T_BIGINT: return BigInt(raw);
      case T_SYM_WK: return WK_SYMS[a];
      case T_SYM_FOR: return Symbol.for(raw);
      case T_SYM_REF: return getOrCreateGuestSym(a, raw);
      case T_ERROR: throw decodeErrorStr(raw);
      default: return raw;
    }
  }

  function decodeSlotReturn(slot, raw, origArgs) {
    const base = SLOTS_OFFSET + slot * SLOT_STRIDE;
    const kind = ctrl[base + S_KIND];
    if (kind === T_DIRECT) return raw;
    if (kind === T_SAME_ARG) return origArgs[ctrl[base + S_A]];
    return decodeValue(kind, ctrl[base + S_A], ctrl[base + S_B], ctrl[base + S_C], raw);
  }

  function encodeToSlot(slot, val, allowBinCopy) {
    const base = SLOTS_OFFSET + slot * SLOT_STRIDE;
    const t = typeof val;
    if (val === null || val === undefined || t === 'boolean' || t === 'number' || t === 'string') {
      ctrl[base + S_KIND] = T_DIRECT;
      return val;
    }
    if (t === 'bigint') {
      ctrl[base + S_KIND] = T_BIGINT;
      return val.toString();
    }
    if (t === 'symbol') {
      const wk = WK_SYM_TO_IDX.get(val);
      if (wk !== undefined) { ctrl[base + S_KIND] = T_SYM_WK; ctrl[base + S_A] = wk; return undefined; }
      const fk = Symbol.keyFor(val);
      if (fk !== undefined) { ctrl[base + S_KIND] = T_SYM_FOR; return fk; }
      ctrl[base + S_KIND] = T_SYM_REF;
      ctrl[base + S_A] = getOrCreateSymId(val);
      return val.description;
    }
    const hMeta = hostProxyMeta.get(val);
    if (hMeta !== undefined) {
      ctrl[base + S_KIND] = hMeta.boundThisId !== 0 ? T_HOST_BOUND : T_HOST_OBJ;
      ctrl[base + S_A] = hMeta.id;
      ctrl[base + S_B] = hMeta.boundThisId;
      return undefined;
    }
    const binType = getBinTypeCode(val);
    if (binType >= 0) {
      const len = val.byteLength;
      const off = (ctrl[CTRL_G2H_CURSOR] + 7) & ~7;
      if (off + len <= G2H_SIZE) {
        if (len > 0) g2hU8.set(asU8(val), off);
        ctrl[base + S_KIND] = T_BIN_SLAB;
        ctrl[base + S_A] = binType;
        ctrl[base + S_B] = off;
        ctrl[base + S_C] = len;
        return undefined;
      }
      if (allowBinCopy) {
        ctrl[base + S_KIND] = T_BIN_COPY;
        ctrl[base + S_A] = binType;
        ctrl[base + S_B] = 0;
        ctrl[base + S_C] = len;
        return asU8(val);
      }
    }
    if (isThenable(val)) {
      ctrl[base + S_KIND] = T_PROMISE;
      ctrl[base + S_A] = registerGuestPromise(val);
      return undefined;
    }
    ctrl[base + S_KIND] = T_GUEST_OBJ;
    ctrl[base + S_A] = registerGuestObj(val);
    ctrl[base + S_B] = getObjFlags(val);
    return undefined;
  }

  function settleHostFromGuest(gpid, isRej, val) {
    if (isRej) {
      try { hSettle.applySync(undefined, [gpid, 1, T_ERROR, 0, 0, 0, encodeErrorStr(val)]); } catch {}
      return;
    }
    const slot = allocSlot();
    const base = SLOTS_OFFSET + slot * SLOT_STRIDE;
    const saved = ctrl[CTRL_G2H_CURSOR];
    try {
      const raw = encodeToSlot(slot, val, true);
      const kind = ctrl[base + S_KIND], a = ctrl[base + S_A], b = ctrl[base + S_B], c = ctrl[base + S_C];
      if (kind === T_BIN_SLAB) ctrl[CTRL_G2H_CURSOR] = b + c;
      if (kind === T_BIN_COPY) {
        hSettle.applySync(undefined, [gpid, 0, kind, a, 0, c, raw], { arguments: { copy: true } });
      } else {
        hSettle.applySync(undefined, [gpid, 0, kind, a, b, c, raw]);
      }
    } catch {
    } finally {
      ctrl[CTRL_G2H_CURSOR] = saved;
      freeSlots.push(slot);
    }
  }

  function encodeSingleArgForHost(val) {
    const t = typeof val;
    if (val === null || val === undefined || t === 'boolean' || t === 'number' || t === 'string') {
      return [T_DIRECT, val];
    }
    if (t === 'bigint') return [T_BIGINT, val.toString()];
    if (t === 'symbol') {
      const wk = WK_SYM_TO_IDX.get(val);
      if (wk !== undefined) return [T_SYM_WK, wk];
      const fk = Symbol.keyFor(val);
      return fk !== undefined ? [T_SYM_FOR, fk] : [T_SYM_REF, getOrCreateSymId(val), val.description];
    }
    const hMeta = hostProxyMeta.get(val);
    if (hMeta !== undefined) {
      return hMeta.boundThisId !== 0 ? [T_HOST_BOUND, hMeta.id, hMeta.boundThisId] : [T_HOST_OBJ, hMeta.id];
    }
    const binType = getBinTypeCode(val);
    if (binType >= 0) {
      const len = val.byteLength;
      const saved = ctrl[CTRL_G2H_CURSOR];
      const off = (saved + 7) & ~7;
      if (off + len <= G2H_SIZE) {
        if (len > 0) g2hU8.set(asU8(val), off);
        return [T_BIN_SLAB, (off << 4) | binType, len, saved];
      }
    }
    if (isThenable(val)) return [T_PROMISE, registerGuestPromise(val)];
    return [T_GUEST_OBJ, registerGuestObj(val), getObjFlags(val)];
  }

  function invokeHost(isConstruct, fnId, thisId, args) {
    const argc = args.length;
    const savedCursor = ctrl[CTRL_G2H_CURSOR];
    let cursor = savedCursor;
    let slabBins = null;
    let needFallback = false;

    const slot = allocSlot();
    const wire = [(slot << 1) | (isConstruct ? 1 : 0), fnId, thisId, argc];

    for (let i = 0; i < argc; i++) {
      const arg = args[i];
      const t = typeof arg;
      if (arg === null || arg === undefined || t === 'boolean' || t === 'number' || t === 'string') {
        wire.push(T_DIRECT, arg);
      } else if (t === 'bigint') {
        wire.push(T_BIGINT, arg.toString());
      } else if (t === 'symbol') {
        const wk = WK_SYM_TO_IDX.get(arg);
        if (wk !== undefined) wire.push(T_SYM_WK, wk);
        else {
          const fk = Symbol.keyFor(arg);
          if (fk !== undefined) wire.push(T_SYM_FOR, fk);
          else wire.push(T_SYM_REF, getOrCreateSymId(arg), arg.description);
        }
      } else {
        const hMeta = hostProxyMeta.get(arg);
        if (hMeta !== undefined) {
          if (hMeta.boundThisId !== 0) wire.push(T_HOST_BOUND, hMeta.id, hMeta.boundThisId);
          else wire.push(T_HOST_OBJ, hMeta.id);
        } else {
          const binType = getBinTypeCode(arg);
          if (binType >= 0) {
            const len = arg.byteLength;
            const off = (cursor + 7) & ~7;
            if (i < 31 && off + len <= G2H_SIZE) {
              if (len > 0) g2hU8.set(asU8(arg), off);
              cursor = off + len;
              wire.push(T_BIN_SLAB, (off << 4) | binType, len);
              if (slabBins === null) slabBins = [];
              slabBins.push(i, arg, off, len);
            } else {
              needFallback = true;
              break;
            }
          } else if (isThenable(arg)) {
            wire.push(T_PROMISE, registerGuestPromise(arg));
          } else {
            wire.push(T_GUEST_OBJ, registerGuestObj(arg), getObjFlags(arg));
          }
        }
      }
    }

    if (needFallback) {
      ctrl[CTRL_G2H_CURSOR] = savedCursor;
      try {
        return invokeHostFallback(slot, isConstruct, fnId, thisId, args);
      } finally {
        freeSlots.push(slot);
      }
    }

    ctrl[CTRL_G2H_CURSOR] = cursor;
    try {
      const raw = hCall.applySync(undefined, wire);
      if (slabBins !== null) {
        const mask = ctrl[SLOTS_OFFSET + slot * SLOT_STRIDE + S_MUTATED];
        if (mask !== 0) {
          for (let j = 0; j < slabBins.length; j += 4) {
            if ((mask & (1 << slabBins[j])) !== 0) {
              writeBinToTarget(slabBins[j + 1], g2hU8.subarray(slabBins[j + 2], slabBins[j + 2] + slabBins[j + 3]));
            }
          }
        }
      }
      return decodeSlotReturn(slot, raw, args);
    } finally {
      ctrl[CTRL_G2H_CURSOR] = savedCursor;
      freeSlots.push(slot);
    }
  }

  function invokeHostFallback(slot, isConstruct, fnId, thisId, args) {
    const packed = [];
    let hasBins = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const t = typeof arg;
      if (arg === null || arg === undefined || t === 'boolean' || t === 'number' || t === 'string') {
        packed.push({ k: T_DIRECT, v: arg });
      } else if (t === 'bigint') {
        packed.push({ k: T_BIGINT, v: arg.toString() });
      } else if (t === 'symbol') {
        const wk = WK_SYM_TO_IDX.get(arg);
        if (wk !== undefined) packed.push({ k: T_SYM_WK, a: wk });
        else {
          const fk = Symbol.keyFor(arg);
          packed.push(fk !== undefined ? { k: T_SYM_FOR, v: fk } : { k: T_SYM_REF, a: getOrCreateSymId(arg), v: arg.description });
        }
      } else {
        const hMeta = hostProxyMeta.get(arg);
        if (hMeta !== undefined) {
          packed.push(hMeta.boundThisId !== 0 ? { k: T_HOST_BOUND, a: hMeta.id, b: hMeta.boundThisId } : { k: T_HOST_OBJ, a: hMeta.id });
        } else {
          const binType = getBinTypeCode(arg);
          if (binType >= 0) {
            packed.push({ k: T_BIN_COPY, a: binType, v: asU8(arg) });
            hasBins = true;
          } else if (isThenable(arg)) {
            packed.push({ k: T_PROMISE, a: registerGuestPromise(arg) });
          } else {
            packed.push({ k: T_GUEST_OBJ, a: registerGuestObj(arg), b: getObjFlags(arg) });
          }
        }
      }
    }
    const res = hFallback.applySync(undefined, [(slot << 1) | (isConstruct ? 1 : 0), fnId, thisId, packed], { arguments: { copy: true } });
    if (hasBins && res && res.__wb) {
      for (let j = 0; j < res.__wb.length; j += 2) {
        writeBinToTarget(args[res.__wb[j]], res.__wb[j + 1]);
      }
      return decodeSlotReturn(slot, res.__ret, args);
    }
    return decodeSlotReturn(slot, res, args);
  }

  function resolveThisId(thisArg, boundThisId) {
    if (thisArg === undefined || thisArg === null || thisArg === globalThis) return boundThisId;
    const meta = hostProxyMeta.get(thisArg);
    if (meta !== undefined) return meta.id;
    return (typeof thisArg === 'object' || typeof thisArg === 'function') ? -registerGuestObj(thisArg) : boundThisId;
  }

  function makeHostProxyHandler(hostId, boundThisId) {
    let propCache = null;

    return {
      get(_t, prop) {
        if (propCache !== null) {
          const cached = propCache.get(prop);
          if (cached !== undefined) return cached;
        }
        const slot = allocSlot();
        const opWord = (slot << 4) | OP_GET;
        try {
          const raw = typeof prop === 'string'
            ? hProp.applySync(undefined, [opWord, hostId, P_STR, prop])
            : (() => { const pk = encodePropKey(prop); return hProp.applySync(undefined, [opWord, hostId, pk[0], pk[1], pk[2]]); })();
          const cacheFlags = ctrl[SLOTS_OFFSET + slot * SLOT_STRIDE + S_FLAGS];
          const val = decodeSlotReturn(slot, raw, null);
          if (cacheFlags !== 0 && val !== undefined) {
            if (propCache === null) propCache = new Map();
            propCache.set(prop, val);
          }
          return val;
        } finally {
          freeSlots.push(slot);
        }
      },

      set(_t, prop, value) {
        if (propCache !== null) propCache.delete(prop);
        const slot = allocSlot();
        const pk = encodePropKey(prop);
        const enc = encodeSingleArgForHost(value);
        const saved = enc[0] === T_BIN_SLAB ? enc[3] : -1;
        if (saved >= 0) ctrl[CTRL_G2H_CURSOR] = ((saved + 7) & ~7) + enc[2];
        try {
          const ok = hProp.applySync(undefined, [(slot << 4) | OP_SET, hostId, pk[0], pk[1], pk[2], enc[0], enc[1], enc[2]]);
          if (ctrl[SLOTS_OFFSET + slot * SLOT_STRIDE + S_KIND] === T_ERROR) throw decodeErrorStr(ok);
          return Boolean(ok);
        } finally {
          if (saved >= 0) ctrl[CTRL_G2H_CURSOR] = saved;
          freeSlots.push(slot);
        }
      },

      has(_t, prop) {
        const pk = encodePropKey(prop);
        return Boolean(hProp.applySync(undefined, [OP_HAS, hostId, pk[0], pk[1], pk[2]]));
      },

      deleteProperty(_t, prop) {
        if (propCache !== null) propCache.delete(prop);
        const pk = encodePropKey(prop);
        return Boolean(hProp.applySync(undefined, [OP_DELETE, hostId, pk[0], pk[1], pk[2]]));
      },

      ownKeys(target) {
        const flat = hProp.applySync(undefined, [OP_OWN_KEYS, hostId]);
        const keys = [];
        const seen = new Set();
        for (let i = 0; i < flat.length; i += 2) {
          const k = decodePropKey(flat[i], flat[i + 1], undefined);
          if (k !== undefined && !seen.has(k)) { seen.add(k); keys.push(k); }
        }
        for (const tk of Reflect.ownKeys(target)) {
          if (!seen.has(tk)) {
            const td = Reflect.getOwnPropertyDescriptor(target, tk);
            if (td && !td.configurable) keys.push(tk);
          }
        }
        return keys;
      },

      getOwnPropertyDescriptor(target, prop) {
        const slot = allocSlot();
        const pk = encodePropKey(prop);
        try {
          const raw = hProp.applySync(undefined, [(slot << 4) | OP_GET_DESC, hostId, pk[0], pk[1], pk[2]]);
          const mask = ctrl[SLOTS_OFFSET + slot * SLOT_STRIDE + S_FLAGS];
          const td = Reflect.getOwnPropertyDescriptor(target, prop);
          if (mask < 0) return td && !td.configurable ? td : undefined;
          const mustNonConfig = Boolean(td && !td.configurable);
          const desc = { enumerable: (mask & DESC_ENUMERABLE) !== 0, configurable: !mustNonConfig };
          if ((mask & DESC_HAS_VALUE) !== 0) {
            desc.value = decodeSlotReturn(slot, raw, null);
            desc.writable = mustNonConfig && td ? Boolean(td.writable) : (mask & DESC_WRITABLE) !== 0;
          } else {
            if ((mask & DESC_HAS_GET) !== 0) {
              desc.get = () => {
                const gs = allocSlot();
                try {
                  return decodeSlotReturn(gs, hProp.applySync(undefined, [(gs << 4) | OP_GET, hostId, pk[0], pk[1], pk[2]]), null);
                } finally {
                  freeSlots.push(gs);
                }
              };
            }
            if ((mask & DESC_HAS_SET) !== 0) {
              desc.set = (v) => {
                const ss = allocSlot();
                const enc = encodeSingleArgForHost(v);
                const saved = enc[0] === T_BIN_SLAB ? enc[3] : -1;
                if (saved >= 0) ctrl[CTRL_G2H_CURSOR] = ((saved + 7) & ~7) + enc[2];
                try {
                  const ok = hProp.applySync(undefined, [(ss << 4) | OP_SET, hostId, pk[0], pk[1], pk[2], enc[0], enc[1], enc[2]]);
                  if (ctrl[SLOTS_OFFSET + ss * SLOT_STRIDE + S_KIND] === T_ERROR) throw decodeErrorStr(ok);
                } finally {
                  if (saved >= 0) ctrl[CTRL_G2H_CURSOR] = saved;
                  freeSlots.push(ss);
                }
              };
            }
          }
          return desc;
        } finally {
          freeSlots.push(slot);
        }
      },

      defineProperty(_t, prop, descriptor) {
        if (propCache !== null) propCache.delete(prop);
        const pk = encodePropKey(prop);
        let mask = (descriptor.writable ? DESC_WRITABLE : 0)
          | (descriptor.enumerable ? DESC_ENUMERABLE : 0)
          | (descriptor.configurable ? DESC_CONFIGURABLE : 0);
        let enc = [T_DIRECT, undefined, 0];
        if ('value' in descriptor) { mask |= DESC_HAS_VALUE; enc = encodeSingleArgForHost(descriptor.value); }
        const saved = enc[0] === T_BIN_SLAB ? enc[3] : -1;
        if (saved >= 0) ctrl[CTRL_G2H_CURSOR] = ((saved + 7) & ~7) + enc[2];
        try {
          return Boolean(hProp.applySync(undefined, [OP_DEFINE, hostId, pk[0], pk[1], pk[2], mask, enc[0], enc[1], enc[2]]));
        } finally {
          if (saved >= 0) ctrl[CTRL_G2H_CURSOR] = saved;
        }
      },

      apply(_t, thisArg, argList) { return invokeHost(false, hostId, resolveThisId(thisArg, boundThisId), argList); },
      construct(_t, argList) { return invokeHost(true, hostId, 0, argList); },
    };
  }

  function getOrCreateHostProxy(hostId, flags) {
    const existing = hostIdToProxy.get(hostId)?.deref();
    if (existing !== undefined) return existing;
    const target = (flags & FLAG_FUNC) !== 0 ? function () {} : ((flags & FLAG_ARRAY) !== 0 ? [] : {});
    const proxy = new Proxy(target, makeHostProxyHandler(hostId, 0));
    hostIdToProxy.set(hostId, new WeakRef(proxy));
    hostProxyMeta.set(proxy, { id: hostId, boundThisId: 0 });
    hostFinalizer.register(proxy, hostId);
    return proxy;
  }

  function getOrCreateBoundProxy(fnHostId, receiverHostId) {
    if (receiverHostId === 0) return getOrCreateHostProxy(fnHostId, FLAG_FUNC);
    const key = fnHostId + ':' + receiverHostId;
    const existing = boundProxyCache.get(key)?.deref();
    if (existing !== undefined) return existing;
    const proxy = new Proxy(function () {}, makeHostProxyHandler(fnHostId, receiverHostId));
    boundProxyCache.set(key, new WeakRef(proxy));
    hostProxyMeta.set(proxy, { id: fnHostId, boundThisId: receiverHostId });
    boundFinalizer.register(proxy, key);
    return proxy;
  }

  function decodeHostWireArgs(argv, startIdx, argc) {
    const out = new Array(argc);
    let idx = startIdx;
    for (let i = 0; i < argc; i++) {
      const tag = argv[idx++];
      switch (tag) {
        case T_DIRECT:
        case T_PLAIN_COPY: out[i] = argv[idx++]; break;
        case T_BIGINT: out[i] = BigInt(argv[idx++]); break;
        case T_HOST_OBJ: out[i] = getOrCreateHostProxy(argv[idx++], argv[idx++]); break;
        case T_HOST_BOUND: out[i] = getOrCreateBoundProxy(argv[idx++], argv[idx++]); break;
        case T_GUEST_OBJ: out[i] = guestIdToTarget.get(argv[idx++]); break;
        case T_BIN_SLAB: {
          const meta = argv[idx++];
          out[i] = readBinFromH2g(meta & 0xf, meta >>> 4, argv[idx++]);
          break;
        }
        case T_BIN_COPY: {
          const typeCode = argv[idx++], raw = argv[idx++];
          out[i] = typeCode === 1 && raw instanceof Uint8Array
            ? raw
            : wrapArrayBuffer(typeCode, raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
          break;
        }
        case T_PROMISE: out[i] = createPendingHostPromise(argv[idx++]); break;
        case T_UNWRAP_PROMISE: out[i] = activeGuestPromises.get(argv[idx++]); break;
        case T_SYM_WK: out[i] = WK_SYMS[argv[idx++]]; break;
        case T_SYM_FOR: out[i] = Symbol.for(argv[idx++]); break;
        case T_SYM_REF: out[i] = getOrCreateGuestSym(argv[idx++], argv[idx++]); break;
        default: out[i] = undefined;
      }
    }
    return out;
  }

  return {
    expose(pKind, pVal, pDesc, enumerable, vKind, a, b, c, raw) {
      Object.defineProperty(globalThis, decodePropKey(pKind, pVal, pDesc), {
        value: decodeValue(vKind, a, b, c, raw),
        writable: true,
        enumerable: Boolean(enumerable),
        configurable: true,
      });
    },

    settle(hostPid, isRejected, kind, a, b, c, raw) {
      const val = isRejected ? decodeErrorStr(raw) : decodeValue(kind, a, b, c, raw);
      const entry = pendingFromHost.get(hostPid);
      if (entry === undefined) {
        earlyFromHost.set(hostPid, { isRejected: Boolean(isRejected), val });
        return;
      }
      pendingFromHost.delete(hostPid);
      if (isRejected) entry.reject(val);
      else entry.resolve(val);
    },

    call(opWord, guestId, thisKind, thisA, thisB, argc) {
      const slot = opWord >>> 1;
      const isConstruct = (opWord & 1) !== 0;
      const fn = guestIdToTarget.get(guestId);
      const args = argc > 0 ? decodeHostWireArgs(arguments, 6, argc) : [];
      try {
        const res = isConstruct
          ? Reflect.construct(fn, args)
          : Reflect.apply(fn, thisKind === 0 ? undefined : (thisKind === 1 ? guestIdToTarget.get(thisA) : getOrCreateHostProxy(thisA, thisB)), args);
        return encodeToSlot(slot, res, false);
      } catch (err) {
        ctrl[SLOTS_OFFSET + slot * SLOT_STRIDE + S_KIND] = T_ERROR;
        return encodeErrorStr(err);
      }
    },

    prop(opWord, guestId, pKind, pVal, pDesc, a1, a2, a3, a4, a5, a6) {
      const slot = opWord >>> 4;
      const op = opWord & 0xf;
      const base = SLOTS_OFFSET + slot * SLOT_STRIDE;
      const target = guestIdToTarget.get(guestId);
      if (op === OP_OWN_KEYS) {
        const flat = [];
        for (const k of Reflect.ownKeys(target)) {
          const pk = encodePropKey(k);
          flat.push(pk[0], pk[1]);
        }
        return flat;
      }
      const key = decodePropKey(pKind, pVal, pDesc);
      try {
        switch (op) {
          case OP_GET: return encodeToSlot(slot, Reflect.get(target, key, target), false);
          case OP_SET:
            ctrl[base + S_KIND] = T_DIRECT;
            return Reflect.set(target, key, decodeValue(a1, a2, a3, a4, a5), target);
          case OP_HAS: return Reflect.has(target, key);
          case OP_DELETE: return Reflect.deleteProperty(target, key);
          case OP_GET_DESC: {
            const desc = Reflect.getOwnPropertyDescriptor(target, key);
            if (!desc) { ctrl[base + S_FLAGS] = -1; return undefined; }
            let mask = (desc.writable ? DESC_WRITABLE : 0)
              | (desc.enumerable ? DESC_ENUMERABLE : 0)
              | (desc.configurable ? DESC_CONFIGURABLE : 0);
            if ('value' in desc) {
              ctrl[base + S_FLAGS] = mask | DESC_HAS_VALUE;
              return encodeToSlot(slot, desc.value, false);
            }
            if (desc.get) mask |= DESC_HAS_GET;
            if (desc.set) mask |= DESC_HAS_SET;
            ctrl[base + S_FLAGS] = mask;
            return undefined;
          }
          case OP_DEFINE: {
            const desc = { enumerable: (a1 & DESC_ENUMERABLE) !== 0, configurable: (a1 & DESC_CONFIGURABLE) !== 0 };
            if ((a1 & DESC_HAS_VALUE) !== 0) {
              desc.value = decodeValue(a2, a3, a4, a5, a6);
              desc.writable = (a1 & DESC_WRITABLE) !== 0;
            }
            return Reflect.defineProperty(target, key, desc);
          }
          default: return undefined;
        }
      } catch (err) {
        ctrl[base + S_KIND] = T_ERROR;
        return encodeErrorStr(err);
      }
    },

    release() {
      for (let i = 0; i < arguments.length; i++) guestIdToTarget.delete(arguments[i]);
    },
  };
})`;
}

// ---------------------------------------------------------------------------
// Host-Side Bridge Implementation
// ---------------------------------------------------------------------------
export default class IvmContextBridge {
  private readonly context: ivm.Context;
  private readonly sab: SharedArrayBuffer;
  private readonly ctrl: Int32Array;
  private readonly g2hU8: Uint8Array;
  private readonly g2hBuf: Buffer;
  private readonly h2gU8: Uint8Array;

  // Isolated H2G regions: [0, 256KB) ring for sync returns; [256KB, 512KB) stack for settle/push
  private h2gRetCursor = 0;
  private h2gPushCursor = H2G_RET_SIZE;

  // Per-call slot pool for Host -> Guest calls (slots 128..191)
  private readonly hostFreeSlots: number[] = [];

  private initPromise: Promise<void> | null = null;
  private disposed = false;

  // Unified Map holding all Host & Guest ivm.Reference instances
  private readonly refs = new Map<RefKey, BridgeRef>();

  // Host object handles (strong until Guest GC releases)
  private nextHostId = 1;
  private readonly hostIdToTarget = new Map<number, object>();
  private readonly hostTargetToId = new WeakMap<object, number>();
  private readonly boundFnMeta = new WeakMap<object, BoundHostMeta>();
  private readonly boundFnCache = new Map<string, WeakRef<AnyCallable>>();

  // Host proxies for Guest objects
  private readonly guestIdToProxy = new Map<number, WeakRef<object>>();
  private readonly hostProxyToGuestId = new WeakMap<object, number>();
  private readonly releasedGuestIds: number[] = [];
  private readonly guestFinalizer: FinalizationRegistry<number>;

  // Bidirectional Symbol & Promise tables
  private nextHostSymId = 1;
  private readonly symIdToSym = new Map<number, symbol>();
  private readonly symToSymId = new Map<symbol, number>();

  private nextHostPromiseId = 1;
  private readonly pendingHostPromises = new Map<number, PendingHostPromise>();
  private readonly earlyFromGuest = new Map<number, EarlySettlement>();
  private readonly hostPromiseToGuestPid = new WeakMap<object, number>();

  constructor(context: ivm.Context) {
    this.context = context;
    this.sab = new SharedArrayBuffer(TOTAL_SAB_SIZE);
    this.ctrl = new Int32Array(this.sab, 0, HEADER_SIZE >>> 2);
    this.g2hU8 = new Uint8Array(this.sab, G2H_BASE, G2H_SIZE);
    this.g2hBuf = Buffer.from(this.sab, G2H_BASE, G2H_SIZE);
    this.h2gU8 = new Uint8Array(this.sab, H2G_BASE, H2G_SIZE);

    for (let i = MAX_GUEST_SLOTS + MAX_HOST_SLOTS - 1; i >= MAX_GUEST_SLOTS; i--) {
      this.hostFreeSlots.push(i);
    }

    this.guestFinalizer = new FinalizationRegistry<number>((guestId) => {
      if (this.guestIdToProxy.get(guestId)?.deref() !== undefined) return;
      this.guestIdToProxy.delete(guestId);
      this.releasedGuestIds.push(guestId);
      if (this.releasedGuestIds.length >= 256) this.flushReleasedGuestIds();
    });
  }

  private allocHostSlot(): number {
    const slot = this.hostFreeSlots.pop();
    if (slot === undefined) throw new RangeError('Host bridge call nesting limit exceeded');
    return slot;
  }

  private ensureInitialized(): Promise<void> {
    return (this.initPromise ??= this.initialize());
  }

  private getGuestRef(op: GuestOp): ivm.Reference<GuestFn> {
    const ref = this.refs.get(`g:${op}`);
    if (ref === undefined) throw new Error('IvmContextBridge is not initialized or disposed');
    return ref as ivm.Reference<GuestFn>;
  }

  private async initialize(): Promise<void> {
    const bridge = this;
    const hostHandlers: Record<HostOp, object> = {
      call: function (opWord: number, fnId: number, thisId: number, argc: number): WireValue {
        return bridge.handleHostCall(
          opWord >>> 1,
          (opWord & 1) !== 0,
          fnId,
          thisId,
          argc,
          arguments,
        );
      },
      fallback: (
        opWord: number,
        fnId: number,
        thisId: number,
        packed: PackedFallbackArg[],
      ): WireValue =>
        bridge.handleHostCallFallback(opWord >>> 1, (opWord & 1) !== 0, fnId, thisId, packed),
      prop: (
        opWord: number,
        hostId: number,
        pKind?: number,
        pVal?: EncodedPropVal,
        pDesc?: string,
        a1?: unknown,
        a2?: unknown,
        a3?: unknown,
        a4?: unknown,
      ): WireValue =>
        bridge.handleHostProp(opWord >>> 4, opWord & 0xf, hostId, pKind, pVal, pDesc, a1, a2, a3, a4),
      settle: (
        gpid: number,
        isRej: number,
        kind: number,
        a: number,
        b: number,
        c: number,
        raw: unknown,
      ): void => bridge.handleHostPromiseSettle(gpid, isRej !== 0, kind, a, b, c, raw),
      release: (...ids: number[]): void => {
        for (const id of ids) bridge.hostIdToTarget.delete(id);
      },
    };

    const hostRefArgs: ivm.Reference<object>[] = [];
    for (const op of HOST_OPS) {
      const ref = new ivm.Reference<object>(hostHandlers[op]);
      this.refs.set(`h:${op}`, ref);
      hostRefArgs.push(ref);
    }

    const initRef = (await this.context.eval(buildGuestBootstrapCode(), {
      reference: true,
    })) as ivm.Reference<(this: undefined, ...args: ivm.Transferable[]) => Record<GuestOp, GuestFn>>;

    const sabCopy = new ivm.ExternalCopy(this.sab);
    const guestApiRef = await initRef.apply(
      undefined,
      [sabCopy.copyInto({ release: true }), ...hostRefArgs],
      { result: { reference: true } },
    );
    initRef.release();

    for (const op of GUEST_OPS) {
      const ref = guestApiRef.getSync(op, { reference: true }) as ivm.Reference<GuestFn>;
      this.refs.set(`g:${op}`, ref);
    }
    guestApiRef.release();
  }

  public async exposeToGlobal(env: object): Promise<void> {
    if (!isObjectLike(env)) throw new TypeError('exposeToGlobal expects a non-null object');
    await this.ensureInitialized();
    const exposeRef = this.getGuestRef('expose');

    for (const key of Reflect.ownKeys(env)) {
      const desc = Object.getOwnPropertyDescriptor(env, key);
      if (desc === undefined) continue;
      const [pKind, pVal, pDesc] = this.encodeHostPropKey(key);
      const savedPush = this.h2gPushCursor;
      try {
        const [vKind, a, b, c, raw] = this.encodeHostInline(Reflect.get(env, key, env));
        exposeRef.applySync(undefined, [
          pKind, pVal, pDesc, desc.enumerable ? 1 : 0, vKind, a, b, c, raw,
        ]);
      } finally {
        this.h2gPushCursor = savedPush;
      }
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ref of this.refs.values()) {
      try { ref.release(); } catch {}
    }
    this.refs.clear();
    this.hostIdToTarget.clear();
    this.guestIdToProxy.clear();
    this.pendingHostPromises.clear();
    this.earlyFromGuest.clear();
    this.boundFnCache.clear();
  }

  // -------------------------------------------------------------------------
  // Handle, Symbol, Plain-Data & Bound-Method Helpers
  // -------------------------------------------------------------------------
  private registerHostObj(obj: object): number {
    let id = this.hostTargetToId.get(obj);
    if (id !== undefined) {
      if (!this.hostIdToTarget.has(id)) this.hostIdToTarget.set(id, obj);
      return id;
    }
    id = this.nextHostId++;
    this.hostTargetToId.set(obj, id);
    this.hostIdToTarget.set(id, obj);
    return id;
  }

  private getObjFlags(val: unknown): number {
    return typeof val === 'function' ? FLAG_FUNC : Array.isArray(val) ? FLAG_ARRAY : 0;
  }

  private getOrCreateHostSym(symId: number, desc?: string): symbol {
    let s = this.symIdToSym.get(symId);
    if (s !== undefined) return s;
    s = Symbol(desc);
    this.symIdToSym.set(symId, s);
    this.symToSymId.set(s, symId);
    return s;
  }

  private getOrCreateHostSymId(sym: symbol): number {
    let id = this.symToSymId.get(sym);
    if (id !== undefined) return id;
    id = this.nextHostSymId++;
    this.symToSymId.set(sym, id);
    this.symIdToSym.set(id, sym);
    return id;
  }

  private encodeHostPropKey(key: PropKey): [number, EncodedPropVal, string | undefined] {
    if (typeof key === 'string') return [P_STR, key, undefined];
    const wk = HOST_WK_SYM_TO_IDX.get(key);
    if (wk !== undefined) return [P_SYM_WK, wk, undefined];
    const fk = Symbol.keyFor(key);
    if (fk !== undefined) return [P_SYM_FOR, fk, undefined];
    return [P_SYM_REF, this.getOrCreateHostSymId(key), key.description];
  }

  private decodeGuestPropKey(pKind: number, pVal: EncodedPropVal, pDesc?: string): PropKey {
    if (pKind === P_STR) return pVal as string;
    if (pKind === P_SYM_WK) {
      const sym = HOST_WK_SYMBOLS[pVal as number];
      if (sym === undefined) throw new TypeError(`Unknown symbol index: ${String(pVal)}`);
      return sym;
    }
    if (pKind === P_SYM_FOR) return Symbol.for(pVal as string);
    return this.getOrCreateHostSym(pVal as number, pDesc);
  }

  private getOrCreateBoundHostFn(fnId: number, receiverId: number): AnyCallable {
    const cacheKey = `${fnId}:${receiverId}`;
    const existing = this.boundFnCache.get(cacheKey)?.deref();
    if (existing !== undefined) return existing;
    const fn = this.hostIdToTarget.get(fnId);
    if (typeof fn !== 'function') throw new TypeError(`Host handle ${fnId} is not a function`);
    const receiver = this.hostIdToTarget.get(receiverId);

    const wrapper: AnyCallable = function (this: unknown, ...args: unknown[]): unknown {
      const targetThis =
        this === undefined || this === null || this === globalThis ? receiver : this;
      return Reflect.apply(fn, targetThis, args);
    };
    this.boundFnMeta.set(wrapper, { fnId, receiverId });
    this.boundFnCache.set(cacheKey, new WeakRef(wrapper));
    return wrapper;
  }

  private isPlainData(val: unknown, depth = 0, seen?: Set<object>): boolean {
    if (depth > 16) return false;
    if (val === null || val === undefined) return true;
    const t = typeof val;
    if (t === 'boolean' || t === 'number' || t === 'string' || t === 'bigint') return true;
    if (t !== 'object') return false;

    const obj = val as object;
    if (this.hostProxyToGuestId.has(obj)) return false;
    if (obj instanceof Date || obj instanceof RegExp) {
      return Object.keys(obj).length === 0 && Object.getOwnPropertySymbols(obj).length === 0;
    }
    if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) return true;

    const visited = seen ?? new Set<object>();
    if (visited.has(obj)) return false;
    visited.add(obj);

    if (Array.isArray(obj)) {
      if (Object.getPrototypeOf(obj) !== Array.prototype) return false;
      if (obj.length > 10000 || Object.getOwnPropertySymbols(obj).length > 0) return false;
      if (Object.getOwnPropertyNames(obj).length > obj.length + 1) return false;
      for (let i = 0; i < obj.length; i++) {
        if (i in obj) {
          const d = Object.getOwnPropertyDescriptor(obj, i);
          if (!d || d.get || d.set || !this.isPlainData(d.value, depth + 1, visited)) return false;
        }
      }
      return true;
    }

    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(obj).length > 0) return false;

    const names = Object.getOwnPropertyNames(obj);
    if (names.length > 256) return false;
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(obj, name);
      if (!d || !d.enumerable || d.get || d.set || !this.isPlainData(d.value, depth + 1, visited)) {
        return false;
      }
    }
    return true;
  }

  private flushReleasedGuestIds(): void {
    const releaseRef = this.refs.get('g:release') as ivm.Reference<GuestFn> | undefined;
    if (this.disposed || this.releasedGuestIds.length === 0 || releaseRef === undefined) return;
    try {
      releaseRef.applyIgnored(undefined, this.releasedGuestIds.splice(0, this.releasedGuestIds.length));
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Host -> Guest Encoding (Slot-Isolated Sync Return vs Pure Push Inline)
  // -------------------------------------------------------------------------
  private encodeHostCommon(
    val: unknown,
    usePushSlab: boolean,
    wrapCopies: boolean,
    trackedBins?: TrackedSlabBin[],
  ): [number, number, number, number, unknown] {
    if (val === null || val === undefined) return [T_DIRECT, 0, 0, 0, val];
    const t = typeof val;
    if (t === 'boolean' || t === 'number' || t === 'string') return [T_DIRECT, 0, 0, 0, val];
    if (t === 'bigint') return [T_BIGINT, 0, 0, 0, (val as bigint).toString()];
    if (t === 'symbol') {
      const sym = val as symbol;
      const wk = HOST_WK_SYM_TO_IDX.get(sym);
      if (wk !== undefined) return [T_SYM_WK, wk, 0, 0, undefined];
      const fk = Symbol.keyFor(sym);
      if (fk !== undefined) return [T_SYM_FOR, 0, 0, 0, fk];
      return [T_SYM_REF, this.getOrCreateHostSymId(sym), 0, 0, sym.description];
    }
    if (!isObjectLike(val)) return [T_DIRECT, 0, 0, 0, undefined];

    if (trackedBins !== undefined) {
      for (const b of trackedBins) {
        if (val === b.hostArg) return [T_SAME_ARG, b.argIndex, 0, 0, undefined];
      }
    }

    const guestId = this.hostProxyToGuestId.get(val);
    if (guestId !== undefined) return [T_GUEST_OBJ, guestId, 0, 0, undefined];

    if (t === 'function') {
      const bm = this.boundFnMeta.get(val);
      if (bm !== undefined) return [T_HOST_BOUND, bm.fnId, bm.receiverId, 0, undefined];
    }

    const binType = getBinTypeCode(val);
    if (binType >= 0) {
      const u8 = asUint8View(val as ArrayBuffer | ArrayBufferView);
      const len = u8.byteLength;
      if (usePushSlab) {
        const off = (this.h2gPushCursor + 7) & ~7;
        if (off + len <= H2G_SIZE) {
          if (len > 0) this.h2gU8.set(u8, off);
          this.h2gPushCursor = off + len;
          return [T_BIN_SLAB, binType, off, len, undefined];
        }
      } else if (len <= H2G_RET_SIZE) {
        let off = (this.h2gRetCursor + 7) & ~7;
        if (off + len > H2G_RET_SIZE) off = 0;
        if (len > 0) this.h2gU8.set(u8, off);
        this.h2gRetCursor = off + len;
        return [T_BIN_SLAB, binType, off, len, undefined];
      }
      return [
        T_BIN_COPY,
        binType,
        0,
        len,
        wrapCopies ? new ivm.ExternalCopy(u8).copyInto({ release: true }) : u8,
      ];
    }

    if (isThenable(val)) {
      const origGuestPid = this.hostPromiseToGuestPid.get(val);
      if (origGuestPid !== undefined) {
        val.then(undefined, () => {});
        return [T_UNWRAP_PROMISE, origGuestPid, 0, 0, undefined];
      }
      return [T_PROMISE, this.attachHostPromise(val), 0, 0, undefined];
    }

    if (t === 'object' && this.isPlainData(val)) {
      return [
        T_PLAIN_COPY,
        0,
        0,
        0,
        wrapCopies ? new ivm.ExternalCopy(val).copyInto({ release: true }) : val,
      ];
    }

    return [T_HOST_OBJ, this.registerHostObj(val), this.getObjFlags(val), 0, undefined];
  }

  private encodeHostToSlot(slot: number, val: unknown, trackedBins?: TrackedSlabBin[]): WireValue;
  private encodeHostToSlot(
    slot: number,
    val: unknown,
    trackedBins: TrackedSlabBin[] | undefined,
    wrapCopies: boolean,
  ): unknown;
  private encodeHostToSlot(
    slot: number,
    val: unknown,
    trackedBins?: TrackedSlabBin[],
    wrapCopies = true,
  ): unknown {
    const [kind, a, b, c, raw] = this.encodeHostCommon(val, false, wrapCopies, trackedBins);
    const base = SLOTS_OFFSET + slot * SLOT_STRIDE;
    this.ctrl[base + S_KIND] = kind;
    this.ctrl[base + S_A] = a;
    this.ctrl[base + S_B] = b;
    this.ctrl[base + S_C] = c;
    return raw;
  }

  // Pure inline encoder for settle/expose/Host->Guest calls: NEVER touches this.ctrl!
  private encodeHostInline(val: unknown): [number, number, number, number, WireValue] {
    return this.encodeHostCommon(val, true, true) as [number, number, number, number, WireValue];
  }

  private attachHostPromise(thenable: PromiseLike<unknown>): number {
    const pid = this.nextHostPromiseId++;
    const promise = thenable instanceof Promise ? thenable : Promise.resolve(thenable);
    promise.then(
      (value) => this.settleGuestPromise(pid, false, value),
      (err: unknown) => this.settleGuestPromise(pid, true, err),
    );
    return pid;
  }

  private settleGuestPromise(pid: number, isRejected: boolean, val: unknown): void {
    const settleRef = this.refs.get('g:settle') as ivm.Reference<GuestFn> | undefined;
    if (this.disposed || settleRef === undefined) return;
    if (isRejected) {
      try {
        settleRef.applySync(undefined, [pid, 1, T_ERROR, 0, 0, 0, encodeErrorString(val)]);
      } catch {}
      return;
    }
    const savedPush = this.h2gPushCursor;
    try {
      const [kind, a, b, c, raw] = this.encodeHostInline(val);
      settleRef.applySync(undefined, [pid, 0, kind, a, b, c, raw]);
    } catch {
    } finally {
      this.h2gPushCursor = savedPush;
    }
  }

  // -------------------------------------------------------------------------
  // Guest -> Host Handlers
  // -------------------------------------------------------------------------
  private decodeSingleGuestArg(tag: number, a1: unknown, a2: unknown): unknown {
    switch (tag) {
      case T_DIRECT: return a1;
      case T_BIGINT: return BigInt(a1 as string);
      case T_HOST_OBJ: return this.hostIdToTarget.get(a1 as number);
      case T_HOST_BOUND: return this.getOrCreateBoundHostFn(a1 as number, a2 as number);
      case T_GUEST_OBJ: return this.getOrCreateHostProxyForGuest(a1 as number, a2 as number);
      case T_BIN_SLAB: {
        const meta = a1 as number;
        const len = a2 as number;
        const ab = allocFastArrayBuffer(len);
        if (len > 0) new Uint8Array(ab).set(this.g2hU8.subarray(meta >>> 4, (meta >>> 4) + len));
        return wrapArrayBuffer(meta & 0xf, ab);
      }
      case T_SYM_WK: return HOST_WK_SYMBOLS[a1 as number];
      case T_SYM_FOR: return Symbol.for(a1 as string);
      case T_SYM_REF: return this.getOrCreateHostSym(a1 as number, a2 as string | undefined);
      case T_PROMISE: return this.getOrCreatePendingHostPromise(a1 as number);
      default: return undefined;
    }
  }

  private resolveHostThis(thisId: number): unknown {
    if (thisId === 0) return undefined;
    return thisId > 0
      ? this.hostIdToTarget.get(thisId)
      : this.getOrCreateHostProxyForGuest(-thisId, 0);
  }

  private handleHostCall(
    slot: number,
    isConstruct: boolean,
    fnId: number,
    thisId: number,
    argc: number,
    rawArgs: ArrayLike<unknown>,
  ): WireValue {
    const base = SLOTS_OFFSET + slot * SLOT_STRIDE;
    const fn = this.hostIdToTarget.get(fnId);
    if (typeof fn !== 'function') {
      this.ctrl[base + S_MUTATED] = 0;
      this.ctrl[base + S_KIND] = T_ERROR;
      return encodeErrorString(new TypeError(`Target handle ${fnId} is not callable`));
    }

    const args = argc > 0 ? new Array<unknown>(argc) : [];
    let trackedBins: TrackedSlabBin[] | undefined;

    let idx = 4;
    for (let i = 0; i < argc; i++) {
      const tag = rawArgs[idx++] as number;
      if (tag === T_DIRECT) {
        args[i] = rawArgs[idx++];
      } else if (tag === T_BIN_SLAB) {
        const meta = rawArgs[idx++] as number;
        const len = rawArgs[idx++] as number;
        const off = meta >>> 4;
        const ab = allocFastArrayBuffer(len);
        const hostU8 = new Uint8Array(ab);
        if (len > 0) hostU8.set(this.g2hU8.subarray(off, off + len));
        const hostArg = (meta & 0xf) === 1 ? hostU8 : wrapArrayBuffer(meta & 0xf, ab);
        args[i] = hostArg;
        (trackedBins ??= []).push({
          argIndex: i,
          hostArg,
          hostBuf: Buffer.from(ab, 0, len),
          hostU8,
          off,
          len,
        });
      } else if (tag === T_HOST_BOUND || tag === T_GUEST_OBJ || tag === T_SYM_REF) {
        args[i] = this.decodeSingleGuestArg(tag, rawArgs[idx++], rawArgs[idx++]);
      } else {
        args[i] = this.decodeSingleGuestArg(tag, rawArgs[idx++], undefined);
      }
    }

    let result: unknown;
    try {
      result = isConstruct
        ? Reflect.construct(fn, args)
        : Reflect.apply(fn, this.resolveHostThis(thisId), args);
    } catch (err) {
      this.ctrl[base + S_MUTATED] = 0;
      this.ctrl[base + S_KIND] = T_ERROR;
      return encodeErrorString(err);
    }

    if (trackedBins !== undefined) {
      let mutatedMask = 0;
      for (const b of trackedBins) {
        if (b.len > 0 && this.g2hBuf.compare(b.hostBuf, 0, b.len, b.off, b.off + b.len) !== 0) {
          this.g2hU8.set(b.hostU8, b.off);
          mutatedMask |= 1 << b.argIndex;
        }
      }
      this.ctrl[base + S_MUTATED] = mutatedMask;
    } else {
      this.ctrl[base + S_MUTATED] = 0;
    }

    return this.encodeHostToSlot(slot, result, trackedBins);
  }

  private handleHostCallFallback(
    slot: number,
    isConstruct: boolean,
    fnId: number,
    thisId: number,
    packed: PackedFallbackArg[],
  ): WireValue {
    const base = SLOTS_OFFSET + slot * SLOT_STRIDE;
    const fn = this.hostIdToTarget.get(fnId);
    if (typeof fn !== 'function') {
      this.ctrl[base + S_KIND] = T_ERROR;
      return encodeErrorString(new TypeError(`Target handle ${fnId} is not callable`));
    }

    const args = new Array<unknown>(packed.length);
    const largeBins: { idx: number; orig: Buffer; hostU8: Uint8Array; hostArg: ArrayBuffer | ArrayBufferView }[] = [];

    for (let i = 0; i < packed.length; i++) {
      const p = packed[i];
      if (p === undefined) continue;
      if (p.k === T_BIN_COPY) {
        const bytes = p.v as Uint8Array;
        const typeCode = p.a ?? 1;
        const ab = allocFastArrayBuffer(bytes.byteLength);
        const hostU8 = new Uint8Array(ab);
        hostU8.set(bytes);
        const hostArg = typeCode === 1 ? hostU8 : wrapArrayBuffer(typeCode, ab);
        args[i] = hostArg;
        largeBins.push({
          idx: i,
          orig: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          hostU8,
          hostArg,
        });
      } else {
        args[i] = this.decodeSingleGuestArg(p.k, p.a ?? p.v, p.b ?? p.v);
      }
    }

    let result: unknown;
    try {
      result = isConstruct
        ? Reflect.construct(fn, args)
        : Reflect.apply(fn, this.resolveHostThis(thisId), args);
    } catch (err) {
      this.ctrl[base + S_KIND] = T_ERROR;
      return encodeErrorString(err);
    }

    const writeBacks: (number | Uint8Array)[] = [];
    let sameArgIdx = -1;
    for (const lb of largeBins) {
      if (result === lb.hostArg) sameArgIdx = lb.idx;
      const hostBuf = Buffer.from(lb.hostU8.buffer, lb.hostU8.byteOffset, lb.hostU8.byteLength);
      if (lb.orig.compare(hostBuf) !== 0) writeBacks.push(lb.idx, lb.hostU8);
    }

    if (writeBacks.length > 0) {
      const rawRet = sameArgIdx >= 0
        ? ((this.ctrl[base + S_KIND] = T_SAME_ARG), (this.ctrl[base + S_A] = sameArgIdx), undefined)
        : this.encodeHostToSlot(slot, result, undefined, false);
      return new ivm.ExternalCopy({ __wb: writeBacks, __ret: rawRet }).copyInto({ release: true });
    }
    if (sameArgIdx >= 0) {
      this.ctrl[base + S_KIND] = T_SAME_ARG;
      this.ctrl[base + S_A] = sameArgIdx;
      return undefined;
    }
    return this.encodeHostToSlot(slot, result);
  }

  private handleHostProp(
    slot: number,
    op: number,
    hostId: number,
    pKind?: number,
    pVal?: EncodedPropVal,
    pDesc?: string,
    a1?: unknown,
    a2?: unknown,
    a3?: unknown,
    a4?: unknown,
  ): WireValue {
    const base = SLOTS_OFFSET + slot * SLOT_STRIDE;
    const target = this.hostIdToTarget.get(hostId);
    if (op === OP_OWN_KEYS) {
      const flat: (number | string)[] = [];
      if (target !== undefined) {
        for (const k of Reflect.ownKeys(target)) {
          const [kKind, kVal] = this.encodeHostPropKey(k);
          flat.push(kKind, kVal);
        }
      }
      return new ivm.ExternalCopy(flat).copyInto({ release: true });
    }

    if (target === undefined) {
      this.ctrl[base + S_FLAGS] = -1;
      if (op === OP_HAS || op === OP_DELETE || op === OP_DEFINE) return false;
      if (op === OP_GET_DESC) return undefined;
      this.ctrl[base + S_KIND] = T_ERROR;
      return encodeErrorString(new TypeError(`Invalid host handle: ${hostId}`));
    }

    const prop = this.decodeGuestPropKey(pKind ?? P_STR, pVal ?? '', pDesc);

    switch (op) {
      case OP_GET: {
        let val: unknown;
        try {
          val = Reflect.get(target, prop, target);
        } catch (err) {
          this.ctrl[base + S_FLAGS] = 0;
          this.ctrl[base + S_KIND] = T_ERROR;
          return encodeErrorString(err);
        }

        let cacheFlags = 0;
        const ownDesc = Object.getOwnPropertyDescriptor(target, prop);
        if (ownDesc !== undefined) {
          if (!ownDesc.configurable && !ownDesc.writable && !ownDesc.get && !ownDesc.set) {
            cacheFlags = CACHE_IMMUTABLE;
          }
        } else if (typeof val === 'function') {
          let proto = Object.getPrototypeOf(target) as object | null;
          while (proto !== null) {
            const pd = Object.getOwnPropertyDescriptor(proto, prop);
            if (pd !== undefined) {
              if (typeof pd.value === 'function' && pd.get === undefined) cacheFlags = CACHE_PROTO_FN;
              break;
            }
            proto = Object.getPrototypeOf(proto) as object | null;
          }
        }
        this.ctrl[base + S_FLAGS] = cacheFlags;

        if (typeof val === 'function' && !this.hostProxyToGuestId.has(val)) {
          const bm = this.boundFnMeta.get(val);
          this.ctrl[base + S_KIND] = T_HOST_BOUND;
          this.ctrl[base + S_A] = bm !== undefined ? bm.fnId : this.registerHostObj(val);
          this.ctrl[base + S_B] = bm !== undefined ? bm.receiverId : hostId;
          return undefined;
        }
        return this.encodeHostToSlot(slot, val);
      }

      case OP_SET: {
        try {
          this.ctrl[base + S_KIND] = T_DIRECT;
          return Reflect.set(target, prop, this.decodeSingleGuestArg(a1 as number, a2, a3), target);
        } catch (err) {
          this.ctrl[base + S_KIND] = T_ERROR;
          return encodeErrorString(err);
        }
      }

      case OP_HAS:
        return Reflect.has(target, prop);

      case OP_DELETE:
        return Reflect.deleteProperty(target, prop);

      case OP_GET_DESC: {
        const desc = Object.getOwnPropertyDescriptor(target, prop);
        if (desc === undefined) {
          this.ctrl[base + S_FLAGS] = -1;
          return undefined;
        }
        let mask =
          (desc.writable ? DESC_WRITABLE : 0) |
          (desc.enumerable ? DESC_ENUMERABLE : 0) |
          (desc.configurable ? DESC_CONFIGURABLE : 0);
        if ('value' in desc) {
          this.ctrl[base + S_FLAGS] = mask | DESC_HAS_VALUE;
          if (typeof desc.value === 'function' && !this.hostProxyToGuestId.has(desc.value)) {
            this.ctrl[base + S_KIND] = T_HOST_BOUND;
            this.ctrl[base + S_A] = this.registerHostObj(desc.value);
            this.ctrl[base + S_B] = hostId;
            return undefined;
          }
          return this.encodeHostToSlot(slot, desc.value);
        }
        if (desc.get !== undefined) mask |= DESC_HAS_GET;
        if (desc.set !== undefined) mask |= DESC_HAS_SET;
        this.ctrl[base + S_FLAGS] = mask;
        return undefined;
      }

      case OP_DEFINE: {
        const mask = a1 as number;
        const desc: PropertyDescriptor = {
          enumerable: (mask & DESC_ENUMERABLE) !== 0,
          configurable: (mask & DESC_CONFIGURABLE) !== 0,
        };
        if ((mask & DESC_HAS_VALUE) !== 0) {
          desc.value = this.decodeSingleGuestArg(a2 as number, a3, a4);
          desc.writable = (mask & DESC_WRITABLE) !== 0;
        }
        return Reflect.defineProperty(target, prop, desc);
      }

      default:
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Guest Promise & Guest Return Decoding
  // -------------------------------------------------------------------------
  private getOrCreatePendingHostPromise(gpid: number): Promise<unknown> {
    const early = this.earlyFromGuest.get(gpid);
    if (early !== undefined) {
      this.earlyFromGuest.delete(gpid);
      return early.isRejected ? Promise.reject(early.value) : Promise.resolve(early.value);
    }
    const existing = this.pendingHostPromises.get(gpid);
    if (existing !== undefined) return existing.promise;
    let resolveFn!: (v: unknown) => void;
    let rejectFn!: (r?: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    this.pendingHostPromises.set(gpid, { resolve: resolveFn, reject: rejectFn, promise });
    this.hostPromiseToGuestPid.set(promise, gpid);
    return promise;
  }

  private handleHostPromiseSettle(
    gpid: number,
    isRejected: boolean,
    kind: number,
    a: number,
    b: number,
    c: number,
    raw: unknown,
  ): void {
    const value = isRejected
      ? decodeErrorString(raw as string)
      : this.decodeGuestValue(kind, a, b, c, raw);
    const entry = this.pendingHostPromises.get(gpid);
    if (entry === undefined) {
      this.earlyFromGuest.set(gpid, { isRejected, value });
      return;
    }
    this.pendingHostPromises.delete(gpid);
    if (isRejected) entry.reject(value);
    else entry.resolve(value);
  }

  private decodeGuestValue(kind: number, a: number, b: number, c: number, raw: unknown): unknown {
    if (kind === T_DIRECT) return raw;
    switch (kind) {
      case T_BIGINT: return BigInt(raw as string);
      case T_HOST_OBJ: return this.hostIdToTarget.get(a);
      case T_HOST_BOUND: return this.getOrCreateBoundHostFn(a, b);
      case T_GUEST_OBJ: return this.getOrCreateHostProxyForGuest(a, b);
      case T_PROMISE: return this.getOrCreatePendingHostPromise(a);
      case T_BIN_SLAB: {
        const ab = allocFastArrayBuffer(c);
        if (c > 0) new Uint8Array(ab).set(this.g2hU8.subarray(b, b + c));
        return wrapArrayBuffer(a, ab);
      }
      case T_BIN_COPY: {
        const bytes = raw as Uint8Array;
        const ab = allocFastArrayBuffer(bytes.byteLength);
        new Uint8Array(ab).set(bytes);
        return wrapArrayBuffer(a, ab);
      }
      case T_SYM_WK: return HOST_WK_SYMBOLS[a];
      case T_SYM_FOR: return Symbol.for(raw as string);
      case T_SYM_REF: return this.getOrCreateHostSym(a, raw as string | undefined);
      case T_ERROR: throw decodeErrorString(raw as string);
      default: return raw;
    }
  }

  private decodeGuestSlotReturn(slot: number, raw: unknown): unknown {
    const base = SLOTS_OFFSET + slot * SLOT_STRIDE;
    return this.decodeGuestValue(
      this.ctrl[base + S_KIND] ?? T_DIRECT,
      this.ctrl[base + S_A] ?? 0,
      this.ctrl[base + S_B] ?? 0,
      this.ctrl[base + S_C] ?? 0,
      raw,
    );
  }

  // -------------------------------------------------------------------------
  // Host Proxies Wrapping Live Guest Objects / Functions
  // -------------------------------------------------------------------------
  private encodeHostArgsForGuest(args: unknown[], wire: WireValue[]): void {
    for (const arg of args) {
      const [kind, a, b, c, raw] = this.encodeHostInline(arg);
      switch (kind) {
        case T_DIRECT:
        case T_PLAIN_COPY:
        case T_BIGINT:
        case T_SYM_FOR:
          wire.push(kind, raw);
          break;
        case T_HOST_OBJ:
        case T_HOST_BOUND:
          wire.push(kind, a, b);
          break;
        case T_GUEST_OBJ:
        case T_PROMISE:
        case T_UNWRAP_PROMISE:
        case T_SYM_WK:
          wire.push(kind, a);
          break;
        case T_BIN_SLAB:
          wire.push(T_BIN_SLAB, (b << 4) | a, c);
          break;
        case T_BIN_COPY:
        case T_SYM_REF:
          wire.push(kind, a, raw);
          break;
        default:
          wire.push(T_DIRECT, undefined);
      }
    }
  }

  private getOrCreateHostProxyForGuest(guestId: number, flags: number): object {
    const existing = this.guestIdToProxy.get(guestId)?.deref();
    if (existing !== undefined) return existing;

    const target: object =
      (flags & FLAG_FUNC) !== 0 ? function () {} : (flags & FLAG_ARRAY) !== 0 ? [] : {};

    const bridge = this;
    const proxy = new Proxy(target, {
      get(_t, prop) {
        const slot = bridge.allocHostSlot();
        const [pKind, pVal, pDesc] = bridge.encodeHostPropKey(prop);
        try {
          return bridge.decodeGuestSlotReturn(
            slot,
            bridge.getGuestRef('prop').applySync(undefined, [
              (slot << 4) | OP_GET, guestId, pKind, pVal, pDesc,
            ]),
          );
        } finally {
          bridge.hostFreeSlots.push(slot);
        }
      },

      set(_t, prop, value) {
        const slot = bridge.allocHostSlot();
        const [pKind, pVal, pDesc] = bridge.encodeHostPropKey(prop);
        const saved = bridge.h2gPushCursor;
        try {
          const [vk, a, b, c, raw] = bridge.encodeHostInline(value);
          const ok = bridge.getGuestRef('prop').applySync(undefined, [
            (slot << 4) | OP_SET, guestId, pKind, pVal, pDesc, vk, a, b, c, raw,
          ]);
          if (bridge.ctrl[SLOTS_OFFSET + slot * SLOT_STRIDE + S_KIND] === T_ERROR) {
            throw decodeErrorString(ok as string);
          }
          return Boolean(ok);
        } finally {
          bridge.h2gPushCursor = saved;
          bridge.hostFreeSlots.push(slot);
        }
      },

      has(_t, prop) {
        const [pKind, pVal, pDesc] = bridge.encodeHostPropKey(prop);
        return Boolean(
          bridge.getGuestRef('prop').applySync(undefined, [OP_HAS, guestId, pKind, pVal, pDesc]),
        );
      },

      deleteProperty(_t, prop) {
        const [pKind, pVal, pDesc] = bridge.encodeHostPropKey(prop);
        return Boolean(
          bridge.getGuestRef('prop').applySync(undefined, [OP_DELETE, guestId, pKind, pVal, pDesc]),
        );
      },

      ownKeys(t): PropKey[] {
        const flat = bridge.getGuestRef('prop').applySync(undefined, [OP_OWN_KEYS, guestId], {
          result: { copy: true },
        }) as (number | string)[];
        const keys: PropKey[] = [];
        const seen = new Set<PropKey>();
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const kKind = flat[i];
          const kVal = flat[i + 1];
          if (typeof kKind !== 'number' || kVal === undefined) continue;
          const k = bridge.decodeGuestPropKey(kKind, kVal);
          if (!seen.has(k)) {
            seen.add(k);
            keys.push(k);
          }
        }
        for (const tk of Reflect.ownKeys(t)) {
          if (!seen.has(tk)) {
            const td = Reflect.getOwnPropertyDescriptor(t, tk);
            if (td !== undefined && !td.configurable) keys.push(tk);
          }
        }
        return keys;
      },

      getOwnPropertyDescriptor(t, prop) {
        const slot = bridge.allocHostSlot();
        const [pKind, pVal, pDesc] = bridge.encodeHostPropKey(prop);
        try {
          const raw = bridge.getGuestRef('prop').applySync(undefined, [
            (slot << 4) | OP_GET_DESC, guestId, pKind, pVal, pDesc,
          ]);
          const mask = bridge.ctrl[SLOTS_OFFSET + slot * SLOT_STRIDE + S_FLAGS] ?? -1;
          const td = Reflect.getOwnPropertyDescriptor(t, prop);
          if (mask < 0) return td !== undefined && !td.configurable ? td : undefined;

          const mustNonConfig = td !== undefined && !td.configurable;
          const desc: PropertyDescriptor = {
            enumerable: (mask & DESC_ENUMERABLE) !== 0,
            configurable: !mustNonConfig,
          };
          if ((mask & DESC_HAS_VALUE) !== 0) {
            desc.value = bridge.decodeGuestSlotReturn(slot, raw);
            desc.writable =
              mustNonConfig && td !== undefined ? Boolean(td.writable) : (mask & DESC_WRITABLE) !== 0;
          } else {
            if ((mask & DESC_HAS_GET) !== 0) {
              desc.get = () => {
                const gs = bridge.allocHostSlot();
                try {
                  return bridge.decodeGuestSlotReturn(
                    gs,
                    bridge.getGuestRef('prop').applySync(undefined, [
                      (gs << 4) | OP_GET, guestId, pKind, pVal, pDesc,
                    ]),
                  );
                } finally {
                  bridge.hostFreeSlots.push(gs);
                }
              };
            }
            if ((mask & DESC_HAS_SET) !== 0) {
              desc.set = (v: unknown) => {
                const ss = bridge.allocHostSlot();
                const saved = bridge.h2gPushCursor;
                try {
                  const [vk, a, b, c, r] = bridge.encodeHostInline(v);
                  const ok = bridge.getGuestRef('prop').applySync(undefined, [
                    (ss << 4) | OP_SET, guestId, pKind, pVal, pDesc, vk, a, b, c, r,
                  ]);
                  if (bridge.ctrl[SLOTS_OFFSET + ss * SLOT_STRIDE + S_KIND] === T_ERROR) {
                    throw decodeErrorString(ok as string);
                  }
                } finally {
                  bridge.h2gPushCursor = saved;
                  bridge.hostFreeSlots.push(ss);
                }
              };
            }
          }
          return desc;
        } finally {
          bridge.hostFreeSlots.push(slot);
        }
      },

      defineProperty(_t, prop, descriptor) {
        const [pKind, pVal, pDesc] = bridge.encodeHostPropKey(prop);
        let mask =
          (descriptor.writable ? DESC_WRITABLE : 0) |
          (descriptor.enumerable ? DESC_ENUMERABLE : 0) |
          (descriptor.configurable ? DESC_CONFIGURABLE : 0);
        const saved = bridge.h2gPushCursor;
        try {
          let vk = T_DIRECT, a = 0, b = 0, c = 0;
          let raw: WireValue = undefined;
          if ('value' in descriptor) {
            mask |= DESC_HAS_VALUE;
            [vk, a, b, c, raw] = bridge.encodeHostInline(descriptor.value);
          }
          return Boolean(
            bridge.getGuestRef('prop').applySync(undefined, [
              OP_DEFINE, guestId, pKind, pVal, pDesc, mask, vk, a, b, c, raw,
            ]),
          );
        } finally {
          bridge.h2gPushCursor = saved;
        }
      },

      apply(_t, thisArg, argList) {
        const slot = bridge.allocHostSlot();
        let thisKind = 0, thisA = 0, thisB = 0;
        if (thisArg !== undefined && thisArg !== null && thisArg !== globalThis && isObjectLike(thisArg)) {
          const gid = bridge.hostProxyToGuestId.get(thisArg);
          if (gid !== undefined) {
            thisKind = 1;
            thisA = gid;
          } else {
            thisKind = 2;
            thisA = bridge.registerHostObj(thisArg);
            thisB = bridge.getObjFlags(thisArg);
          }
        }
        const saved = bridge.h2gPushCursor;
        try {
          const wire: WireValue[] = [slot << 1, guestId, thisKind, thisA, thisB, argList.length];
          bridge.encodeHostArgsForGuest(argList, wire);
          return bridge.decodeGuestSlotReturn(
            slot,
            bridge.getGuestRef('call').applySync(undefined, wire),
          );
        } finally {
          bridge.h2gPushCursor = saved;
          bridge.hostFreeSlots.push(slot);
        }
      },

      construct(_t, argList) {
        const slot = bridge.allocHostSlot();
        const saved = bridge.h2gPushCursor;
        try {
          const wire: WireValue[] = [(slot << 1) | 1, guestId, 0, 0, 0, argList.length];
          bridge.encodeHostArgsForGuest(argList, wire);
          const res = bridge.decodeGuestSlotReturn(
            slot,
            bridge.getGuestRef('call').applySync(undefined, wire),
          );
          if (!isObjectLike(res)) throw new TypeError('Guest constructor did not return an object');
          return res;
        } finally {
          bridge.h2gPushCursor = saved;
          bridge.hostFreeSlots.push(slot);
        }
      },
    });

    this.guestIdToProxy.set(guestId, new WeakRef(proxy));
    this.hostProxyToGuestId.set(proxy, guestId);
    this.guestFinalizer.register(proxy, guestId);
    return proxy;
  }
}