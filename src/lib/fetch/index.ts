import ivm from "isolated-vm";
import { COMMON } from "./common";
import { HEADERS } from "./headers";
import { ABORT } from "./abort";
import { RESPONSE } from "./response";
import { BLOB } from "./blob";
import { FORMDATA } from "./formdata";

// Limits for the host-side `fetch` bridge. The isolate has no network stack of its own,
// so every request is performed by the host process, which enforces these same bounds.
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_BODY_BYTES = 8 * 1024 * 1024;

/** Discriminated message the isolate sends over the injected fetch `Reference`. */
type FetchRequest = { action: "fetch"; id: number } & Request | { action: "abort"; id: number };

/** What comes back across the boundary: a fully buffered response or a transport failure. */
type FetchReply =
  | {
    ok: true;
    url: string;
    status: number;
    statusText: string;
    headers: [string, string][];
    redirected: boolean;
    body: Uint8Array;
  }
  | { ok: false; name: string; error: string };

/** Keeps undici's `fetch failed` wrapper and its usually more useful `cause` together. */
function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

/** Reads a whole response body into one buffer, refusing anything past the shared cap. */
async function readFetchBody(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FETCH_BODY_BYTES) {
          throw new Error(`Response body exceeded the ${MAX_FETCH_BODY_BYTES}-byte fetch limit.`);
        }
        chunks.push(value);
      }
    } finally {
      // Frees the connection when the size cap aborts the read early.
      reader.cancel().catch(() => { /* nothing left to read */ });
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Builds the host half of the `fetch` bridge: the function the isolate calls through the
 * injected `Reference`. State is per run, so one call's in-flight requests can be cancelled
 * without ever touching another call's, and nothing survives the run.
 */
function createFetchHandler(): (request: FetchRequest) => Promise<FetchReply | null> {
  const inFlight = new Map<number, AbortController>();

  return async (request: FetchRequest): Promise<FetchReply | null> => {
    if (request.action === "abort") {
      inFlight.get(request.id)?.abort();
      return null;
    }

    const controller = new AbortController();
    inFlight.set(request.id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    timer.unref();

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: request.redirect,
        signal: controller.signal,
      });

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_FETCH_BODY_BYTES) {
        throw new Error(
          `Response declared ${declared} bytes, over the ${MAX_FETCH_BODY_BYTES}-byte fetch limit.`
        );
      }

      return {
        ok: true,
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers) as [string, string][],
        redirected: response.redirected,
        body: await readFetchBody(response),
      };
    } catch (error) {
      if (timedOut) {
        return { ok: false, name: "TimeoutError", error: `fetch timed out after ${FETCH_TIMEOUT_MS}ms.` };
      }
      if (controller.signal.aborted) {
        return { ok: false, name: "AbortError", error: describeFetchFailure(error) };
      }
      // Real `fetch` rejects with a TypeError for every transport-level failure, so keep
      // that contract even when the underlying error is something else.
      return { ok: false, name: "TypeError", error: describeFetchFailure(error) };
    } finally {
      clearTimeout(timer);
      inFlight.delete(request.id);
    }
  };
}

/**
 * Runs inside the isolate before the user code. It builds a small `console` that forwards
 * everything to the host process, a `fetch` shim (plus the `Headers`, `Response`, and
 * `AbortController` pieces it needs) wired to the host's network.
 */
