/**
 * The URL shim, assembled from its parts.
 *
 * The isolate ships no URL parser at all, so all of this is a from-scratch WHATWG
 * implementation. It is exported as one concatenated source string because it has to be
 * evaluated *inside* the bootstrap closure.
 *
 * Order matters: codecs first (everything else calls them), then punycode and IP parsing,
 * then the state machine, then the two classes that sit on top.
 */

import { URL_CODECS } from "./codecs";
import { URL_IP_ADDRESSES } from "./ip-addresses";
import { URL_PUNYCODE } from "./punycode";
import { URL_SEARCH_PARAMS } from "./search-params";
import { URL_STATE_MACHINE } from "./state-machine";
import { URL_CLASS } from "./url-class";
import { Context } from "isolated-vm";

const SHIM = [
  URL_CODECS,
  URL_PUNYCODE,
  URL_IP_ADDRESSES,
  URL_STATE_MACHINE,
  URL_SEARCH_PARAMS,
  URL_CLASS,
].join("\n");

export default async function inject(context: Context) {
  await context.evalClosure(SHIM, undefined, {
    filename: `url.js`,
  });
}