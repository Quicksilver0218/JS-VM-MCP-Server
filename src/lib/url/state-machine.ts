/**
 * The WHATWG URL state machine, plus the serialization helpers the URL shim builds on.
 *
 * urlParse walks the input one code unit at a time through the spec's named states.
 * Dot segments are recognised *after* percent-decoding the buffer, so %2e%2e and %2E.
 * both count as ".." -- that matches Node's behaviour, which the spec text alone does not
 * make obvious.
 *
 * stateOverride is only used internally: when a setter rewrites a single component the
 * parser is re-run over the existing record with the entry state pinned, so the rest of
 * the URL is preserved.
 */

export const URL_STATE_MACHINE = String.raw`
var urlParse = function (input, base, stateOverride) {
  input = String(input);
  // Strip leading and trailing C0 controls and space, then remove every tab/newline.
  input = input.replace(/^[\u0000-\u0020\u007f]+/, "").replace(/[\u0000-\u0020\u007f]+$/, "");
  input = input.replace(/[\t\n\r]/g, "");
  // Percent-encode every non-ASCII code point up front so the charAt loop below never
  // splits a surrogate pair; the escapes survive each state exactly as a raw byte would.
  input = urlPreEncodeNonAscii(input);

  var url = {
    scheme: "",
    username: "",
    password: "",
    host: null,
    port: null,
    path: [],
    query: null,
    fragment: null,
    cannotBeABase: false,
    hasHost: false,
  };

  var state = stateOverride !== undefined ? stateOverride : "scheme start";
  var buffer = "";
  var atSignSeen = false;
  var insideBrackets = false;
  var passwordTokenSeen = false;
  var pointer = 0;
  var failure = false;

  var setHost = function (value) {
    var parsed = urlParseHost(value, !urlIsSpecial(url.scheme));
    if (parsed === null) {
      failure = true;
      return;
    }
    url.host = parsed;
    url.hasHost = true;
  };

  while (pointer <= input.length) {
    var c = pointer < input.length ? input.charAt(pointer) : "";

    if (state === "scheme start") {
      if (c !== "" && /[A-Za-z]/.test(c)) {
        buffer += c.toLowerCase();
        state = "scheme";
      } else if (stateOverride === undefined) {
        state = "no scheme";
        pointer--;
      } else {
        failure = true;
        break;
      }
    } else if (state === "scheme") {
      if (c !== "" && /[A-Za-z0-9+\-.]/.test(c)) {
        buffer += c.toLowerCase();
      } else if (c === ":") {
        url.scheme = buffer;
        buffer = "";
        if (stateOverride !== undefined) break;
        if (url.scheme === "file") {
          state = "file";
        } else if (urlIsSpecial(url.scheme) && base !== null && base !== undefined && base.scheme === url.scheme) {
          state = "special relative or authority";
        } else if (urlIsSpecial(url.scheme)) {
          state = "special authority slashes";
        } else if (pointer + 1 < input.length && input.charAt(pointer + 1) === "/") {
          state = "path or authority";
          pointer++;
        } else {
          url.cannotBeABase = true;
          url.path.push("");
          state = "cannot-be-a-base path";
        }
      } else if (stateOverride === undefined) {
        buffer = "";
        state = "no scheme";
        pointer = -1;
      } else {
        failure = true;
        break;
      }
    } else if (state === "no scheme") {
      if (base === null || base === undefined || (base.cannotBeABase && c !== "#")) {
        failure = true;
        break;
      } else if (base.cannotBeABase && c === "#") {
        url.scheme = base.scheme;
        url.path = base.path.slice();
        url.query = base.query;
        url.fragment = "";
        url.cannotBeABase = true;
        state = "fragment";
      } else if (base.scheme !== "file") {
        state = "relative";
        pointer--;
      } else {
        state = "file";
        pointer--;
      }
    } else if (state === "special relative or authority") {
      if (c === "/" && pointer + 1 < input.length && input.charAt(pointer + 1) === "/") {
        state = "special authority ignore slashes";
        pointer++;
      } else {
        state = "relative";
        pointer--;
      }
    } else if (state === "path or authority") {
      if (c === "/") {
        state = "authority";
      } else {
        state = "path";
        pointer--;
      }
    } else if (state === "relative") {
      url.scheme = base.scheme;
      if (c === "/") {
        state = "relative slash";
      } else if (urlIsSpecial(url.scheme) && c === "\\") {
        state = "relative slash";
      } else {
        url.username = base.username;
        url.password = base.password;
        url.host = base.host;
        url.hasHost = base.hasHost;
        url.port = base.port;
        url.path = base.path.slice();
        url.query = base.query;
        if (c === "?") {
          url.query = "";
          state = "query";
        } else if (c === "#") {
          url.fragment = "";
          state = "fragment";
        } else if (c !== "") {
          url.query = null;
          urlShortenPath(url);
          state = "path";
          pointer--;
        }
      }
    } else if (state === "relative slash") {
      if (urlIsSpecial(url.scheme) && (c === "/" || c === "\\")) {
        state = "special authority ignore slashes";
      } else if (c === "/") {
        state = "authority";
      } else {
        url.username = base.username;
        url.password = base.password;
        url.host = base.host;
        url.hasHost = base.hasHost;
        url.port = base.port;
        state = "path";
        pointer--;
      }
    } else if (state === "special authority slashes") {
      if (c === "/" && pointer + 1 < input.length && input.charAt(pointer + 1) === "/") {
        state = "special authority ignore slashes";
        pointer++;
      } else {
        state = "special authority ignore slashes";
        pointer--;
      }
    } else if (state === "special authority ignore slashes") {
      if (c !== "/" && c !== "\\") {
        state = "authority";
        pointer--;
      }
    } else if (state === "authority") {
      if (c === "@") {
        // A second "@" means the first one was userinfo text, so escape it and go on.
        if (atSignSeen) buffer = "%40" + buffer;
        atSignSeen = true;
        for (var bi = 0; bi < buffer.length; bi++) {
          var bc = buffer.charAt(bi);
          if (bc === ":" && !passwordTokenSeen) {
            passwordTokenSeen = true;
            continue;
          }
          var encodedChar = urlPercentEncode(bc, URL_USERINFO_SET, false);
          if (passwordTokenSeen) url.password += encodedChar;
          else url.username += encodedChar;
        }
        buffer = "";
        passwordTokenSeen = false;
      } else if (c === "" || c === "/" || c === "?" || c === "#" ||
                  (urlIsSpecial(url.scheme) && c === "\\")) {
        if (atSignSeen && buffer === "") {
          failure = true;
          break;
        }
        // Rewind so the host state re-reads the buffered authority text.
        pointer -= buffer.length + 1;
        buffer = "";
        state = "host";
      } else {
        buffer += c;
      }
    } else if (state === "host" || state === "hostname") {
      if (c === ":" && !insideBrackets) {
        if (buffer === "") {
          failure = true;
          break;
        }
        setHost(buffer);
        if (failure) break;
        buffer = "";
        state = "port";
      } else if (c === "" || c === "/" || c === "?" || c === "#" ||
                  (urlIsSpecial(url.scheme) && c === "\\")) {
        pointer--;
        setHost(buffer);
        if (failure) break;
        buffer = "";
        state = "path start";
      } else {
        // Colons inside brackets belong to the IPv6 literal, not to a port.
        if (c === "[") insideBrackets = true;
        else if (c === "]") insideBrackets = false;
        buffer += c;
      }
    } else if (state === "port") {
      if (/[0-9]/.test(c)) {
        buffer += c;
      } else if (c === "" || c === "/" || c === "?" || c === "#" ||
                  (urlIsSpecial(url.scheme) && c === "\\")) {
        if (buffer !== "") {
          var port = parseInt(buffer, 10);
          if (port > 65535) {
            failure = true;
            break;
          }
          url.port = URL_DEFAULT_PORTS[url.scheme] === port ? null : port;
          buffer = "";
        }
        state = "path start";
        pointer--;
      } else {
        failure = true;
        break;
      }
    } else if (state === "file") {
      url.scheme = "file";
      if (c === "/" || c === "\\") {
        state = "file slash";
      } else if (base !== null && base !== undefined && base.scheme === "file") {
        url.host = base.host;
        url.hasHost = base.hasHost;
        if (urlIsWindowsDriveLetter(input, pointer)) {
          state = "path";
        } else if (input.substr(pointer, 2) === "//") {
          state = "file host";
          pointer++;
        } else {
          url.path = base.path.slice();
          if (c === "?") {
            url.query = "";
            state = "query";
          } else if (c === "#") {
            url.fragment = "";
            state = "fragment";
          } else if (c !== "") {
            url.query = null;
            urlShortenPath(url);
            state = "path";
            pointer--;
          }
        }
      } else {
        state = "path";
        pointer--;
      }
    } else if (state === "file slash") {
      if (c === "/" || c === "\\") {
        state = "file host";
      } else {
        if (base !== null && base !== undefined && base.scheme === "file") {
          url.host = base.host;
          url.hasHost = base.hasHost;
          if (!urlIsWindowsDriveLetter(input, pointer)) {
            url.path = base.path.slice();
            urlShortenPath(url);
          }
        }
        state = "path";
        pointer--;
      }
    } else if (state === "file host") {
      if (c === "" || c === "/" || c === "\\" || c === "?" || c === "#") {
        pointer--;
        if (urlIsWindowsDriveLetter(input, pointer)) {
          state = "path";
        } else if (buffer === "") {
          url.host = "";
          url.hasHost = true;
          state = "path start";
        } else {
          setHost(buffer);
          if (failure) break;
          buffer = "";
          state = "path start";
        }
      } else {
        buffer += c;
      }
    } else if (state === "path start") {
      if (urlIsSpecial(url.scheme)) {
        state = "path";
        if (c !== "/" && c !== "\\") pointer--;
      } else if (stateOverride === undefined && c === "?") {
        url.query = "";
        state = "query";
      } else if (stateOverride === undefined && c === "#") {
        url.fragment = "";
        state = "fragment";
      } else if (c !== "") {
        if (c !== "/") pointer--;
        state = "path";
      } else if (stateOverride !== undefined && url.host === null) {
        url.path.push("");
      }
    } else if (state === "path") {
      if (c === "" || c === "/" || (urlIsSpecial(url.scheme) && c === "\\") ||
          (stateOverride === undefined && (c === "?" || c === "#"))) {
        // Dot segments are matched after decoding, so "%2e%2e" counts as "..".
        var decodedBuffer = urlPercentDecode(buffer);
        var isDoubleDot = decodedBuffer === "..";
        var isSingleDot = decodedBuffer === ".";
        var isSeparator = c === "/" || (urlIsSpecial(url.scheme) && c === "\\");
        if (isDoubleDot) {
          urlShortenPath(url);
          if (!isSeparator) url.path.push("");
        } else if (isSingleDot && !isSeparator) {
          url.path.push("");
        } else if (!isSingleDot) {
          if (url.scheme === "file" && url.path.length === 0 &&
              /^[A-Za-z][:|]$/.test(buffer)) {
            // A Windows drive letter must survive verbatim in a file path (case kept).
            url.path.push(buffer.charAt(0) + ":");
          } else {
            url.path.push(urlPercentEncode(buffer, URL_PATH_SET, false));
          }
        }
        buffer = "";
        if (c === "?") {
          url.query = "";
          state = "query";
        } else if (c === "#") {
          url.fragment = "";
          state = "fragment";
        }
      } else {
        // For special schemes a backslash is a separator, so it must not reach the
        // segment buffer; for others it is ordinary text and is escaped.
        buffer += urlPercentEncode(c, urlIsSpecial(url.scheme) ? "\\" : "", false);
      }
    } else if (state === "cannot-be-a-base path") {
      if (c === "?") {
        url.query = "";
        state = "query";
      } else if (c === "#") {
        url.fragment = "";
        state = "fragment";
      } else if (c !== "") {
        url.path[0] += urlPercentEncode(c, URL_C0_SET, false);
      }
    } else if (state === "query") {
      if (stateOverride === undefined && c === "#") {
        url.fragment = "";
        state = "fragment";
      } else if (c !== "") {
        // Special schemes additionally escape the apostrophe in the query.
        url.query += urlPercentEncode(
          c,
          urlIsSpecial(url.scheme) ? URL_QUERY_SET + "'" : URL_QUERY_SET,
          false
        );
      }
    } else if (state === "fragment") {
      if (c !== "") {
        url.fragment += urlPercentEncode(c, URL_FRAGMENT_SET, false);
      }
    }

    if (failure) break;
    pointer++;
  }

  if (failure) return null;

  if (state === "host" || state === "hostname") {
    pointer--;
    setHost(buffer);
    if (failure) return null;
  } else if (state === "path start") {
    if (urlIsSpecial(url.scheme) && url.host === null) return null;
    if (stateOverride === undefined && url.host === null &&
        url.path.length === 1 && url.path[0] === "") {
      url.path = [];
    }
  } else if (state === "port" && buffer !== "") {
    var finalPort = parseInt(buffer, 10);
    if (finalPort > 65535) return null;
    url.port = URL_DEFAULT_PORTS[url.scheme] === finalPort ? null : finalPort;
  }
  return url;
};

/** True when pointer starts a Windows drive letter such as "c:" or "c|". */
var urlIsWindowsDriveLetter = function (input, pointer) {
  return input.length - pointer >= 2 &&
    /[A-Za-z]/.test(input.charAt(pointer)) &&
    (input.charAt(pointer + 1) === ":" || input.charAt(pointer + 1) === "|");
};

/** Drops the last path segment, leaving a lone file-scheme drive letter intact. */
var urlShortenPath = function (url) {
  if (url.path.length === 0) return;
  if (url.scheme === "file" && url.path.length === 1 && /^[A-Za-z][:|]$/.test(url.path[0])) {
    return;
  }
  url.path.pop();
};

/** Serializes a parsed record back into its href string. */
var urlSerialize = function (url) {
  var out = url.scheme + ":";
  if (url.host !== null) {
    out += "//";
    if (url.username !== "" || url.password !== "") {
      out += url.username;
      if (url.password !== "") out += ":" + url.password;
      out += "@";
    }
    out += url.host;
    if (url.port !== null) out += ":" + url.port;
  } else if (url.host === null && url.scheme === "file") {
    out += "//";
  }
  if (url.host === null && !urlIsSpecial(url.scheme) && url.cannotBeABase) {
    out += url.path[0];
  } else {
    out += "/" + url.path.join("/");
  }
  if (url.query !== null) out += "?" + url.query;
  if (url.fragment !== null) out += "#" + url.fragment;
  return out;
};

/** An opaque origin ("null") for everything that is not a special scheme with a host. */
var urlOrigin = function (url) {
  if (url.scheme === "blob" && url.path.length > 0 && urlIsSpecial(url.path[0])) {
    var inner = urlParse(url.path[0], null, "no scheme");
    if (inner === null) return "null";
    return urlOrigin(inner);
  }
  if (url.scheme !== "file" && urlIsSpecial(url.scheme) && url.host !== null) {
    return url.scheme + "://" + url.host + (url.port === null ? "" : ":" + url.port);
  }
  return "null";
};
`;
