'use strict';
//
// ONE pre-existing condition this project did not create, named rather than
// exempted by substring.
//
// WHAT IT IS.
//
// Chromium reports `ResizeObserver loop completed with undelivered
// notifications.` through `window.onerror` when a resize callback causes
// another resize in the same frame. It is a browser SIGNAL, not an exception:
// the `error` argument is undefined and nothing was thrown. OG installs a
// global `window.onerror` handler (`frontend.handler/set-global-error-
// notification!`) which filters it through `frontend.error/ignored?` — whose
// list contains the OLDER Chromium wording, `ResizeObserver loop limit
// exceeded`, and not this one. So the notice passes the filter and OG emits
// TWO console errors from it: the message itself, and a `[frontend.handler]`
// glogi line for the (undefined) exception beside it.
//
// It arrives when a long page is scrolled, which is exactly what reading a
// linked-references list to the end requires.
//
// WHY THIS IS A SEPARATE MODULE, AND NOT A CHANGE TO THE CLASSIFIER.
//
// `f27-inline/checks/error-classifier.js` is part of accepted F27 evidence, and
// the acceptance record names "exempted every `frontend.handler.web.nfs` error
// that did not contain the test graph path" as the thing that made a general
// claim about runtime errors worthless. Widening that classifier would repeat
// the mistake in a new place. So this rule lives beside it, applies only to
// this feature's scenarios, and is CORRELATED rather than matched:
//
//   * the browser's own notice is recognised by its two known wordings, and
//     only when it arrived as a console line rather than as a page error;
//   * OG's `[frontend.handler]` line is recognised ONLY when such a notice
//     arrived immediately before it, within a bounded window. A
//     `[frontend.handler]` error with no notice in front of it is NOT excused.
//
// Both numbers are reported by every scenario that uses this: the count with
// the rule applied and the count without it. Nothing is hidden.
//
const RESIZE_NOTICE =
  /^console: ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/;

// OG's own global handler logging the (undefined) exception beside the notice.
const HANDLER_LINE = /^console: \[frontend\.handler\]/;

// Measured, not guessed: the two lines are emitted by the same handler
// invocation. A second is already generous; anything outside it is a different
// event and is not excused.
const PAIR_WINDOW_MS = 1000;

/**
 * Split a classifier's `unexpected` list into the browser notices this
 * pre-existing condition produces, and everything else.
 *
 * @param {Array} unexpected  rows from `error-classifier.summarise().unexpected`
 * @param {Array} all         every recorded entry, in arrival order, so the
 *                            correlation can look at what came immediately
 *                            before a `[frontend.handler]` line
 * @returns {{noise: Array, remaining: Array}}
 */
function partition(unexpected, all) {
  const rows = Array.isArray(all) ? all.slice().sort((a, b) => a.at - b.at) : [];
  const noticeAt = rows.filter((e) => e.kind === 'console' && RESIZE_NOTICE.test(e.text))
    .map((e) => e.at);

  const isNoise = (e) => {
    if (e.kind !== 'console') return false;
    if (RESIZE_NOTICE.test(e.text)) return true;
    if (!HANDLER_LINE.test(e.text)) return false;
    // Correlated: a notice must have arrived just before this line.
    return noticeAt.some((t) => e.at >= t && e.at - t <= PAIR_WINDOW_MS);
  };

  const noise = [];
  const remaining = [];
  for (const e of unexpected) (isNoise(e) ? noise : remaining).push(e);
  return { noise, remaining };
}

module.exports = { partition, RESIZE_NOTICE, HANDLER_LINE, PAIR_WINDOW_MS };
