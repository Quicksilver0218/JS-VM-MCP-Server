export const COMMON = String.raw`
var encoder = new TextEncoder();

var makeError = function (name, message) {
  var error = name === "TypeError" ? new TypeError(message) : new Error(message);
  if (error.name !== name) error.name = name;
    return error;
};
`;