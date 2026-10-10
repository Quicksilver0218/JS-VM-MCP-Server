/**
 * IPv4 and IPv6 literal parsing, plus the host parser that dispatches to them, for the
 * URL shim.
 *
 * The IPv4 parser accepts the octal and hex forms the WHATWG algorithm allows
 * (0177.0.0.1, 0x7f.0.0.1) and enforces the per-part and final-part range checks.
 */

export const URL_IP_ADDRESSES = String.raw`
// IPv4
/** Parses one dot-separated part, honouring the 0x/0 octal prefixes. Null on failure. */
var urlParseIpv4Number = function (part) {
  if (part === "") return null;
  var radix = 10;
  var text = part;
  if (text.length >= 2 && text.charAt(0) === "0" && (text.charAt(1) === "x" || text.charAt(1) === "X")) {
    radix = 16;
    text = text.substring(2);
  } else if (text.length >= 2 && text.charAt(0) === "0") {
    radix = 8;
    text = text.substring(1);
  }
  if (text === "") return null;
  if (radix === 10 && !/^[0-9]+$/.test(text)) return null;
  if (radix === 16 && !/^[0-9A-Fa-f]+$/.test(text)) return null;
  if (radix === 8 && !/^[0-7]+$/.test(text)) return null;
  return parseInt(text, radix);
};

/**
 * Parses a dotted-quad into its normalized form. A trailing empty part is tolerated
 * (1.2.3.4.), but more than four parts, or an out-of-range part, is a failure.
 */
var urlParseIpv4 = function (input) {
  var parts = input.split(".");
  if (parts[parts.length - 1] === "") {
    if (parts.length > 1) parts.pop();
    else return null;
  }
  if (parts.length > 4) return null;
  var numbers = [];
  for (var i = 0; i < parts.length; i++) {
    var value = urlParseIpv4Number(parts[i]);
    if (value === null) return null;
    numbers.push(value);
  }
  // Every part but the last must fit in a byte; the last must fit the remaining room.
  for (var j = 0; j < numbers.length - 1; j++) {
    if (numbers[j] > 255) return null;
  }
  if (numbers[numbers.length - 1] >= Math.pow(256, 5 - numbers.length)) return null;
  var out = String(numbers[numbers.length - 1]);
  for (var k = numbers.length - 2; k >= 0; k--) out = numbers[k] + "." + out;
  return out;
};

/**
 * True when the host's last dot-separated part is a bare decimal number, which is the
 * signal to try the IPv4 parser instead of treating the host as a domain.
 */
var urlEndsInNumber = function (input) {
  var parts = input.split(".");
  if (parts[parts.length - 1] === "") {
    if (parts.length === 1) return false;
    parts.pop();
  }
  var last = parts[parts.length - 1];
  if (last === "") return false;
  return /^[0-9]+$/.test(last);
};

// IPv6
/**
 * Parses the inside of an IPv6 literal (no brackets) and returns its canonical text,
 * with the longest run of zeroes collapsed to "::". An embedded IPv4 tail is allowed.
 */
var urlParseIpv6 = function (input) {
  var address = [0, 0, 0, 0, 0, 0, 0, 0];
  var pieceIndex = 0;
  var compress = null;
  var i = 0;
  var length = input.length;

  // A leading "::" compresses the opening zeroes.
  if (input.charCodeAt(0) === 58) {
    if (input.charCodeAt(1) !== 58) return null;
    i = 2;
    pieceIndex = 1;
    compress = 1;
  }

  while (i < length) {
    if (pieceIndex === 8) return null;

    if (input.charCodeAt(i) === 58) {
      if (compress !== null) return null;
      compress = pieceIndex;
      i++;
      continue;
    }

    var value = 0;
    var hextets = 0;
    while (hextets < 4 && i < length && urlIsHexDigit(input.charCodeAt(i))) {
      value = value * 16 + parseInt(input.charAt(i), 16);
      i++;
      hextets++;
    }

    var c = i < length ? input.charCodeAt(i) : -1;
    if (c === 46) {
      // A dotted-quad tail: rewind over the hex digits, parse it, and pack the result
      // into two 16-bit pieces (e.g. ::ffff:1.2.3.4 serializes as ::ffff:102:304).
      if (hextets === 0) return null;
      i -= hextets;
      var end = input.indexOf(":", i);
      if (end === -1) end = length;
      var ipv4 = urlParseIpv4(input.substring(i, end));
      if (ipv4 === null) return null;
      var words = ipv4.split(".");
      if (pieceIndex + 2 > 8) return null;
      address[pieceIndex++] = (parseInt(words[0], 10) << 8) | parseInt(words[1], 10);
      address[pieceIndex++] = (parseInt(words[2], 10) << 8) | parseInt(words[3], 10);
      i = end;
      continue;
    }

    if (hextets === 0 && c !== -1) return null;
    if (c === 58) {
      i++;
      // ":::" is two compressions and therefore invalid.
      if (i < length && input.charCodeAt(i) === 58) return null;
    }
    address[pieceIndex++] = value;
  }

  if (compress !== null) {
    // Shift the trailing pieces right so the zero run sits where "::" was written.
    var swaps = pieceIndex - compress;
    pieceIndex = 7;
    while (pieceIndex !== 0 && swaps > 0) {
      var tmp = address[compress + swaps - 1];
      address[compress + swaps - 1] = address[pieceIndex];
      address[pieceIndex] = tmp;
      pieceIndex--;
      swaps--;
    }
  } else if (pieceIndex !== 8) {
    return null;
  }

  // Serialize, collapsing the longest zero run of at least two pieces.
  var best = -1;
  var bestLen = 0;
  var cur = -1;
  for (var s = 0; s < 8; s++) {
    if (address[s] === 0) {
      if (cur === -1) cur = s;
      if (s - cur + 1 > bestLen) { bestLen = s - cur + 1; best = cur; }
    } else {
      cur = -1;
    }
  }
  if (bestLen < 2) best = -1;

  var result = [];
  for (var t = 0; t < 8; t++) {
    if (best !== -1 && t >= best && t < best + bestLen) {
      if (t === best) result.push(t === 0 ? "::" : ":");
      continue;
    }
    result.push(address[t].toString(16));
    if (t < 7) result.push(":");
  }
  return result.join("");
};

// ---- host parsing ---------------------------------------------------------
/**
 * Parses a host string and returns its serialized form, or null when it cannot be a
 * host. Opaque hosts (non-special schemes) only get percent-encoded; domain hosts go
 * through IPv4, then IDNA.
 */
var urlParseHost = function (input, isOpaque) {
  if (input === "") return isOpaque ? "" : null;

  // An IPv6 literal arrives already bracketed by the caller.
  if (input.charCodeAt(0) === 91) {
    if (input.charCodeAt(input.length - 1) !== 93) return null;
    var parsed = urlParseIpv6(input.substring(1, input.length - 1));
    return parsed === null ? null : "[" + parsed + "]";
  }

  if (isOpaque) {
    for (var o = 0; o < input.length; o++) {
      if (urlIsForbiddenHostCodePoint(input.charCodeAt(o))) return null;
    }
    return urlPercentEncode(input, "", false);
  }

  var decoded = urlPercentDecode(input);
  for (var d = 0; d < decoded.length; d++) {
    if (urlIsForbiddenDomainCodePoint(decoded.charCodeAt(d))) return null;
  }
  if (urlEndsInNumber(decoded)) {
    var ipv4 = urlParseIpv4(decoded);
    return ipv4 === null ? null : ipv4;
  }
  return urlDomainToAscii(decoded);
};
`;
