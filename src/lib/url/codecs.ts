/**
 * Percent-encoding, IDNA and IP-address primitives for the URL shim.
 *
 * Every export here is a chunk of JavaScript source that gets concatenated into the
 * bootstrap, not a runtime module -- the isolate has no URL parser of its own, so this
 * is part of one from-scratch WHATWG implementation.
 *
 * The embedded sources deliberately avoid backticks and dollar-brace sequences, because
 * they live inside a String.raw template literal. These outer comments avoid them too,
 * so nothing in this file can terminate a template early.
 */

/** Hex digits, upper case, for emitting percent-escapes. */
export const URL_CODECS = String.raw`
  var URL_HEX = "0123456789ABCDEF";

  // The backtick is fetched by code point so this source never contains a literal one,
  // which would terminate the enclosing String.raw template.
  var URL_BACKTICK = String.fromCharCode(96);

  // WHATWG percent-encode sets, as strings of the characters that must be escaped.
  var URL_FRAGMENT_SET = "\"<>" + URL_BACKTICK;
  var URL_QUERY_SET = "\"#<>";
  var URL_PATH_SET = "\"#<>?" + URL_BACKTICK + "{}";
  var URL_USERINFO_SET = "\"#<>?" + URL_BACKTICK + "{}/:;=@[\\]^|";
  // The C0 control set: control bytes and DEL. urlPercentEncode always escapes those,
  // so this set only exists to name the rule at the call site.
  var URL_C0_SET = "";

  var urlIsSpecial = function (scheme) {
    // The record stores the scheme WITHOUT its colon ("http"), matching the state machine
    // and the protocol getter, so every check here is bare too.
    return scheme === "ftp" || scheme === "file" || scheme === "http" ||
      scheme === "https" || scheme === "ws" || scheme === "wss";
  };

  /** Ports that are dropped from the serialized form because they are the default. */
  var URL_DEFAULT_PORTS = { "ftp": 21, "http": 80, "https": 443, "ws": 80, "wss": 443 };

  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  /**
   * Percent-encodes text, escaping every byte that is a C0 control, DEL, non-ASCII, or
   * a member of set. With spaceAsPlus, spaces become "+" instead of "%20" -- that is
   * the application/x-www-form-urlencoded convention used by URLSearchParams.
   *
   * Note that "%" itself is never escaped, so an already-encoded "%2F" passes through
   * unchanged. That is deliberate: it is how the URL parser round-trips input.
   */
  var urlPercentEncode = function (text, set, spaceAsPlus) {
    var bytes = encoder.encode(text);
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      var byte = bytes[i];
      if (byte === 0x20) {
        out += spaceAsPlus ? "+" : "%20";
      } else if (byte <= 0x1F || byte > 0x7E || set.indexOf(String.fromCharCode(byte)) !== -1) {
        out += "%" + URL_HEX[byte >> 4] + URL_HEX[byte & 15];
      } else {
        out += String.fromCharCode(byte);
      }
    }
    return out;
  };

  var urlIsHexDigit = function (code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
  };

  /**
   * Rewrites every non-ASCII code point as its percent-encoded UTF-8 bytes before the
   * state machine walks the string one charAt at a time. That keeps the whole input
   * ASCII, so surrogate pairs can never be split into lone units, and the result is
   * semantics-preserving: urlPercentEncode would escape those bytes identically anyway,
   * and the host path percent-decodes before running IDNA.
   */
  var urlPreEncodeNonAscii = function (text) {
    var out = "";
    var i = 0;
    while (i < text.length) {
      var point = text.codePointAt(i);
      if (point < 0x80) {
        out += text.charAt(i);
      } else {
        var bytes = encoder.encode(String.fromCodePoint(point));
        for (var b = 0; b < bytes.length; b++) {
          out += "%" + URL_HEX[bytes[b] >> 4] + URL_HEX[bytes[b] & 15];
        }
      }
      i += point > 0xFFFF ? 2 : 1;
    }
    return out;
  };

  /**
   * Decodes every well-formed percent-escape and leaves malformed ones alone, so a stray
   * "%" or "%zz" survives the round trip. Used for host parsing and dot-segment checks.
   */
  var urlPercentDecode = function (text) {
    var bytes = [];
    var i = 0;
    while (i < text.length) {
      if (text.charCodeAt(i) === 37 && i + 2 < text.length &&
          urlIsHexDigit(text.charCodeAt(i + 1)) && urlIsHexDigit(text.charCodeAt(i + 2))) {
        bytes.push(parseInt(text.substr(i + 1, 2), 16));
        i += 3;
        continue;
      }
      var point = text.codePointAt(i);
      var encoded = encoder.encode(String.fromCodePoint(point));
      for (var k = 0; k < encoded.length; k++) bytes.push(encoded[k]);
      i += point > 0xFFFF ? 2 : 1;
    }
    return decoder.decode(new Uint8Array(bytes));
  };

  // WHATWG "forbidden host code point": NUL, tab, LF, CR, space, and the delimiters that
  // would end the authority. Stored as code points to keep the check a single pass.
  var URL_FORBIDDEN_HOST = new Set([0, 9, 10, 13, 32, 35, 47, 58, 60, 62, 63, 64, 91, 92, 93, 94, 124]);

  /** A forbidden domain code point adds the C0 controls, "%" and DEL to the host set. */
  var urlIsForbiddenDomainCodePoint = function (code) {
    return code <= 0x1F || code === 37 || code === 127 || URL_FORBIDDEN_HOST.has(code);
  };
`;
