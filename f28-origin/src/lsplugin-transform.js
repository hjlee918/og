'use strict';
//
// DERIVING THE EXPERIMENTAL PLUGIN HOST BUNDLE.
//
// `resources/js/lsplugin.core.js` is a FIRST-PARTY build artifact of this
// repository, produced by webpack from `libs/src/LSPlugin.core.ts`. This
// checkout has no `libs/node_modules`, and installing a bundler toolchain would
// rewrite the entire committed bundle — a change no reviewer could read, for an
// experiment whose whole point is to be small and reversible.
//
// So the TypeScript change is committed as the source of truth, and the
// EXPERIMENTAL bundle is derived from the committed one by the single
// substitution below. The production artifact is never modified: this writes a
// separate file, and only into the experimental package.
//
// The substitution is asserted, not hoped for. If the anchor is missing, or
// present more than once, the build STOPS. That is what keeps this from
// silently becoming a no-op — a bundle that still carried the old condition
// would look identical from the outside and would fail the same way, and the
// experiment would be measuring nothing.
//
// The two texts correspond exactly to the committed TypeScript:
//
//   const privileged =
//     !this.options.effect || !!this._ctx?.options?.privilegedPluginResources
//   return privileged && this.isInstalledInDotRoot
//     ? convertToLSPResource(filePath, this.dotPluginsRoot)
//     : filePath
//
// `_ctx`, `options`, `effect`, `isInstalledInDotRoot` and `dotPluginsRoot` are
// PROPERTY names, which terser does not mangle, so they appear verbatim in the
// minified bundle. `mr` is the minified `convertToLSPResource` and `e` the
// minified `filePath`; both are read out of the anchor rather than assumed.
//
const fs = require('fs');

class TransformRefusal extends Error {}

const ANCHOR =
  'return!this.options.effect&&this.isInstalledInDotRoot?mr(e,this.dotPluginsRoot):e}';

const REPLACEMENT =
  'return this.isInstalledInDotRoot&&(!this.options.effect||' +
  '!0===this._ctx?.options?.privilegedPluginResources)?' +
  'mr(e,this.dotPluginsRoot):e}';

/**
 * Return the experimental bundle text for `source`, refusing anything that
 * would make the result untrue.
 */
function transform(source) {
  if (typeof source !== 'string' || !source.length) {
    throw new TransformRefusal('the plugin host bundle is empty');
  }
  // Checked BEFORE the anchor count, because a bundle that has already been
  // transformed has no anchor left and would otherwise be reported as an
  // unrecognised bundle rather than as the double application it is.
  if (source.includes(REPLACEMENT)) {
    throw new TransformRefusal('the bundle already carries the experimental condition');
  }
  const n = source.split(ANCHOR).length - 1;
  if (n !== 1) {
    throw new TransformRefusal(
      `expected the rewrite condition exactly once in the plugin host bundle, found ${n}. ` +
      'The bundle has changed and this transform must be re-derived rather than forced.');
  }
  const out = source.replace(ANCHOR, REPLACEMENT);
  if (out.includes(ANCHOR)) {
    throw new TransformRefusal('the original condition survived the substitution');
  }
  if (!out.includes(REPLACEMENT)) {
    throw new TransformRefusal('the experimental condition is not present after substitution');
  }
  if (out.length - source.length !== REPLACEMENT.length - ANCHOR.length) {
    throw new TransformRefusal('more than the anchor changed');
  }
  return out;
}

function transformFile(src, dst) {
  const out = transform(fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(dst, out);
  return out.length;
}

module.exports = { TransformRefusal, ANCHOR, REPLACEMENT, transform, transformFile };
