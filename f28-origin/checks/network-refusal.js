"use strict";
// Activation is refused BEFORE launching or changing any profile. The previous
// post-launch defaultSession interceptor had a navigation race and did not cover
// main-process node-fetch (electron.handler :httpRequest/:httpFetchJSON).
// No credentials is not a network control. Do not restore activation until a
// pre-navigation control covers the actual sessions AND main-process paths.
const REASON = 'Origin experiment activation blocked: pre-navigation interception and main-process network coverage are not established';
function assertReady() { throw new Error(REASON); }
function launchWith(_launch) {
  return async function refusedLaunch() { assertReady(); };
}
async function install() { assertReady(); }
async function read(app) {
  return app.evaluate(() => global.__expNet || null).catch(() => null);
}
module.exports = { REASON, assertReady, launchWith, install, read };