const FETCH = String.raw`
((hostFetchRef, MAX_FETCH_BODY_BYTES) => {
  var nextFetchId = 0;

  var encodeFetchBody = function (body) {
    if (body === undefined || body === null) return { bytes: undefined, wasString: false };
    if (typeof body === "string") return { bytes: encoder.encode(body), wasString: true };
    if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body), wasString: false };
    if (ArrayBuffer.isView(body)) {
      return { bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), wasString: false };
    }
    // A Blob sends its raw bytes under its own MIME type; a FormData is encoded as multipart.
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return { bytes: blobBytes(body), wasString: false, contentType: blobType(body) || undefined };
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      var multipart = encodeFormData(body);
      return { bytes: multipart.bytes, wasString: false, contentType: multipart.contentType };
    }
    // Anything else is stringified, matching the BodyInit conversion in the fetch spec.
    return { bytes: encoder.encode(String(body)), wasString: true };
  };

  /**
   * fetch shim: everything runs in the isolate except the request itself, which is
   * performed by the host process through hostFetchRef. The returned promise settles
   * exactly once; aborting a request also cancels it host-side and discards the reply.
   */
  var fetch = function (input, init) {
    return new Promise(function (resolve, reject) {
      var url;
      var template = null;
      if (typeof input === "string") {
        url = input;
      } else if (input && typeof input === "object" && typeof input.url === "string") {
        template = input;
        url = input.url;
      } else {
        reject(new TypeError("fetch: input must be a URL string or an object with a string url property"));
        return;
      }

      var pick = function (key, fallback) {
        if (init && typeof init === "object" && Object.prototype.hasOwnProperty.call(init, key)) {
          return init[key];
        }
        if (template && template[key] !== undefined) return template[key];
        return fallback;
      };

      var method = pick("method", "GET");
      if (typeof method !== "string") {
        reject(new TypeError("fetch: method must be a string"));
        return;
      }
      method = method.toUpperCase();

      var redirect = pick("redirect", "follow");
      if (redirect !== "follow" && redirect !== "error" && redirect !== "manual") {
        reject(new TypeError("fetch: redirect must be one of follow, error or manual"));
        return;
      }

      var signal = pick("signal", undefined);
      if (signal !== undefined && signal !== null && !signalSlots.has(signal)) {
        reject(new TypeError("fetch: signal must be an AbortSignal"));
        return;
      }
      if (signal && signal.aborted) {
        reject(signal.reason);
        return;
      }

      var encoded = encodeFetchBody(pick("body", undefined));
      if (encoded.bytes !== undefined) {
        if (method === "GET" || method === "HEAD") {
          reject(new TypeError("fetch: Request with GET/HEAD method cannot have body."));
          return;
        }
        if (encoded.bytes.byteLength > MAX_FETCH_BODY_BYTES) {
          reject(new TypeError(
            "fetch: request body of " + encoded.bytes.byteLength + " bytes exceeds the " +
            MAX_FETCH_BODY_BYTES + "-byte limit"
          ));
          return;
        }
      }

      var headers = new Headers(pick("headers", undefined));
      if (!headers.has("content-type")) {
        // A Blob/FormData carries its own content-type; the spec defaults string bodies
        // to text/plain.
        if (encoded.contentType) headers.append("content-type", encoded.contentType);
        else if (encoded.wasString) headers.append("content-type", "text/plain;charset=UTF-8");
      }

      var id = ++nextFetchId;
      var settled = false;
      var cleanup = function () {
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      var onAbort = function (reason) {
        if (settled) return;
        settled = true;
        cleanup();
        // Ask the host to cancel the in-flight request; its late reply is dropped by
        // the settled guards in the handlers below.
        var noop = () => {};
        hostFetchRef.apply(undefined, [{ action: "abort", id: id }], {
          arguments: { copy: true },
          result: { promise: true, copy: true },
        }).then(noop, noop);
        reject(reason === undefined ? makeError("AbortError", "The operation was aborted") : reason);
      };
      if (signal) signal.addEventListener("abort", onAbort);

      hostFetchRef.apply(undefined, [{
        action: "fetch",
        id: id,
        url: url,
        method: method,
        headers: headerSlots.get(headers),
        body: encoded.bytes,
        redirect: redirect,
      }], {
        arguments: { copy: true },
        result: { promise: true, copy: true },
      }).then(function (reply) {
        if (settled) return;
        settled = true;
        cleanup();
        if (!reply || reply.ok !== true) {
          var name = reply && reply.name ? reply.name : "TypeError";
          reject(makeError(name, (reply && reply.error) || "fetch failed"));
          return;
        }
        resolve(new Response(reply.body, {
          status: reply.status,
          statusText: reply.statusText,
          headers: reply.headers,
          url: reply.url,
          redirected: reply.redirected,
          type: "basic",
        }));
      }, function (error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(makeError("TypeError", "fetch bridge failed: " + ((error && error.message) || error)));
      });
    });
  };

  globalThis.fetch = fetch;
})($0, $1);
`;

const SHIM = [
  COMMON,
  HEADERS,
  RESPONSE,
  ABORT,
  BLOB,
  FORMDATA,
  FETCH,
].join("\n");

// Host half of the `fetch` bridge: a Reference the bootstrap captures through
// evalClosure's `$0` (the shared body cap is `$1`), so neither ever lands on the
// isolate's global object and user code can only reach them via the `fetch` shim.
export default async function inject(context: ivm.Context) {
  await context.evalClosure(SHIM, [new ivm.Reference(createFetchHandler()), MAX_FETCH_BODY_BYTES], {
    filename: `fetch.js`,
  });
}