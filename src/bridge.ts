import { Buffer } from 'buffer';
import ivm from 'isolated-vm';

const OP_GET = 0;
const OP_SET = 1;
const OP_APPLY = 2;
const OP_CONSTRUCT = 3;
const OP_KEYS = 4;
const OP_ADOPT = 5;
const OP_SELF_RESOLVED = 6;
const OP_SELF_REJECTED = 7;

interface BridgeRef {
  __bridge_ref_id: number;
}

interface SelfRef {
  __self_ref_id: number;
  args?: unknown[];
}

interface HostSelfRefWrapper extends Function {
  __sbx_fn_id?: number;
}

type WriteBackEntry = [id: number, val: unknown];

interface BridgeDescriptor {
  __b: 'val' | 'ref' | 'promise' | 'self-ref' | 'sbx-fn';
  __bridge_ref_id?: number;
  __self_ref_id?: number;
  val?: unknown;
  kind?: 'class' | 'function' | 'array' | 'object';
  args?: unknown[];
  wb?: WriteBackEntry[];
}

interface AdoptedEntry {
  id: number;
  kind: 'ta' | 'ab' | 'obj';
  raw: unknown;
  proxyOrView: unknown;
  view?: Buffer;
  shadow?: Buffer;
  sampleOffsets?: [number, number, number];
  dirty: boolean;
}

interface PendingPromiseEntry {
  promise: PromiseLike<unknown>;
  tracked: AdoptedEntry[];
}

export default class IvmContextBridge {
  private readonly context: ivm.Context;
  private readonly idToObj = new Map<number, unknown>();
  private readonly objToId = new WeakMap<WeakKey, number>();
  private readonly adoptedRefs = new Map<number, AdoptedEntry>();
  private readonly pendingPromises = new Map<number, PendingPromiseEntry>();
  private readonly boundMethodCache = new WeakMap<
    object,
    Map<string, Function>
  >();
  private readonly pendingSelfRef = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  private sandboxEntry?: (id: number, payload: unknown) => unknown;
  private nextId = 1;
  private state = 0;
  private syncDepth = 0;

  constructor(context: ivm.Context) {
    this.context = context;
  }

  private registerHost(target: unknown): number {
    const existing = this.objToId.get(target as WeakKey);
    if (existing !== undefined) return existing;
    const id = this.nextId++;
    this.idToObj.set(id, target);
    this.objToId.set(target as WeakKey, id);
    return id;
  }

  private isThenable(val: unknown): val is PromiseLike<unknown> {
    return (
      val !== null &&
      (typeof val === 'object' || typeof val === 'function') &&
      typeof (val as Record<string, unknown>).then === 'function'
    );
  }

  private isPlainObject(val: unknown): boolean {
    if (typeof val !== 'object' || val === null) return false;
    const proto = Object.getPrototypeOf(val);
    return proto === null || proto === Object.prototype;
  }

