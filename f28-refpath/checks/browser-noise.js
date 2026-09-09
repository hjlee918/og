'use strict';
//
// ONE pre-existing browser condition, named — and named as narrowly as it can
// be, which turns out to be narrower than either previous attempt.
//
// WHAT THE CONDITION IS.
//
// Chromium reports `ResizeObserver loop completed with undelivered
// notifications.` through `window.onerror` when a resize callback causes
// another resize in the same frame. It is a browser SIGNAL, not an exception:
// the ErrorEvent's `error` payload is null and nothing was thrown. OG installs
// a global `window.onerror` handler (`frontend.handler/set-global-error-
// notification!`) which filters it through `frontend.error/ignored?` — whose
// list contains the OLDER Chromium wording, `ResizeObserver loop limit
// exceeded`, and not this one. So the notice passes the filter and OG emits TWO
// console errors from ONE handler invocation: the message itself, and a
// `[frontend.handler]` glogi line for the (null) exception beside it.
//
// It arrives when a long page is scrolled, which is exactly what reading a
// linked-references list to the end requires.
//
// WHAT THIS FILE NOW DOES, AND WHY IT DOES SO LITTLE.
//
// **Only the exact browser notice is exempted. Every `[frontend.handler]` line
// stays unexpected, always.**
//
// Two earlier versions tried to exempt OG's companion line as well, and both
// were wrong in the same way — they inferred provenance instead of establishing
// it:
//
//   * the first paired anything matching `[frontend.handler]` within one second
//     of any notice. The supervisor reproduced it swallowing an unrelated
//     rendering failure 500 ms later;
//   * the second added strict adjacency, one-to-one pairing, a 250 ms window
//     and a check against the page's ErrorEvent log — but that check was a
//     GLOBAL COUNT with no link to the specific line. The supervisor reproduced
//     it again: an exact notice at 1000 ms, `console: [frontend.handler] Error:
//     unrelated rendering failure` adjacent at 1010 ms, and one null-payload
//     ResizeObserver event recorded at 1 ms. `remaining: []`. A historical
//     event funded an unrelated error.
//
// An event COUNT is not same-event provenance, and no arrangement of timestamps
// makes it one. Establishing provenance would need the structured console
// payload of the specific call, tied to the handler invocation that emitted it.
// This harness does not capture that, so it does not claim it.
//
// The cost of being right here is a real one and is not hidden: on any run
// where the notice arises, OG's companion line is reported UNEXPECTED and the
// run fails. That is the intended direction. A pre-existing condition this
// project did not create is worth reporting as unresolved; it is not worth a
// filter that can hide a rendering failure to keep a tally green.
//
// The page's ErrorEvent log is still collected and still written to evidence.
// It is CONTEXT for a reader — it says whether the browser really did signal —
// and it is no longer a licence for anything.
//
// WHERE IT LIVES, AND WHY NOT IN THE CLASSIFIER.
//
// `f27-inline/checks/error-classifier.js` is part of accepted F27 evidence, and
// that acceptance record names an over-broad `frontend.handler.web.nfs`
// substring exemption as the thing that made a general claim about runtime
// errors worthless. Widening it would repeat that mistake in a new place.
//

// The EXACT wordings, anchored at both ends. A line that merely begins like one
// of them, or contains one, is not this condition.
const NOTICE_BODIES = [
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications',
];
const RESIZE_NOTICE = new RegExp(
  '^console: (?:' + NOTICE_BODIES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
  ')\\.?\\s*$');

// The message as the PAGE sees it, without the harness's `console: ` prefix.
const RESIZE_MESSAGE = new RegExp(
  '^(?:' + NOTICE_BODIES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
  ')\\.?\\s*$');

// OG's own global handler. Recognised ONLY so that a refusal can name what it
// is refusing; it is never a reason to exempt anything.
const HANDLER_LINE = /^console: \[frontend\.handler\]/;

const HANDLER_NEVER_EXEMPT =
  "a [frontend.handler] line is never exempted: this harness cannot establish " +
  'that OG emitted it for the browser notice rather than for a real failure, ' +
  'and an ErrorEvent count is not same-event provenance';

/** Is this captured entry the exact browser notice? */
function isNotice(e) {
  return !!e && e.kind === 'console' && RESIZE_NOTICE.test(String(e.text || ''));
}

