'use strict';
//
// ONE pre-existing browser condition, named — and named far more narrowly than
// the first version of this file managed.
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
// WHY THIS FILE WAS REWRITTEN (supervisor review, 2026-09-08).
//
// The first version exempted ANY `[frontend.handler]` console error arriving
// within one second after ANY ResizeObserver notice. The supervisor reproduced
// `remaining: []` for an unrelated RENDERING FAILURE 500 ms after a notice.
// That is the same class of mistake the F27 acceptance record names by name —
// a filter broad enough to hide the failures it was supposed to leave visible.
//
// The rule is now the opposite shape. A handler line is exempted only when
// EVERY one of these holds, and each of them can fail on its own:
//
//   H1  it is a console line, never a page error;
//   H2  it is a `[frontend.handler]` line;
//   H3  the entry IMMEDIATELY BEFORE IT IN CAPTURE ORDER is an exact notice —
//       strict adjacency by sequence number, not a time window, so any
//       intervening captured error breaks the pair;
//   H4  it shares that notice's phase and operation;
//   H5  it arrived within `PAIR_WINDOW_MS` of it — one handler invocation, not
//       one second;
//   H6  that notice has not already been paired — the pairing is ONE-TO-ONE, so
//       a second handler line after one notice stays unexpected;
//   H7  the page's own ErrorEvent log corroborates it: at least as many
//       NULL-PAYLOAD ResizeObserver events were recorded in the window as pairs
//       being claimed. **Without that evidence nothing is paired at all.**
//
// Anything a rule cannot prove stays in `remaining`, which is what fails a run.
// Handler lines that were considered and refused are ALSO reported separately,
// with the reason, so a reader can see what the rule declined to excuse rather
// than having to infer it.
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

// OG's own global handler logging the (null) exception beside the notice.
const HANDLER_LINE = /^console: \[frontend\.handler\]/;

// One handler invocation emits both lines back to back. 250 ms is already
// generous for two synchronous `console.error` calls; the old 1000 ms was wide
// enough for an unrelated failure to land inside it, and did.
const PAIR_WINDOW_MS = 250;

/** Is this captured entry the exact browser notice? */
function isNotice(e) {
  return !!e && e.kind === 'console' && RESIZE_NOTICE.test(String(e.text || ''));
}

/** Is this captured entry OG's handler line? */
function isHandlerLine(e) {
  return !!e && e.kind === 'console' && HANDLER_LINE.test(String(e.text || ''));
}

/**
 * How many NULL-PAYLOAD ResizeObserver ErrorEvents the page itself recorded.
 *
 * This is the structured evidence H7 needs, and it is what makes the pairing a
 * statement about a specific browser event rather than about two adjacent log
 * lines. `null` (rather than 0) means the log was never collected, which is a
 * different thing and is treated as "prove nothing, pair nothing".
 */
function nullPayloadNotices(evidence) {
  if (!Array.isArray(evidence)) return null;
  return evidence.filter((ev) => ev && ev.nullPayload === true &&
                                 RESIZE_MESSAGE.test(String(ev.message || ''))).length;
}

/**
 * Split a classifier's `unexpected` list into the exempted browser noise and
 * everything else.
 *
 * @param {Array} unexpected  rows from `error-classifier.summarise().unexpected`,
 *                            each of which must carry the `seq` this feature's
 *                            recorder adds; without it no handler line can be
 *                            paired, because adjacency cannot be established
 * @param {Array} all         every recorded entry, in capture order
 * @param {Array} evidence    the page's own ErrorEvent log, or null/undefined
 * @returns {{noise:Array, remaining:Array, refused:Array, evidence:object}}
 *   noise     exempted rows
 *   remaining everything not exempted — this is what fails a run, and it
 *             INCLUDES every handler line the rule declined to excuse
 *   refused   the handler lines that were considered and refused, each with the
 *             first condition that failed, so the refusal is legible
 */