  private isPlainDataObject(val: Record<string, unknown>): boolean {
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i++) {
      if (typeof val[keys[i]] === 'function') return false;
    }
    return true;
  }

  /**
   * 同步 Callback ($1) 回傳包裝：
   * 無附帶 WriteBack 的原始型別直接回傳，交由 C++ CopyIfPrimitive 零配置處理。
   */
  private toGuestSyncReturn(
    val: unknown,
    tracked?: AdoptedEntry[]
  ): unknown {
    if (this.isThenable(val)) {
      const promiseId = this.nextId++;
      this.pendingPromises.set(promiseId, {
        promise: val,
        tracked: tracked ?? []
      });
      return new ivm.ExternalCopy({
        __b: 'promise',
        __bridge_ref_id: promiseId
      }).copyInto({ release: true });
    }

    const wb =
      tracked && tracked.length > 0
        ? this.collectWriteBacks(tracked)
        : undefined;

    if (!wb) {
      if (val === null || val === undefined) return val;
      const t = typeof val;
      if (t === 'string' || t === 'number' || t === 'boolean') return val;
    }

    return new ivm.ExternalCopy(this.toGuestDescriptor(val, wb)).copyInto({
      release: true
    });
  }

  /**
   * 非同步 Reference ($0) 回傳包裝：
   * 搭配 { result: { promise: true, copy: true } }，純資料與 ArrayBuffer 可直接穿透回傳。
   */
  private toGuestAsyncReturn(
    val: unknown,
    tracked?: AdoptedEntry[]
  ): unknown {
    const wb =
      tracked && tracked.length > 0
        ? this.collectWriteBacks(tracked)
        : undefined;

    if (!wb) {
      if (val === null || val === undefined) return val;
      const t = typeof val;
      if (
        t === 'string' ||
        t === 'number' ||
        t === 'boolean' ||
        t === 'bigint'
      ) {
        return val;
      }
      if (val instanceof ArrayBuffer || val instanceof Uint8Array) {
        return val;
      }
    }

    return this.toGuestDescriptor(val, wb);
  }

  private toGuestDescriptor(
    val: unknown,
    wb?: WriteBackEntry[]
  ): BridgeDescriptor | unknown {
    if (val === null || val === undefined) {
      return wb ? { __b: 'val', val, wb } : val;
    }
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
      return wb ? { __b: 'val', val, wb } : val;
    }

    if (t === 'function' && (val as HostSelfRefWrapper).__sbx_fn_id !== undefined) {
      return {
        __b: 'sbx-fn',
        __self_ref_id: (val as HostSelfRefWrapper).__sbx_fn_id,
        wb
      };
    }

    if (this.isThenable(val)) {
      const promiseId = this.nextId++;
      this.pendingPromises.set(promiseId, {
        promise: val,
        tracked: []
      });
      return {
        __b: 'promise',
        __bridge_ref_id: promiseId,
        wb
      };
    }

    const existingId = this.objToId.get(val as WeakKey);
    if (existingId !== undefined && this.adoptedRefs.has(existingId)) {
      return {
        __b: 'ref',
        __bridge_ref_id: existingId,
        kind: 'object',
        wb
      };
    }

    const isView = ArrayBuffer.isView(val);
    if (
      isView ||
      val instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' &&
        val instanceof SharedArrayBuffer)
    ) {
      const out = isView
        ? new Uint8Array(
            (val as ArrayBufferView).buffer,
            (val as ArrayBufferView).byteOffset,
            (val as ArrayBufferView).byteLength
          )
        : val;
      return { __b: 'val', val: out, wb };
    }

    if (
      this.isPlainObject(val) &&
      this.isPlainDataObject(val as Record<string, unknown>)
    ) {
      if ((val as SelfRef).__self_ref_id !== undefined) {
        return { __b: 'self-ref', ...(val as SelfRef), wb };
      }
      return { __b: 'val', val, wb };
    }

    const isFn = t === 'function';
    const isClass =
      isFn && /^class\s/.test(Function.prototype.toString.call(val));
    const isArr = Array.isArray(val);

    return {
      __b: 'ref',
      __bridge_ref_id: this.registerHost(val),
      kind: isClass ? 'class' : isFn ? 'function' : isArr ? 'array' : 'object',
      wb
    };
  }

  private toHost(arg: unknown, trackedEntries?: AdoptedEntry[]): unknown {
    if (arg && typeof arg === 'object') {
      const refId = (arg as BridgeRef).__bridge_ref_id;
      if (refId !== undefined) {
        const adopted = this.adoptedRefs.get(refId);
        if (adopted !== undefined) {
          if (trackedEntries) trackedEntries.push(adopted);
          return adopted.proxyOrView;
        }
        return this.idToObj.get(refId);
      }

      const selfRefId = (arg as SelfRef).__self_ref_id;
      if (selfRefId !== undefined) {
        const wrapper: HostSelfRefWrapper = (...params: unknown[]) => {
          const args = new Array<unknown>(params.length);
          for (let i = 0; i < params.length; i++) {
            args[i] = this.toGuestDescriptor(params[i]);
          }
          if (this.syncDepth > 0) {
            return { __self_ref_id: selfRefId, args };
          }
          try {
            return this.applySelfRef(selfRefId, args);
          } catch {
            return { __self_ref_id: selfRefId, args };
          }
        };
        wrapper.__sbx_fn_id = selfRefId;
        return wrapper;
      }
    }
    return arg;
  }

  private createBufferEntry(
    id: number,
    kind: 'ta' | 'ab',
    rawVal: unknown,
    view: Buffer
  ): AdoptedEntry {
    const len = view.byteLength;
    if (len <= 4096) {
      return {
        id,
        kind,
        raw: rawVal,
        proxyOrView: rawVal,
        view,
        shadow: Buffer.from(view),
        dirty: false
      };
    }
    const mid = (len >> 1) - 8;
    const end = len - 24;
    const shadow = Buffer.allocUnsafe(64);
    view.copy(shadow, 0, 0, 24);
    view.copy(shadow, 24, mid, mid + 16);
    view.copy(shadow, 40, end, end + 24);
    return {
      id,
      kind,
      raw: rawVal,
      proxyOrView: rawVal,
      view,
      shadow,
      sampleOffsets: [0, mid, end],
      dirty: false
    };
  }

  private isBufferModified(entry: AdoptedEntry): boolean {
    const view = entry.view!;
    const shadow = entry.shadow!;
    const offsets = entry.sampleOffsets;
    if (!offsets) {
      if (!view.equals(shadow)) {
        shadow.set(view);
        return true;
      }
      return false;
    }
    const [o0, o1, o2] = offsets;
    if (
      view.compare(shadow, 0, 24, o0, o0 + 24) !== 0 ||
      view.compare(shadow, 24, 40, o1, o1 + 16) !== 0 ||
      view.compare(shadow, 40, 64, o2, o2 + 24) !== 0
    ) {
      view.copy(shadow, 0, o0, o0 + 24);
      view.copy(shadow, 24, o1, o1 + 16);
      view.copy(shadow, 40, o2, o2 + 24);
      return true;
    }
    return false;
  }

  private adoptGuestValue(rawVal: unknown): number {
    const id = this.nextId++;

    if (ArrayBuffer.isView(rawVal)) {
      const v = rawVal as ArrayBufferView;
      const view = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      const entry = this.createBufferEntry(id, 'ta', rawVal, view);
      this.adoptedRefs.set(id, entry);
      this.idToObj.set(id, rawVal);
      this.objToId.set(rawVal as WeakKey, id);
      return id;
    }

    if (rawVal instanceof ArrayBuffer) {
      const view = Buffer.from(rawVal);
      const entry = this.createBufferEntry(id, 'ab', rawVal, view);
      this.adoptedRefs.set(id, entry);
      this.idToObj.set(id, rawVal);
      this.objToId.set(rawVal as WeakKey, id);
      return id;
    }

    const hydrated = this.rehydrate(rawVal) as Record<string, unknown>;
    const entry: AdoptedEntry = {
      id,
      kind: 'obj',
      raw: hydrated,
      proxyOrView: hydrated,
      dirty: false
    };

    const proxy = new Proxy(hydrated, {
      set(target, prop, value) {
        entry.dirty = true;
        target[prop as string] = value;
        return true;
      },
      deleteProperty(target, prop) {
        entry.dirty = true;
        delete target[prop as string];
        return true;
      }
    });

    entry.proxyOrView = proxy;
    this.adoptedRefs.set(id, entry);
    this.idToObj.set(id, proxy);
    this.objToId.set(proxy as WeakKey, id);
    return id;
  }

  private toSyncValue(val: unknown): unknown {
    if (ArrayBuffer.isView(val)) {
      const v = val as ArrayBufferView;
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (val instanceof ArrayBuffer) {
      return new Uint8Array(val);
    }
    return this.toPlainSnapshot(val);
  }

  private toPlainSnapshot(val: unknown): unknown {
    if (val === null || val === undefined) return val;
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
      return val;
    }
    if (ArrayBuffer.isView(val)) {
      const v = val as ArrayBufferView;
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (val instanceof ArrayBuffer) {
      return new Uint8Array(val);
    }
    if (Array.isArray(val)) {
      const out = new Array(val.length);
      for (let i = 0; i < val.length; i++) {
        out[i] = this.toPlainSnapshot(val[i]);
      }
      return out;
    }
    if (t === 'object') {
      const src = val as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const keys = Object.keys(src);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        out[k] = this.toPlainSnapshot(src[k]);
      }
      return out;
    }
    return undefined;
  }

  private rehydrate(val: unknown): unknown {
    if (val === null || val === undefined) return val;
    if (ArrayBuffer.isView(val) || val instanceof ArrayBuffer) return val;
    if (Array.isArray(val)) {
      const out = new Array(val.length);
      for (let i = 0; i < val.length; i++) {
        out[i] = this.rehydrate(val[i]);
      }
      return out;
    }
    if (typeof val === 'object') {
      const v = val as Record<string, unknown>;
      const keys = Object.keys(v);
      if (
        keys.length === 1 &&
        (v.__bridge_ref_id !== undefined || v.__self_ref_id !== undefined)
      ) {
        return this.toHost(v);
      }
      const out: Record<string, unknown> = {};
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        out[k] = this.rehydrate(v[k]);
      }
      return out;
    }
    return val;
  }

  private applySelfRef(id: number, descs: unknown[]): unknown {
    const runner = this.sandboxEntry;
    if (!runner) {
      throw new Error('[Bridge] sandboxEntry not initialized');
    }
    const out = runner(
      id,
      new ivm.ExternalCopy(descs).copyInto({ release: true })
    );
    const marker =
      out && typeof out === 'object'
        ? (out as { __self_ref_pending?: number })
        : null;
    if (marker && marker.__self_ref_pending !== undefined) {
      const pendingId = marker.__self_ref_pending;
      return new Promise((resolve, reject) => {
        this.pendingSelfRef.set(pendingId, { resolve, reject });
      });
    }
    return out;
  }

  private collectWriteBacks(
    tracked: AdoptedEntry[]
  ): WriteBackEntry[] | undefined {
    let wb: WriteBackEntry[] | undefined;
    for (let i = 0; i < tracked.length; i++) {
      const entry = tracked[i];
      if (entry.kind === 'obj') {
        if (entry.dirty) {
          entry.dirty = false;
          if (!wb) wb = [];
          wb.push([entry.id, this.toSyncValue(entry.raw)]);
        }
      } else if (entry.view && entry.shadow && this.isBufferModified(entry)) {
        if (!wb) wb = [];
        wb.push([
          entry.id,
          new Uint8Array(
            entry.view.buffer,
            entry.view.byteOffset,
            entry.view.byteLength
          )
        ]);
      }
    }
    return wb;
  }

  public async init(): Promise<void> {
    const asyncDispatch = new ivm.Reference(
      async (
        targetId: number,
        propOrPromiseId: string | number | null,
        argsRef?: unknown[] | null
      ) => {
        if (targetId === 0) {
          const promiseId = propOrPromiseId as number;
          const entry = this.pendingPromises.get(promiseId);
          if (!entry) {
            throw new Error(`Promise reference [${promiseId}] not found.`);
          }
          this.pendingPromises.delete(promiseId);
          const val = await entry.promise;
          return this.toGuestAsyncReturn(val, entry.tracked);
        }

        const target = this.idToObj.get(targetId);
        if (!target) {
          throw new Error(`[Bridge] Reference ID ${targetId} not found.`);
        }
        const fn =
          propOrPromiseId !== null
            ? (target as Record<string, unknown>)[propOrPromiseId as string]
            : target;
        if (typeof fn !== 'function') {
          throw new TypeError(
            `[Bridge] Property '${String(propOrPromiseId)}' is not a function.`
          );
        }

        const tracked: AdoptedEntry[] = [];
        const len = argsRef ? argsRef.length : 0;
        const thisArg =
          len > 0 && argsRef![0] !== null && argsRef![0] !== undefined
            ? this.toHost(argsRef![0], tracked)
            : target;

        const callArgs = new Array(len > 1 ? len - 1 : 0);
        for (let i = 1; i < len; i++) {
          callArgs[i - 1] = this.toHost(argsRef![i], tracked);
        }

        const result = await Reflect.apply(fn, thisArg, callArgs);
        return this.toGuestAsyncReturn(result, tracked);
      }
    );

    const syncDispatch = new ivm.Callback(
      (
        op: number,
        targetId: number,
        prop: string | null,
        argsRef?: unknown[]
      ) => {
        this.syncDepth++;
        try {
          if (op === OP_ADOPT) {
            return this.adoptGuestValue(argsRef ? argsRef[0] : undefined);
          }

          if (op === OP_SELF_RESOLVED) {
            const pending = this.pendingSelfRef.get(targetId);
            if (pending) {
              this.pendingSelfRef.delete(targetId);
              pending.resolve(
                argsRef && argsRef.length ? this.toHost(argsRef[0]) : undefined
              );
            }
            return true;
          }

          if (op === OP_SELF_REJECTED) {
            const pending = this.pendingSelfRef.get(targetId);
            if (pending) {
              this.pendingSelfRef.delete(targetId);
              pending.reject(
                new Error(
                  argsRef && argsRef.length
                    ? String(argsRef[0])
                    : 'self-ref rejected'
                )
              );
            }
            return true;
          }

          const target = this.idToObj.get(targetId);
          if (!target) {
            throw new Error(`[Bridge] Reference ID ${targetId} not found.`);
          }

          if (
            prop === '__proto__' ||
            prop === 'prototype' ||
            prop === 'constructor'
          ) {
            return undefined;
          }

          switch (op) {
            case OP_GET: {
              let val = (target as Record<string, unknown>)[prop!];
              if (
                typeof val === 'function' &&
                target != null &&
                target !== globalThis
              ) {
                let methodMap = this.boundMethodCache.get(target as object);
                if (!methodMap) {
                  methodMap = new Map();
                  this.boundMethodCache.set(target as object, methodMap);
                }
                let bound = methodMap.get(prop!);
                if (!bound) {
                  bound = (val as Function).bind(target);
                  methodMap.set(prop!, bound!);
                }
                val = bound;
              }
              return this.toGuestSyncReturn(val);
            }

            case OP_SET: {
              const val =
                argsRef && argsRef.length ? this.toHost(argsRef[0]) : undefined;
              (target as Record<string, unknown>)[prop!] = val;
              return true;
            }

            case OP_APPLY: {
              const fn =
                prop !== null
                  ? (target as Record<string, unknown>)[prop]
                  : target;
              if (typeof fn !== 'function') {
                throw new TypeError(
                  `[Bridge] Property '${String(prop)}' is not a function.`
                );
              }

              const tracked: AdoptedEntry[] = [];
              const len = argsRef ? argsRef.length : 0;
              const thisArg =
                len > 0 && argsRef![0] !== null && argsRef![0] !== undefined
                  ? this.toHost(argsRef![0], tracked)
                  : target;

              const callArgs = new Array(len > 1 ? len - 1 : 0);
              for (let i = 1; i < len; i++) {
                callArgs[i - 1] = this.toHost(argsRef![i], tracked);
              }

              const result = Reflect.apply(fn, thisArg, callArgs);
              return this.toGuestSyncReturn(result, tracked);
            }

            case OP_CONSTRUCT: {
              const tracked: AdoptedEntry[] = [];
              const len = argsRef ? argsRef.length : 0;
              const callArgs = new Array(len);
              for (let i = 0; i < len; i++) {
                callArgs[i] = this.toHost(argsRef![i], tracked);
              }
              const result = Reflect.construct(target as Function, callArgs);
              return this.toGuestSyncReturn(result, tracked);
            }

            case OP_KEYS: {
              return new ivm.ExternalCopy({
                __b: 'val',
                val: Object.keys(target as object)
              }).copyInto({ release: true });
            }

            default:
              throw new Error(`[Bridge] Unknown op: ${op}`);
          }
        } finally {
          this.syncDepth--;
        }
      }
    );

    this.state = 1;

    this.sandboxEntry = (await this.context.evalClosure(
      `
      const OP_GET = 0;
      const OP_SET = 1;
      const OP_APPLY = 2;
      const OP_CONSTRUCT = 3;
      const OP_KEYS = 4;
      const OP_ADOPT = 5;
      const OP_SELF_RESOLVED = 6;
      const OP_SELF_REJECTED = 7;

      const proxyCache = new Map();
      const functionCache = new Map();
      const fnToSelfId = new WeakMap();
      let nextId = 1;

      const liveRefs = new Map();
      const liveRefTokens = new WeakMap();

      const ASYNC_RESOLVE_OPTS = { result: { promise: true, copy: true } };
      const ASYNC_CALL_OPTS = { arguments: { copy: true }, result: { promise: true, copy: true } };

      function mergeInto(dst, src) {
        if (src === null || src === undefined || typeof src !== 'object') return;
        if (Array.isArray(src)) {
          for (let i = 0; i < src.length; i++) dst[i] = src[i];
          while (dst.length > src.length) dst.length--;
          return;
        }
        const keys = Object.keys(src);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const cur = dst[key];
          if (!cur || !(cur.__bridge_ref_id || ArrayBuffer.isView(cur))) {
            dst[key] = src[key];
          }
        }
      }

      function applyWriteBacks(wb) {
        for (let i = 0; i < wb.length; i++) {
          const entry = wb[i];
          const original = liveRefs.get(entry[0]);
          if (!original) continue;
          const snap = entry[1];
          if (ArrayBuffer.isView(original)) {
            if (ArrayBuffer.isView(snap)) {
              new Uint8Array(original.buffer, original.byteOffset, original.byteLength).set(snap);
            }
          } else if (original instanceof ArrayBuffer) {
            if (ArrayBuffer.isView(snap)) {
              new Uint8Array(original).set(snap);
            }
          } else {
            mergeInto(original, snap);
          }
        }
      }

      function registerSandboxFn(fn) {
        let token = fnToSelfId.get(fn);
        if (token === undefined) {
          const id = nextId++;
          functionCache.set(id, fn);
          token = { __self_ref_id: id };
          fnToSelfId.set(fn, token);
        }
        return token;
      }

      function tryGetRef(val) {
        if (val === null || val === undefined) return [val];
        const t = typeof val;
        if (t !== 'object' && t !== 'function') return [val];
        if (val.__bridge_ref_id !== undefined) {
          return [{ __bridge_ref_id: val.__bridge_ref_id }];
        }
        if (t === 'function') {
          return [registerSandboxFn(val)];
        }
        return null;
      }

      function clean(val) {
        const ref = tryGetRef(val);
        if (ref) return ref[0];
        if (ArrayBuffer.isView(val) || val instanceof ArrayBuffer) return val;
        if (Array.isArray(val)) {
          const out = new Array(val.length);
          for (let i = 0; i < val.length; i++) out[i] = clean(val[i]);
          return out;
        }
        if (typeof val === 'object') {
          const out = {};
          const keys = Object.keys(val);
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            out[k] = clean(val[k]);
          }
          return out;
        }
        return val;
      }

      function packArg(val) {
        if (val === null || val === undefined) return val;
        const t = typeof val;
        if (t !== 'object' && t !== 'function') return val;
        if (val.__bridge_ref_id !== undefined) {
          return { __bridge_ref_id: val.__bridge_ref_id };
        }
        if (t === 'function') {
          return registerSandboxFn(val);
        }
        let token = liveRefTokens.get(val);
        if (token === undefined) {
          const hostId = $1(OP_ADOPT, 0, null, [clean(val)]);
          token = { __bridge_ref_id: hostId };
          liveRefTokens.set(val, token);
          liveRefs.set(hostId, val);
        }
        return token;
      }

      function createProxy(desc) {
        if (desc === null || desc === undefined || typeof desc !== 'object') {
          return desc;
        }
        const tag = desc.__b;
        if (!tag) return desc;

        if (desc.wb) applyWriteBacks(desc.wb);

        if (tag === 'val') return desc.val;

        if (tag === 'sbx-fn') {
          return functionCache.get(desc.__self_ref_id);
        }

        if (tag === 'ref') {
          const refId = desc.__bridge_ref_id;
          if (liveRefs.has(refId)) return liveRefs.get(refId);
          if (proxyCache.has(refId)) return proxyCache.get(refId);
        }

        if (tag === 'self-ref' && functionCache.has(desc.__self_ref_id)) {
          const func = functionCache.get(desc.__self_ref_id);
          const rawArgs = desc.args;
          if (!rawArgs || rawArgs.length === 0) return func();
          const args = new Array(rawArgs.length);
          for (let i = 0; i < rawArgs.length; i++) args[i] = createProxy(rawArgs[i]);
          return func(...args);
        }

        if (tag === 'promise') {
          return $0
            .apply(undefined, [0, desc.__bridge_ref_id, null], ASYNC_RESOLVE_OPTS)
            .then(createProxy);
        }

        let dummy;
        if (desc.kind === 'function' || desc.kind === 'class') {
          dummy = function() {};
        } else if (desc.kind === 'array') {
          dummy = [];
        } else {
          dummy = {};
        }

        const refId = desc.__bridge_ref_id;
        const propCache = Object.create(null);
        let isAsyncFn = false;

        function methodFor(prop, fnId, receiverProxy) {
          let cached = propCache[prop];
          if (cached !== undefined) return cached;

          let isAsyncMethod = false;

          cached = function() {
            const len = arguments.length;
            if (new.target) {
              const safeArgs = new Array(len);
              for (let i = 0; i < len; i++) safeArgs[i] = packArg(arguments[i]);
              return createProxy($1(OP_CONSTRUCT, fnId, null, safeArgs));
            }
            const packedPayload = new Array(len + 1);
            packedPayload[0] = (this && this !== globalThis && this !== receiverProxy) ? packArg(this) : null;
            for (let i = 0; i < len; i++) {
              packedPayload[i + 1] = packArg(arguments[i]);
            }
            if (isAsyncMethod) {
              return $0
                .apply(undefined, [refId, prop, packedPayload], ASYNC_CALL_OPTS)
                .then(createProxy);
            }
            const rawRes = $1(OP_APPLY, refId, prop, packedPayload);
            if (rawRes && typeof rawRes === 'object' && rawRes.__b === 'promise') {
              isAsyncMethod = true;
            }
            return createProxy(rawRes);
          };
          cached.__bridge_ref_id = fnId;
          propCache[prop] = cached;
          return cached;
        }

        const proxy = new Proxy(dummy, {
          get(_target, prop) {
            if (prop === '__bridge_ref_id') return refId;
            if (prop === 'then' || typeof prop === 'symbol') return undefined;

            const cached = propCache[prop];
            if (cached !== undefined) return cached;

            const res = $1(OP_GET, refId, prop, null);
            if (res && typeof res === 'object' && res.__b === 'ref') {
              if (res.kind === 'function') {
                return methodFor(prop, res.__bridge_ref_id, proxy);
              }
              const objProxy = createProxy(res);
              propCache[prop] = objProxy;
              return objProxy;
            }
            return createProxy(res);
          },
          set(_target, prop, val) {
            if (typeof prop !== 'symbol') delete propCache[prop];
            $1(OP_SET, refId, prop, [packArg(val)]);
            return true;
          },
          apply(_target, thisArg, argList) {
            const len = argList.length;
            const packedPayload = new Array(len + 1);
            packedPayload[0] = (thisArg && thisArg !== globalThis) ? packArg(thisArg) : null;
            for (let i = 0; i < len; i++) {
              packedPayload[i + 1] = packArg(argList[i]);
            }
            if (isAsyncFn) {
              return $0
                .apply(undefined, [refId, null, packedPayload], ASYNC_CALL_OPTS)
                .then(createProxy);
            }
            const rawRes = $1(OP_APPLY, refId, null, packedPayload);
            if (rawRes && typeof rawRes === 'object' && rawRes.__b === 'promise') {
              isAsyncFn = true;
            }
            return createProxy(rawRes);
          },
          construct(_target, argList) {
            const len = argList.length;
            const safeArgs = new Array(len);
            for (let i = 0; i < len; i++) safeArgs[i] = packArg(argList[i]);
            return createProxy($1(OP_CONSTRUCT, refId, null, safeArgs));
          },
          ownKeys() {
            const res = $1(OP_KEYS, refId, null, null);
            return res.val;
          }
        });

        proxyCache.set(refId, proxy);
        return proxy;
      }

      return (id, payload) => {
        if (id === 0) {
          for (let i = 0; i < payload.length; i += 2) {
            globalThis[payload[i]] = createProxy(payload[i + 1]);
          }
          return;
        }
        const fn = functionCache.get(id);
        if (!fn) throw new Error('[Bridge] self-ref [' + id + '] not found.');
        const len = payload ? payload.length : 0;
        const args = new Array(len);
        for (let i = 0; i < len; i++) args[i] = createProxy(payload[i]);
        const out = fn(...args);
        if (out && typeof out === 'object' && typeof out.then === 'function') {
          out.then(
            v => $1(OP_SELF_RESOLVED, id, null, [packArg(v)]),
            e => $1(OP_SELF_REJECTED, id, null, [String(e && (e.stack || e.message || e))])
          );
          return { __self_ref_pending: id };
        }
        return out;
      };
    `,
      [asyncDispatch, syncDispatch]
    )) as (id: number, payload: unknown) => unknown;
  }

  public async exposeToGlobal(
    target: Record<string, unknown>
  ): Promise<void> {
    if (this.state === 2) {
      throw new Error('Bridge has been disposed');
    }
    const keys = Object.keys(target);
    if (!keys.length) return;
    if (!this.state) {
      await this.init();
    }
    const payload = new Array<unknown>(keys.length * 2);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      payload[i * 2] = k;
      payload[i * 2 + 1] = this.toGuestDescriptor(target[k]);
    }
    this.sandboxEntry!(
      0,
      new ivm.ExternalCopy(payload).copyInto({ release: true })
    );
  }

  public dispose(): void {
    this.sandboxEntry = undefined;
    this.idToObj.clear();
    this.adoptedRefs.clear();
    this.pendingPromises.clear();
    this.pendingSelfRef.clear();
    this.state = 2;
  }
}