// markdown-it only uses these hostname helpers. URL parsing in React Native
// already preserves Unicode hostnames, so identity conversion is sufficient.
module.exports = { toASCII: (value) => value, toUnicode: (value) => value }
