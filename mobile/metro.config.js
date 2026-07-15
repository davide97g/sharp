const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
// markdown-it (used by react-native-markdown-display) expects Node's legacy
// `punycode` module. Expo's browser bundle does not provide it.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  punycode: path.resolve(__dirname, 'src/shims/punycode'),
}
module.exports = config
