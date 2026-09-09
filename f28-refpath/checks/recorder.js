'use strict';
//
// The F27 error recorder, plus the ONE thing this feature's error rule needs
// that it does not provide: a capture SEQUENCE NUMBER.
//
// `f27-inline/checks/error-classifier.js` is accepted F27 evidence and is not
// modified here. Its `summarise` copies each entry with `Object.assign`, so any
// field added to the entry survives into the classified rows — which is how a
// `seq` recorded here reaches `browser-noise.partition`.
//
// Why a sequence and not a timestamp: two console lines emitted by ONE handler
// invocation routinely share a millisecond, and `Date.now()` cannot order them.
// Adjacency is the whole basis of the pairing rule, so it has to be exact.
//
const EC = require('../../f27-inline/checks/error-classifier.js');

/**
 * A recorder with the same interface, whose entries carry `seq`.
 *
 * `record` returns the entry object the classifier holds, so stamping it here
 * stamps the one in `entries()` too.
 */
function createRecorder(now) {
  const base = EC.createRecorder(now);
  let seq = 0;
  return Object.assign({}, base, {
    record(kind, text) {
      const e = base.record(kind, text);
      e.seq = seq;
      seq += 1;
      return e;
    },
    nextSeq: () => seq,
  });
}

module.exports = { createRecorder };