/** Is this captured entry OG's handler line? Used only to explain a refusal. */
function isHandlerLine(e) {
  return !!e && e.kind === 'console' && HANDLER_LINE.test(String(e.text || ''));
}

/**
 * How many NULL-PAYLOAD ResizeObserver ErrorEvents the page itself recorded.
 *
 * Reported as CONTEXT so a reader can see whether the browser really signalled.
 * It funds no exemption: two attempts to make it do so were both wrong, because
 * a count says nothing about which console line an event produced.
 */
function nullPayloadNotices(evidence) {
  if (!Array.isArray(evidence)) return null;
  return evidence.filter((ev) => ev && ev.nullPayload === true &&
                                 RESIZE_MESSAGE.test(String(ev.message || ''))).length;
}

/**
 * Split a classifier's `unexpected` list into the exempted browser notice and
 * everything else.
 *
 * @param {Array} unexpected  rows from `error-classifier.summarise().unexpected`
 * @param {Array} all         every recorded entry, in capture order (context only)
 * @param {Array} evidence    the page's own ErrorEvent log, or null/undefined
 * @returns {{noise:Array, remaining:Array, refused:Array, evidence:object}}
 *   noise     rows exempted — only ever the exact browser notice
 *   remaining everything not exempted; this is what fails a run
 *   refused   the handler lines that were considered and refused, with the
 *             reason, so a failure is legible rather than merely present
 */
function partition(unexpected, all, evidence) {
  const rows = Array.isArray(unexpected) ? unexpected : [];
  const entries = Array.isArray(all) ? all : [];

  const noise = [];
  const remaining = [];
  const refused = [];

  for (const row of rows) {
    if (isNotice(row)) { noise.push(row); continue; }
    if (isHandlerLine(row)) {
      const r = Object.assign({}, row, { refusedBecause: HANDLER_NEVER_EXEMPT });
      refused.push(r);
      remaining.push(r);
      continue;
    }
    remaining.push(row);
  }

  return {
    noise,
    remaining,
    refused,
    evidence: {
      collected: Array.isArray(evidence),
      windowErrorEvents: Array.isArray(evidence) ? evidence.length : null,
      // Context for a reader. Deliberately NOT used by any decision above.
      nullPayloadNotices: nullPayloadNotices(evidence),
      capturedEntries: entries.length,
      pairsClaimed: 0,
      note: 'Only the exact browser notice is exempted. No handler line is ' +
            'paired with it, because same-event provenance is not captured.',
    },
  };
}

/**
 * The page-side instrumentation this file's CONTEXT comes from.
 *
 * Installed through Playwright's `addInitScript`, so it is registered before
 * any application code runs and therefore sees the same events OG's own
 * `window.onerror` sees. It records only what an ErrorEvent carries; it swallows
 * nothing, cancels nothing and replaces no handler. Its output is written to
 * evidence and read by people; no rule above consults it.
 */
const INIT_SCRIPT = `(() => {
  if (window.__f28ErrorEvents) return;
  window.__f28ErrorEvents = [];
  window.addEventListener('error', (ev) => {
    try {
      window.__f28ErrorEvents.push({
        seq: window.__f28ErrorEvents.length,
        message: String((ev && ev.message) || '').slice(0, 300),
        // A browser SIGNAL carries no thrown value, an exception does.
        // Recorded as observed, never inferred from the text.
        nullPayload: !(ev && ev.error),
        errorName: (ev && ev.error && ev.error.name) ? String(ev.error.name).slice(0, 60) : null,
        filename: String((ev && ev.filename) || '').slice(0, 200),
        lineno: (ev && ev.lineno) | 0,
        at: Date.now(),
      });
    } catch (x) { /* an instrument must never become the failure */ }
  }, true);
})();`;

/** Read the page's ErrorEvent log, or null when it could not be read. */
async function collectEvidence(page) {
  try {
    const rows = await page.evaluate(() => (window.__f28ErrorEvents || []).slice(0, 500));
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  partition,
  collectEvidence,
  isNotice,
  isHandlerLine,
  nullPayloadNotices,
  INIT_SCRIPT,
  RESIZE_NOTICE,
  RESIZE_MESSAGE,
  HANDLER_LINE,
  HANDLER_NEVER_EXEMPT,
  NOTICE_BODIES,
};