function partition(unexpected, all, evidence) {
  const rows = Array.isArray(unexpected) ? unexpected : [];
  const entries = Array.isArray(all) ? all : [];
  const bySeq = new Map();
  for (const e of entries) {
    if (e && typeof e.seq === 'number') bySeq.set(e.seq, e);
  }

  const available = nullPayloadNotices(evidence);
  const pairedNotice = new Set();
  let claimed = 0;

  const noise = [];
  const remaining = [];
  const refused = [];

  // Exact notices first, in capture order, so the one-to-one budget below is
  // spent deterministically rather than in whatever order the caller passed.
  const ordered = rows.slice().sort((a, b) => {
    const sa = typeof a.seq === 'number' ? a.seq : Number.MAX_SAFE_INTEGER;
    const sb = typeof b.seq === 'number' ? b.seq : Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });

  for (const row of ordered) {
    // The notice itself: exempted on its exact wording alone. It is a browser
    // signal, it names itself, and nothing else says those words.
    if (isNotice(row)) { noise.push(row); continue; }

    if (!isHandlerLine(row)) { remaining.push(row); continue; }

    // H1 already holds (isHandlerLine requires kind console). Everything below
    // is a separate, individually falsifiable reason to refuse.
    let why = null;
    const prev = typeof row.seq === 'number' ? bySeq.get(row.seq - 1) : undefined;

    if (typeof row.seq !== 'number') {
      why = 'no capture sequence, so adjacency to a notice cannot be established';
    } else if (!prev) {
      why = 'nothing was captured immediately before it';
    } else if (!isNotice(prev)) {
      why = 'the entry immediately before it is not the browser notice ' +
            `(it is ${JSON.stringify(String(prev.text || '').slice(0, 60))})`;
    } else if (prev.phase !== row.phase || (prev.operation || null) !== (row.operation || null)) {
      why = `it is in a different phase from the notice (${prev.phase}/${prev.operation} ` +
            `vs ${row.phase}/${row.operation})`;
    } else if (!(typeof row.at === 'number' && typeof prev.at === 'number' &&
                 row.at >= prev.at && row.at - prev.at <= PAIR_WINDOW_MS)) {
      why = `it did not arrive within ${PAIR_WINDOW_MS}ms of the notice`;
    } else if (pairedNotice.has(prev.seq)) {
      why = 'the notice before it has already been paired with another handler line';
    } else if (available === null) {
      why = "the page's own ErrorEvent log was not collected, so no browser event " +
            'can be shown to have produced it';
    } else if (claimed >= available) {
      why = `the page recorded ${available} null-payload ResizeObserver event(s), ` +
            `which ${claimed} pair(s) already account for`;
    }

    if (why) {
      const r = Object.assign({}, row, { refusedBecause: why });
      refused.push(r);
      remaining.push(r);
      continue;
    }

    pairedNotice.add(prev.seq);
    claimed += 1;
    noise.push(Object.assign({}, row, {
      pairedWithSeq: prev.seq,
      pairedGapMs: row.at - prev.at,
    }));
  }

  return {
    noise,
    remaining,
    refused,
    evidence: {
      collected: Array.isArray(evidence),
      windowErrorEvents: Array.isArray(evidence) ? evidence.length : null,
      nullPayloadNotices: available,
      pairsClaimed: claimed,
    },
  };
}

/**
 * The page-side instrumentation this rule's evidence comes from.
 *
 * Installed through Playwright's `addInitScript`, so it is registered before
 * any application code runs and therefore sees the same events OG's own
 * `window.onerror` sees. It records only what an ErrorEvent carries; it swallows
 * nothing, cancels nothing and replaces no handler.
 */
const INIT_SCRIPT = `(() => {
  if (window.__f28ErrorEvents) return;
  window.__f28ErrorEvents = [];
  window.addEventListener('error', (ev) => {
    try {
      window.__f28ErrorEvents.push({
        seq: window.__f28ErrorEvents.length,
        message: String((ev && ev.message) || '').slice(0, 300),
        // The whole point: a browser SIGNAL carries no thrown value, an
        // exception does. Recorded as observed, never inferred from the text.
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
  NOTICE_BODIES,
  PAIR_WINDOW_MS,
};
