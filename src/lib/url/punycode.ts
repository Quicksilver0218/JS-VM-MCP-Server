/**
 * Punycode (RFC 3492) and IDNA domain conversion for the URL shim.
 *
 * Full UTS #46 mapping tables are far beyond what a sandbox shim needs, so
 * urlDomainToAscii does what the URL parser actually requires: lowercase the ASCII,
 * punycode any label that holds non-ASCII code points, and reject forbidden domain code
 * points. That covers the internationalised-host inputs that matter in practice.
 */

export const URL_PUNYCODE = String.raw`
// punycode (RFC 3492)
var URL_PUNY_BASE = 36, URL_PUNY_TMIN = 1, URL_PUNY_TMAX = 26;
var URL_PUNY_SKEW = 38, URL_PUNY_DAMP = 700;
var URL_PUNY_INITIAL_BIAS = 72, URL_PUNY_INITIAL_N = 128;

var punyAdapt = function (delta, numPoints, firstTime) {
  delta = firstTime ? Math.floor(delta / URL_PUNY_DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  var k = 0;
  while (delta > ((URL_PUNY_BASE - URL_PUNY_TMIN) * URL_PUNY_TMAX) >> 1) {
    delta = Math.floor(delta / (URL_PUNY_BASE - URL_PUNY_TMIN));
    k += URL_PUNY_BASE;
  }
  return Math.floor(k + ((URL_PUNY_BASE - URL_PUNY_TMIN + 1) * delta) / (delta + URL_PUNY_SKEW));
};

/** Maps a 0-35 digit to its ASCII character in the extended-digit alphabet. */
var punyDigitToBasic = function (digit) {
  return String.fromCharCode(digit + 22 + (digit < 26 ? 75 : 0));
};

/** Encodes one label's code points into its punycode payload, without the "xn--" prefix. */
var punyEncode = function (str) {
  var output = [];
  var input = [];
  for (var i = 0; i < str.length; i++) input.push(str.codePointAt(i));

  var basicLength = 0;
  for (var b = 0; b < input.length; b++) if (input[b] < 0x80) basicLength++;
  var handledCPCount = basicLength;

  // The basic code points come first, lower-cased, then a hyphen delimiter.
  if (basicLength) {
    for (var e = 0; e < input.length; e++) {
      if (input[e] < 0x80) output.push(String.fromCharCode(input[e]).toLowerCase());
    }
    output.push("-");
  }

  var n = URL_PUNY_INITIAL_N;
  var delta = 0;
  var bias = URL_PUNY_INITIAL_BIAS;

  while (handledCPCount < input.length) {
    // Find the smallest code point at or above n that is still unhandled.
    var m = 0x7FFFFFFF;
    for (var q = 0; q < input.length; q++) {
      if (input[q] >= n && input[q] < m) m = input[q];
    }
    delta += (m - n) * (handledCPCount + 1);
    n = m;
    for (var p = 0; p < input.length; p++) {
      var current = input[p];
      if (current < n) delta++;
      if (current === n) {
        var q2 = delta;
        for (var k = URL_PUNY_BASE; ; k += URL_PUNY_BASE) {
          var t = k <= bias ? URL_PUNY_TMIN : (k >= bias + URL_PUNY_TMAX ? URL_PUNY_TMAX : k - bias);
          if (q2 < t) break;
          output.push(punyDigitToBasic(t + ((q2 - t) % (URL_PUNY_BASE - t))));
          q2 = Math.floor((q2 - t) / (URL_PUNY_BASE - t));
        }
        output.push(punyDigitToBasic(q2));
        bias = punyAdapt(delta, handledCPCount + 1, handledCPCount === basicLength);
        delta = 0;
        handledCPCount++;
      }
    }
    delta++;
    n++;
  }
  return output.join("");
};

/**
 * Domain to ASCII, returning null when the domain cannot be represented. A trailing dot
 * is legal and dropped; an empty label anywhere else is a failure.
 */
var urlDomainToAscii = function (domain) {
  if (domain === "") return "";
  var labels = domain.split(".");
  var out = [];
  for (var i = 0; i < labels.length; i++) {
    var label = labels[i];
    if (label === "") {
      if (i === labels.length - 1) continue;
      return null;
    }
    var hasNonAscii = false;
    for (var j = 0; j < label.length; j++) {
      var code = label.codePointAt(j);
      if (urlIsForbiddenDomainCodePoint(code)) return null;
      if (code > 0x7E) hasNonAscii = true;
    }
    var ascii = label.toLowerCase();
    if (hasNonAscii) {
      var encoded = punyEncode(label);
      if (encoded === "") return null;
      ascii = "xn--" + encoded;
    }
    if (ascii.length > 63) return null;
    out.push(ascii);
  }
  return out.join(".");
};
`;
