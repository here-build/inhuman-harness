module.exports = {
  presets: ["module:@react-native/babel-preset"],
  // The model package emits static blocks, and plexus re-exports a namespace.
  // The preset's parser rejects both until these run, ahead of the CommonJS transform.
  plugins: [
    "@babel/plugin-transform-export-namespace-from",
    "@babel/plugin-transform-class-static-block",
  ],
};
