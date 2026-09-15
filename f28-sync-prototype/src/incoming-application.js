'use strict';

/*
 * Incoming change application: applying a change that did not originate from
 * this device's OG, without silently overwriting a newer local edit.
 *
 * See ../INCOMING_CHANGE_DESIGN.md. This module adds no second synchronization
 * engine: the plan is owned by snapshot-comparison, the projection by executor,
 * the metadata by identity-capture, and every byte that reaches the graph goes
 * through the anchored helper via persistent-identity. What is new here is the
 * refusal logic, the preview/approval boundary, the bounded journal and the
 * roll-forward recovery around them.
 *
 * Three claims this module does NOT make:
 *   - whole-graph atomicity: application is per file and can be interrupted
 *     into a mixed, explicitly recorded state;
 *   - protection from writers that do not honour the cooperative lock: the
 *     helper's precondition is a recheck-then-rename, not a compare-and-swap;
 *   - authenticity of the journal: the validations below establish consistency
 *     against accident, staleness and substitution, not against a forger who
 *     can write into the owned profile directory.
 */

const crypto = require('node:crypto');
const { applyOperation, createState, stableStringify } = require('./core');
const { snapshotFingerprint } = require('./planner');
const { executePlan } = require('./executor');
const { compareSnapshots, TARGET_SCHEMA } = require('./snapshot-comparison');
const PI = require('./persistent-identity');

const PROPOSAL_SCHEMA = 'f28-incoming-proposal/1';
const PREVIEW_SCHEMA = 'f28-incoming-preview/1';
const JOURNAL_SCHEMA = 'f28-incoming-journal/1';

/* Bounds are enforced before the first note write, so an oversized transaction
 * refuses with nothing mutated. The helper's own record limit is 4 MiB; these
 * sit well inside it. */
const MAX_NOTE_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

/* The only parents an incoming target may live in, and only as a direct child.
 * Syntax alone does not prevent the helper from creating a directory, so the
 * parent must additionally be proven to exist -- see provenParents(). */
const ALLOWED_PARENTS = ['pages', 'journals'];

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const digest = (text) => sha256(Buffer.from(text, 'utf8'));
const isHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

class IncomingError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'IncomingError';
    this.code = code;
    this.detail = detail;
  }
}

/*
 * Every refusal states whether a note byte changed. `mutated: false` is a claim
 * this code establishes -- it is only ever used before the first note write.
 */
const refuse = (code, reason, detail = {}) =>
  ({ outcome: 'refused', code, reason, mutated: false, ...detail });
const interrupted = (code, reason, detail = {}) =>
  ({ outcome: 'interrupted', code, reason, mutated: true, ...detail });

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IncomingError('malformed-record', `${label} is not an object`);
  }
  const actual = Object.keys(value).sort();
  if (stableStringify(actual) !== stableStringify([...keys].sort())) {
    throw new IncomingError('malformed-record', `${label} key set is wrong`,
      { expected: [...keys].sort(), actual });
  }
}

// ------------------------------------------------------------ byte fidelity

/*
 * Existing store APIs read and write notes as UTF-8 strings. Bytes that do not
 * round-trip through that representation would be silently replaced with U+FFFD,
 * so they are refused here instead. Hex is the journal's representation, so no
 * decoding sits between the journal and the file.
 */
function decodeNoteHex(hex, label) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})*$/.test(hex)) {
    throw new IncomingError('malformed-record', `${label} is not lowercase hex`);
  }
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length > MAX_NOTE_BYTES) {
    throw new IncomingError('note-too-large',
      `${label} is ${bytes.length} bytes; the limit is ${MAX_NOTE_BYTES}`);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new IncomingError('non-roundtrip-bytes',
      `${label} is not UTF-8 that round-trips through the string APIs`);
  }
  return { bytes, text, hex: bytes.toString('hex'), hash: sha256(bytes) };
}

function encodeNote(text, label) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_NOTE_BYTES) {
    throw new IncomingError('note-too-large',
      `${label} is ${bytes.length} bytes; the limit is ${MAX_NOTE_BYTES}`);
  }
  if (bytes.toString('utf8') !== text) {
    throw new IncomingError('non-roundtrip-bytes', `${label} does not round-trip as UTF-8`);
  }
  return { bytes, text, hex: bytes.toString('hex'), hash: sha256(bytes) };
}

// -------------------------------------------------------------- path guards

function checkNotePath(notePath, label) {
  if (typeof notePath !== 'string' || notePath.length === 0) {
    throw new IncomingError('invalid-path', `${label} is empty`);
  }
  if (notePath.startsWith('/') || notePath.includes('\\') || notePath.includes('//')) {
    throw new IncomingError('invalid-path', `${label} is not a safe relative note path`);
  }
  const parts = notePath.split('/');
  if (parts.length !== 2) {
    throw new IncomingError('invalid-path',
      `${label} must be a direct child of an approved directory`);
  }
  const [parent, leaf] = parts;
  if (!ALLOWED_PARENTS.includes(parent)) {
    throw new IncomingError('invalid-path',
      `${label} parent must be one of ${ALLOWED_PARENTS.join(', ')}`);
  }
  if (!leaf.endsWith('.md') || leaf.length <= 3) {
    throw new IncomingError('invalid-path', `${label} must be a .md note in this slice`);
  }
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new IncomingError('invalid-path', `${label} contains a traversal component`);
    }
  }
  return { parent, leaf };
}

/*
 * A parent directory is only usable if the ACCEPTED sidecar already names a file
 * in it and that file reads back through the anchored, non-following walk. That
 * read is the proof the directory exists and is openable without following a
 * symlink; restricting path syntax alone would still leave put-note free to
 * create the directory through note_parent(..., create = 1).
 */
function provenParents(context, acceptedFiles) {
  const proven = new Set();
  for (const file of acceptedFiles) {
    const slash = file.path.lastIndexOf('/');
    if (slash <= 0) continue;
    const parent = file.path.slice(0, slash);
    if (proven.has(parent)) continue;
    if (PI.readNoteBytes(context, file.path) !== null) proven.add(parent);
  }
  return proven;
}

// ------------------------------------------------------------- stable reads

/*
 * Two anchored reads that must agree. An unstable read means the file is being
 * written now and is never treated as a settled state.
 */
function stableRead(context, notePath) {
  const first = PI.readNoteBytes(context, notePath);
  const second = PI.readNoteBytes(context, notePath);
  if (first === null || second === null) {
    return { stable: first === null && second === null, present: false, bytes: null, hash: null };
  }
  if (!first.equals(second)) return { stable: false, present: true, bytes: null, hash: null };
  return { stable: true, present: true, bytes: first, hash: sha256(first) };
}

// ------------------------------------------------------------- app-closed gate

/*
 * The gate proves ONE app has exited: the owned experimental build this harness
 * started. It excludes nothing else -- not Finder, not a cloud agent, not an
 * external editor, not a second coordinator, and not the same app launched again
 * one millisecond after the check passes. An uncertain result is never treated
 * as closed.
 */
function assertAppClosed(gate, stage) {
  if (typeof gate !== 'function') {
    throw new IncomingError('app-state-uncertain',
      `no app-closed gate was supplied for ${stage}`);
  }
  let verdict;
  try { verdict = gate(stage); }
  catch (error) {
    throw new IncomingError('app-state-uncertain',
      `the app-closed gate failed at ${stage}: ${error.message}`);
  }
  if (!verdict || verdict.closed !== true) {
    throw new IncomingError(
      verdict && verdict.uncertain ? 'app-state-uncertain' : 'app-running',
      `the owned application is not proven closed at ${stage}`,
      { verdict: verdict || null });
  }
  return verdict;
}

// ---------------------------------------------------------- proposal shape

function validateProposal(input) {
  const proposal = clone(input);
  exactKeys(proposal, ['schema', 'proposalId', 'graphId', 'base', 'target',
    'originReplicaId', 'planId', 'files'], 'proposal');
  if (proposal.schema !== PROPOSAL_SCHEMA) {
    throw new IncomingError('unsupported-schema', 'proposal schema is not supported');
  }
  if (!isHash(proposal.proposalId)) {
    throw new IncomingError('malformed-record', 'proposalId must be 64 hex');
  }
  exactKeys(proposal.base,
    ['metadataRevision', 'snapshotFingerprint', 'acceptedTransactionId'], 'proposal.base');
  exactKeys(proposal.target, ['metadataRevision'], 'proposal.target');
  if (!Array.isArray(proposal.files) || proposal.files.length === 0) {
    throw new IncomingError('malformed-record', 'proposal names no files');
  }
  const seen = new Set();
  for (const file of proposal.files) {
    exactKeys(file, ['fileId', 'kind', 'path', 'baseContentHash', 'targetContentHex',
      'acceptedRevision'], 'proposal file');
    if (typeof file.fileId !== 'string' || !file.fileId) {
      throw new IncomingError('malformed-record', 'file identity is invalid');
    }
    if (seen.has(file.fileId)) {
      throw new IncomingError('malformed-record', `duplicate fileId ${file.fileId}`);
    }
    seen.add(file.fileId);
    if (file.kind !== 'create' && file.kind !== 'update') {
      throw new IncomingError('unsupported-kind',
        'this slice applies creates and updates only; rename and delete are not approved');
    }
    if (file.kind === 'create' && file.baseContentHash !== null) {
      throw new IncomingError('malformed-record', 'a create must have a null base hash');
    }
    if (file.kind === 'update' && !isHash(file.baseContentHash)) {
      throw new IncomingError('malformed-record', 'an update needs a 64-hex base hash');
    }
    checkNotePath(file.path, `proposal path for ${file.fileId}`);
  }
  if (!isHash(String(proposal.planId || '').replace(/^plan-/, '').padEnd(64, '0'))
      && typeof proposal.planId !== 'string') {
    throw new IncomingError('malformed-record', 'planId is invalid');
  }
  return proposal;
}

/*
 * A convenience for the harness and tests: derive a well-formed proposal from an
 * accepted state plus the scripted edits of a synthetic second replica. The
 * plan it carries is produced by the real comparison module, and the applier
 * recomputes it anyway -- this never becomes a trusted input.
 */
function buildProposal({ accepted, snapshot, originReplicaId, targetMetadataRevision, changes }) {
  const acceptedFiles = Object.entries(accepted.identity.files)
    .map(([fileId, entry]) => ({ fileId, path: entry.path, content: entry.content }));
  const byId = new Map(acceptedFiles.map((file) => [file.fileId, file]));
  const targetFiles = acceptedFiles.map((file) => ({
    fileId: file.fileId,
    path: file.path,
    content: snapshot.files.find((item) => item.path === file.path).content,
  }));
  const files = [];
  for (const change of changes) {
    const existing = byId.get(change.fileId);
    const kind = existing ? 'update' : 'create';
    const encoded = encodeNote(change.content, `target content for ${change.fileId}`);
    const current = existing
      ? targetFiles.find((item) => item.fileId === change.fileId)
      : null;
    if (existing) {
      current.content = change.content;
      current.path = change.path;
    } else {
      targetFiles.push({ fileId: change.fileId, path: change.path, content: change.content });
    }
    files.push({
      fileId: change.fileId,
      kind,
      path: change.path,
      baseContentHash: existing
        ? sha256(Buffer.from(
          snapshot.files.find((item) => item.path === existing.path).content, 'utf8'))
        : null,
      targetContentHex: encoded.hex,
      acceptedRevision: change.acceptedRevision,
    });
  }
  const comparison = compareSnapshots(snapshot, {
    schema: TARGET_SCHEMA, complete: true, authorizeMissingDeletes: false,
    files: targetFiles.map((file) => ({
      fileId: file.fileId, path: file.path, content: file.content,
    })),
  });
  if (!comparison.eligibility.eligible) {
    throw new IncomingError('proposal-not-eligible',
      'the synthetic replica state does not produce an eligible comparison',
      { conflicts: comparison.conflicts, invalid: comparison.invalid });
  }
  const body = {
    schema: PROPOSAL_SCHEMA,
    graphId: accepted.graphId,
    base: {
      metadataRevision: accepted.metadataRevision,
      snapshotFingerprint: accepted.acceptedSnapshotFingerprint,
      acceptedTransactionId: accepted.acceptedTransactionId,
    },
    target: { metadataRevision: targetMetadataRevision },
    originReplicaId,
    planId: comparison.plan.planId,
    files: files.sort((a, b) => Buffer.from(a.fileId).compare(Buffer.from(b.fileId))),
  };
  return { ...body, proposalId: digest(stableStringify(body)) };
}

// ----------------------------------------------------------------- preview

/*
 * Phase one. Writes nothing to the graph tree and nothing to the profile tree.
 * Every refusal here is a preflight refusal: no note byte has changed.
 */
function planIncoming(context, input, options = {}) {
  let proposal;
  try { proposal = validateProposal(input); }
  catch (error) { return refuse(error.code || 'malformed-record', error.message, error.detail); }

  try {
    const journal = PI.readJournal(context);
    if (journal.malformed) {
      return refuse('journal-malformed',
        'a journal is present that does not parse; it is retained for review');
    }
    if (journal.value && journal.value.state === 'open') {
      return refuse('transaction-outstanding',
        'an unfinished incoming transaction holds the journal slot for this owned graph',
        { outstandingProposalId: journal.value.approved?.proposalId || null });
    }

    const opened = PI.openGraph(context);
    if (opened.outcome !== 'accepted') {
      /*
       * The store's own refusals already name two of this layer's cases exactly,
       * so they are reported under this layer's vocabulary rather than as a
       * generic "not accepted": a graph whose bytes are ahead of its sidecar is
       * an uncaptured local edit, and a note the sidecar names but disk lacks is
       * an uncaptured local deletion. Both refuse the whole proposal.
       */
      const mapped = { 'snapshot-mismatch': 'local-ahead-of-accepted', 'missing-note': 'missing-base' };
      const code = mapped[opened.code] || 'records-not-accepted';
      return refuse(code,
        code === 'local-ahead-of-accepted'
          ? 'the graph on disk is ahead of the accepted record; capture the local edit first'
          : code === 'missing-base'
            ? 'an accepted note is absent from the graph; a local deletion has not been captured'
            : `the store did not classify the graph as accepted (${opened.outcome}${opened.code ? `: ${opened.code}` : ''})`,
        { outcome: opened.outcome, storeCode: opened.code || null, storeDetail: opened.detail || null });
    }
    const { sidecar, snapshot } = opened;

    if (sidecar.graphId !== proposal.graphId) {
      return refuse('unknown-base', 'the proposal names a different graph lineage');
    }
    if (proposal.base.metadataRevision !== sidecar.metadataRevision
        || proposal.base.snapshotFingerprint !== sidecar.acceptedSnapshotFingerprint
        || proposal.base.acceptedTransactionId !== sidecar.acceptedTransactionId) {
      return refuse('unknown-base',
        'the proposal was computed against a different accepted state; it is not rebased here',
        { expected: {
          metadataRevision: sidecar.metadataRevision,
          snapshotFingerprint: sidecar.acceptedSnapshotFingerprint,
          acceptedTransactionId: sidecar.acceptedTransactionId,
        } });
    }
    if (proposal.target.metadataRevision === sidecar.metadataRevision) {
      return refuse('unknown-base', 'the proposal target revision equals the accepted revision');
    }

    const acceptedFiles = Object.entries(sidecar.identity.files)
      .map(([fileId, entry]) => ({ fileId, path: entry.path, acceptedRevision: entry.acceptedRevision }));
    const acceptedById = new Map(acceptedFiles.map((file) => [file.fileId, file]));
    const acceptedByPath = new Map(acceptedFiles.map((file) => [file.path, file]));
    const proven = provenParents(context, acceptedFiles);

    // ---- per-file preflight: base match, disk state, bounds, parents
    const files = [];
    const diskByPath = new Map();
    for (const file of proposal.files) {
      const { parent } = checkNotePath(file.path, `target path for ${file.fileId}`);
      if (!proven.has(parent)) {
        return refuse('unproven-parent-directory',
          `no accepted file proves that ${parent}/ already exists, so a write there could create it`,
          { fileId: file.fileId, parent });
      }
      if (sidecar.identity.tombstones && sidecar.identity.tombstones[file.fileId]) {
        return refuse('tombstoned-file', `${file.fileId} is tombstoned locally`, { fileId: file.fileId });
      }
      let target;
      try { target = decodeNoteHex(file.targetContentHex, `target content for ${file.fileId}`); }
      catch (error) { return refuse(error.code, error.message, { fileId: file.fileId }); }

      const known = acceptedById.get(file.fileId);
      if (file.kind === 'update' && !known) {
        return refuse('unknown-file', `${file.fileId} is an update but is not enrolled`, { fileId: file.fileId });
      }
      if (file.kind === 'create' && known) {
        return refuse('unknown-file', `${file.fileId} is a create but is already enrolled`, { fileId: file.fileId });
      }
      if (file.kind === 'update' && known.path !== file.path) {
        return refuse('unsupported-kind',
          'changing a path is a rename, which is not approved in this slice',
          { fileId: file.fileId, acceptedPath: known.path, proposedPath: file.path });
      }
      if (file.kind === 'create' && acceptedByPath.has(file.path)) {
        return refuse('collision',
          `${file.path} is already an accepted file under a different identity`, { fileId: file.fileId });
      }

      const disk = stableRead(context, file.path);
      diskByPath.set(file.path, disk);
      if (!disk.stable) {
        return refuse('unstable-read',
          `${file.path} did not read back identically twice; it is being written now`,
          { fileId: file.fileId });
      }
      if (file.kind === 'update') {
        const acceptedContent = sidecar.identity.files[file.fileId].acceptedContentHash;
        if (!disk.present) {
          return refuse('missing-base',
            `${file.path} is absent; a local deletion has not been captured`, { fileId: file.fileId });
        }
        if (`sha256:${disk.hash}` !== acceptedContent) {
          return refuse('local-ahead-of-accepted',
            `${file.path} on disk differs from the accepted record; capture the local edit first`,
            { fileId: file.fileId, acceptedContentHash: acceptedContent, diskContentHash: `sha256:${disk.hash}` });
        }
        if (disk.hash !== file.baseContentHash) {
          return refuse('base-mismatch',
            `${file.path} was proposed against different base bytes`,
            { fileId: file.fileId, proposedBase: file.baseContentHash, diskContentHash: disk.hash });
        }
      } else if (disk.present) {
        return refuse('destination-occupied',
          `${file.path} already exists on disk but is not an accepted file`, { fileId: file.fileId });
      }
      files.push({
        fileId: file.fileId,
        kind: file.kind,
        path: file.path,
        precondition: file.kind === 'create' ? 'absent' : disk.hash,
        beforeImage: {
          presence: disk.present,
          contentHash: disk.present ? disk.hash : null,
          contentHex: disk.present ? disk.bytes.toString('hex') : null,
        },
        targetContentHash: target.hash,
        targetContentHex: target.hex,
        targetText: target.text,
        acceptedRevision: file.acceptedRevision,
      });
    }

    // ---- recompute the plan; the proposal never names revisions on its authority
    const targetFiles = acceptedFiles.map((file) => ({
      fileId: file.fileId,
      path: file.path,
      content: snapshot.files.find((item) => item.path === file.path).content,
    }));
    for (const file of files) {
      const existing = targetFiles.find((item) => item.fileId === file.fileId);
      if (existing) { existing.path = file.path; existing.content = file.targetText; }
      else targetFiles.push({ fileId: file.fileId, path: file.path, content: file.targetText });
    }
    const comparison = compareSnapshots(snapshot, {
      schema: TARGET_SCHEMA, complete: true, authorizeMissingDeletes: false, files: targetFiles,
    });
    if (!comparison.eligibility.eligible) {
      return refuse('comparison-not-eligible',
        'the recomputed comparison is not eligible; nothing is applied',
        { conflicts: comparison.conflicts, invalid: comparison.invalid });
    }
    if (comparison.plan.planId !== proposal.planId) {
      return refuse('plan-mismatch',
        'the recomputed plan differs from the plan the proposal carries',
        { recomputedPlanId: comparison.plan.planId, proposedPlanId: proposal.planId });
    }
    const execution = executePlan({
      sourceSnapshot: snapshot.state, events: comparison.proposedEvents,
      plan: comparison.plan, destinationSnapshot: snapshot.state,
    });
    if (execution.status === 'rejected') {
      return refuse('execution-refused',
        `the executor refused the recomputed plan: ${execution.result.code}`);
    }

    const graphNotes = PI.hashGraphNotes(context);
    const applyOrder = files
      .map((file) => file.fileId)
      .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    const previewBody = {
      schema: PREVIEW_SCHEMA,
      proposalId: proposal.proposalId,
      planId: comparison.plan.planId,
      projectedSnapshotFingerprint: comparison.plan.projectedSnapshotFingerprint,
      graphId: sidecar.graphId,
      base: {
        metadataRevision: sidecar.metadataRevision,
        snapshotFingerprint: sidecar.acceptedSnapshotFingerprint,
        acceptedTransactionId: sidecar.acceptedTransactionId,
      },
      target: { metadataRevision: proposal.target.metadataRevision },
      graphNotes,
      applyOrder,
      files: applyOrder.map((fileId) => {
        const file = files.find((item) => item.fileId === fileId);
        return {
          fileId,
          kind: file.kind,
          path: file.path,
          precondition: file.precondition,
          oldContentHash: file.beforeImage.contentHash,
          oldLength: file.beforeImage.contentHex ? file.beforeImage.contentHex.length / 2 : 0,
          newContentHash: file.targetContentHash,
          newLength: Buffer.from(file.targetContentHex, 'hex').length,
        };
      }),
      limits: [
        'per-file application: an interruption leaves a mixed state; this is not whole-graph atomicity',
        'the helper rechecks the destination immediately before its rename, but recheck and rename are two operations',
        'the cooperative lock serializes participating helper invocations only; Finder, cloud agents and external editors are not excluded',
        'the app-closed gate proves only that the owned experimental build has exited',
        'injected failures establish recovery classification, not power-loss durability',
      ],
    };
    const previewFingerprint = `sha256:${digest(stableStringify(previewBody))}`;
    return {
      outcome: 'preview',
      mutated: false,
      preview: { ...previewBody, previewFingerprint },
      internal: { proposal, sidecar, snapshot, comparison, execution, files, acceptedFiles },
    };
  } catch (error) {
    if (error instanceof IncomingError) return refuse(error.code, error.message, error.detail);
    return refuse('preflight-failed', error.message);
  }
}

// ------------------------------------------------------------------ journal

function journalBody(approved, progress, supersedes) {
  const body = {
    schema: JOURNAL_SCHEMA,
    state: progress.recordsAccepted && progress.closed ? 'closed' : 'open',
    approved,
    approvedHash: `sha256:${digest(stableStringify(approved))}`,
    supersedes: supersedes || null,
    progress: {
      applied: [...progress.applied],
      recordsAccepted: Boolean(progress.recordsAccepted),
      transactionId: progress.transactionId || null,
    },
  };
  return Buffer.from(`${stableStringify(body)}\n`, 'utf8');
}

const APPROVED_KEYS = ['proposalId', 'planId', 'previewFingerprint', 'graphId',
  'graphBinding', 'profileBinding', 'base', 'target', 'applyOrder', 'files'];
const APPROVED_FILE_KEYS = ['kind', 'path', 'precondition', 'beforeImage',
  'targetContentHash', 'targetContentHex', 'acceptedRevision'];

/*
 * Validate a journal hard enough to earn the right to write. Every check below
 * defends against malformed, truncated, stale, superseded, unrelated or
 * accidentally substituted records. None of them defends against a forger who
 * can write into the owned profile directory: hashes here establish internal
 * consistency, not authenticity.
 */
function validateJournal(context, journal, records) {
  /*
   * Order matters: bytes that are present but do not parse are evidence, not an
   * absent journal. Classifying them as absent would let a corrupted record look
   * like "nothing to recover".
   */
  if (journal.malformed || (journal.bytes && !journal.value)) {
    throw new IncomingError('journal-malformed', 'the journal does not parse; it is retained intact');
  }
  if (!journal.value) throw new IncomingError('journal-absent', 'no journal is present');
  if (journal.bytes.length > MAX_JOURNAL_BYTES) {
    throw new IncomingError('journal-too-large', 'the journal exceeds its bound');
  }
  const value = journal.value;
  exactKeys(value, ['schema', 'state', 'approved', 'approvedHash', 'supersedes', 'progress'], 'journal');
  if (value.schema !== JOURNAL_SCHEMA) {
    throw new IncomingError('unsupported-schema', 'journal schema is not supported');
  }
  if (value.state !== 'open' && value.state !== 'closed') {
    throw new IncomingError('malformed-record', 'journal state is invalid');
  }
  exactKeys(value.progress, ['applied', 'recordsAccepted', 'transactionId'], 'journal.progress');
  if (!Array.isArray(value.progress.applied)
      || value.progress.applied.some((id) => typeof id !== 'string')
      || new Set(value.progress.applied).size !== value.progress.applied.length) {
    throw new IncomingError('malformed-record', 'journal progress.applied is invalid');
  }
  if (typeof value.progress.recordsAccepted !== 'boolean') {
    throw new IncomingError('malformed-record', 'journal progress.recordsAccepted is invalid');
  }

  const approved = value.approved;
  exactKeys(approved, APPROVED_KEYS, 'journal.approved');
  if (value.approvedHash !== `sha256:${digest(stableStringify(approved))}`) {
    throw new IncomingError('journal-approved-tampered',
      'the immutable half of the journal does not match its recorded hash');
  }
  if (!isHash(approved.proposalId)) {
    throw new IncomingError('malformed-record', 'journal proposalId is invalid');
  }
  exactKeys(approved.base,
    ['metadataRevision', 'snapshotFingerprint', 'acceptedTransactionId'], 'journal.approved.base');
  exactKeys(approved.target, ['metadataRevision'], 'journal.approved.target');
  exactKeys(approved.graphBinding,
    ['runName', 'graphDirectory', 'graphDevice', 'graphInode'], 'journal.approved.graphBinding');
  exactKeys(approved.profileBinding,
    ['runName', 'profileDirectory', 'profileDevice', 'profileInode'], 'journal.approved.profileBinding');

  if (stableStringify(approved.graphBinding) !== stableStringify(records.graphBinding)
      || stableStringify(approved.profileBinding) !== stableStringify(records.profileBinding)) {
    throw new IncomingError('journal-binding-mismatch',
      'the journal is bound to a different owned run, directory, device or inode',
      { recorded: { graph: approved.graphBinding, profile: approved.profileBinding },
        observed: { graph: records.graphBinding, profile: records.profileBinding } });
  }

  const fileIds = Object.keys(approved.files).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  if (!Array.isArray(approved.applyOrder)
      || stableStringify(approved.applyOrder) !== stableStringify(fileIds)) {
    throw new IncomingError('journal-apply-order-invalid',
      'applyOrder is not the complete, unique, byte-ordered key set of approved.files',
      { applyOrder: approved.applyOrder, fileIds });
  }
  for (const fileId of fileIds) {
    const file = approved.files[fileId];
    exactKeys(file, APPROVED_FILE_KEYS, `journal.approved.files.${fileId}`);
    if (file.kind !== 'create' && file.kind !== 'update') {
      throw new IncomingError('malformed-record', `${fileId} has an unsupported kind`);
    }
    checkNotePath(file.path, `journal path for ${fileId}`);
    exactKeys(file.beforeImage, ['presence', 'contentHash', 'contentHex'],
      `journal.approved.files.${fileId}.beforeImage`);
    const target = decodeNoteHex(file.targetContentHex, `journal target for ${fileId}`);
    if (target.hash !== file.targetContentHash) {
      throw new IncomingError('malformed-record', `${fileId} target hash does not match its bytes`);
    }
    if (file.beforeImage.presence) {
      const before = decodeNoteHex(file.beforeImage.contentHex, `journal before-image for ${fileId}`);
      if (before.hash !== file.beforeImage.contentHash) {
        throw new IncomingError('malformed-record', `${fileId} before-image hash does not match its bytes`);
      }
      if (file.precondition !== file.beforeImage.contentHash) {
        throw new IncomingError('malformed-record', `${fileId} precondition contradicts its before-image`);
      }
    } else if (file.precondition !== 'absent' || file.beforeImage.contentHex !== null
               || file.beforeImage.contentHash !== null) {
      throw new IncomingError('malformed-record', `${fileId} absent before-image is inconsistent`);
    }
  }
  if (value.progress.applied.some((id) => !fileIds.includes(id))) {
    throw new IncomingError('malformed-record', 'progress names a file the journal does not carry');
  }
  return value;
}

// ------------------------------------------------------------ application

function applyOneFile(context, file) {
  PI.putNoteExpecting(context, file.path,
    Buffer.from(file.targetContentHex, 'hex'), file.precondition);
  const verify = stableRead(context, file.path);
  if (!verify.stable || !verify.present || verify.hash !== file.targetContentHash) {
    throw new IncomingError('post-write-verification-failed',
      `${file.path} did not read back as the intended bytes after its write`,
      { expected: file.targetContentHash, observed: verify.hash });
  }
}

function acceptRecords(context, approved, sidecar, files) {
  const request = {
    expectedMetadataRevision: approved.base.metadataRevision,
    metadataRevision: approved.target.metadataRevision,
    files: [],
    tombstones: [],
  };
  const known = new Map(Object.entries(sidecar.identity.files)
    .map(([fileId, entry]) => [fileId, entry]));
  for (const [fileId, entry] of known) {
    const incoming = approved.files[fileId];
    if (incoming) continue;
    const bytes = PI.readNoteBytes(context, entry.path);
    if (bytes === null) {
      throw new IncomingError('missing-note', `${entry.path} vanished before the record step`);
    }
    request.files.push({ fileId, path: entry.path, content: bytes.toString('utf8'),
      acceptedRevision: entry.acceptedRevision });
  }
  for (const fileId of approved.applyOrder) {
    const file = approved.files[fileId];
    const bytes = PI.readNoteBytes(context, file.path);
    if (bytes === null) {
      throw new IncomingError('missing-note', `${file.path} vanished before the record step`);
    }
    request.files.push({ fileId, path: file.path, content: bytes.toString('utf8'),
      acceptedRevision: file.acceptedRevision });
  }
  request.files.sort((a, b) => Buffer.from(a.fileId).compare(Buffer.from(b.fileId)));
  void files;
  return PI.updateIdentity(context, request);
}

/*
 * Phase two. Requires the exact preview fingerprint the operator approved, and
 * proves the owned app is closed before the journal is created and again before
 * every single note write.
 */
function applyIncoming(context, { proposal, approve, gate, failAt = null, supersededSink = null }) {
  const planned = planIncoming(context, proposal);
  if (planned.outcome !== 'preview') return planned;
  if (!approve) {
    return refuse('approval-required',
      'application requires the exact preview fingerprint to be passed back explicitly');
  }
  if (approve !== planned.preview.previewFingerprint) {
    return refuse('preview-stale',
      'the approved preview fingerprint does not match the preview recomputed now',
      { approved: approve, recomputed: planned.preview.previewFingerprint });
  }

  const { sidecar, files } = planned.internal;
  const records = PI.readRecords(context);
  const approved = {
    proposalId: planned.preview.proposalId,
    planId: planned.preview.planId,
    previewFingerprint: planned.preview.previewFingerprint,
    graphId: planned.preview.graphId,
    graphBinding: records.graphBinding,
    profileBinding: records.profileBinding,
    base: planned.preview.base,
    target: planned.preview.target,
    applyOrder: planned.preview.applyOrder,
    files: Object.fromEntries(files.map((file) => [file.fileId, {
      kind: file.kind,
      path: file.path,
      precondition: file.precondition,
      beforeImage: file.beforeImage,
      targetContentHash: file.targetContentHash,
      targetContentHex: file.targetContentHex,
      acceptedRevision: file.acceptedRevision,
    }])),
  };

  const existing = PI.readJournal(context);
  let supersedes = null;
  let slotExpect = 'absent';
  if (existing.value) {
    if (existing.value.state !== 'closed') {
      return refuse('transaction-outstanding', 'the journal slot holds an unfinished transaction');
    }
    supersedes = { proposalId: existing.value.approved.proposalId, journalHash: existing.hash };
    slotExpect = existing.hash.replace(/^sha256:/, '');
    if (typeof supersededSink === 'function') {
      supersededSink({ hash: existing.hash, bytes: existing.bytes.toString('base64') });
    }
  }

  const progress = { applied: [], recordsAccepted: false, transactionId: null, closed: false };
  let bytes = journalBody(approved, progress, supersedes);
  if (bytes.length > MAX_JOURNAL_BYTES) {
    return refuse('journal-too-large',
      `the serialized journal would be ${bytes.length} bytes; the limit is ${MAX_JOURNAL_BYTES}`);
  }

  try { assertAppClosed(gate, 'journal-create'); }
  catch (error) { return refuse(error.code, error.message, error.detail); }

  if (failAt === 'before-journal') {
    return refuse('injected-failure', 'injected failure before the journal was created');
  }

  try { PI.writeJournal(context, bytes, slotExpect); }
  catch (error) {
    return refuse('journal-write-failed', error.message, { storeCode: error.code });
  }

  let journalHash = `sha256:${sha256(bytes)}`;
  const appliedNow = [];
  try {
    for (const fileId of approved.applyOrder) {
      assertAppClosed(gate, `note-write:${fileId}`);
      if (failAt === `before-file:${fileId}`) {
        throw new IncomingError('injected-failure', `injected failure before writing ${fileId}`);
      }
      applyOneFile(context, approved.files[fileId]);
      appliedNow.push(fileId);
      if (failAt === `after-file:${fileId}`) {
        throw new IncomingError('injected-failure',
          `injected failure after writing ${fileId} and before its progress update`);
      }
      progress.applied.push(fileId);
      bytes = journalBody(approved, progress, supersedes);
      PI.writeJournal(context, bytes, journalHash.replace(/^sha256:/, ''));
      journalHash = `sha256:${sha256(bytes)}`;
    }

    assertAppClosed(gate, 'record-step');
    const accepted = acceptRecords(context, approved, sidecar, files);
    if (accepted.outcome !== 'accepted') {
      throw new IncomingError('records-refused',
        `the store refused the identity update: ${accepted.code}`, { storeCode: accepted.code });
    }
    if (failAt === 'after-records') {
      throw new IncomingError('injected-failure',
        'injected failure after the records were accepted and before the journal closed');
    }
    progress.recordsAccepted = true;
    progress.transactionId = accepted.transactionId || accepted.recovered?.transactionId || null;
    progress.closed = true;
    bytes = journalBody(approved, progress, supersedes);
    PI.writeJournal(context, bytes, journalHash.replace(/^sha256:/, ''));
    return {
      outcome: 'applied',
      mutated: true,
      applied: appliedNow,
      transactionId: progress.transactionId,
      metadataRevision: approved.target.metadataRevision,
      preview: planned.preview,
      journalHash: `sha256:${sha256(bytes)}`,
    };
  } catch (error) {
    return interrupted(error.code || 'application-failed', error.message, {
      applied: appliedNow,
      recordsAccepted: progress.recordsAccepted,
      proposalId: approved.proposalId,
      detail: error.detail || null,
      note: 'the journal is retained; recovery reads it and classifies from the bytes on disk',
    });
  }
}

// -------------------------------------------------------------- recovery

/*
 * Rebuild the accepted base snapshot from the journal's before-images plus the
 * untouched files on disk, then recompute the plan and require it to reproduce
 * the journal's planId exactly.
 */
function recomputePlan(context, sidecar, approved) {
  const entries = Object.entries(sidecar.identity.files)
    .map(([fileId, entry]) => ({ fileId, path: entry.path,
      acceptedRevision: entry.acceptedRevision,
      acceptedContentHash: entry.acceptedContentHash }))
    .sort((a, b) => Buffer.from(a.fileId).compare(Buffer.from(b.fileId)));

  let state = createState(sidecar.graphId);
  const materialized = [];
  for (const [index, entry] of entries.entries()) {
    const incoming = approved.files[entry.fileId];
    let content;
    if (incoming && incoming.kind === 'update') {
      if (`sha256:${incoming.beforeImage.contentHash}` !== entry.acceptedContentHash) {
        return { code: 'journal-base-mismatch',
          reason: `the journal before-image for ${entry.fileId} is not the accepted content`,
          detail: { fileId: entry.fileId, beforeImage: incoming.beforeImage.contentHash,
            accepted: entry.acceptedContentHash } };
      }
      content = Buffer.from(incoming.beforeImage.contentHex, 'hex').toString('utf8');
    } else {
      const disk = stableRead(context, entry.path);
      if (!disk.stable) {
        return { code: 'unstable-read', reason: `${entry.path} did not read back identically twice` };
      }
      if (!disk.present || `sha256:${disk.hash}` !== entry.acceptedContentHash) {
        return { code: 'local-ahead-of-accepted',
          reason: `${entry.path} is outside this transaction but differs from the accepted record`,
          detail: { fileId: entry.fileId, accepted: entry.acceptedContentHash,
            disk: disk.present ? `sha256:${disk.hash}` : null } };
      }
      content = disk.bytes.toString('utf8');
    }
    state = applyOperation(state, {
      operationId: `disk-op-${index}`, kind: 'create', fileId: entry.fileId,
      revisionId: entry.acceptedRevision, parentRevisionId: null,
      path: entry.path, content,
    }).state;
    materialized.push({ path: entry.path, content });
  }
  materialized.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const fingerprint = snapshotFingerprint(state);
  if (fingerprint !== approved.base.snapshotFingerprint) {
    return { code: 'journal-base-mismatch',
      reason: 'the base rebuilt from the journal does not match the fingerprint it claims',
      detail: { rebuilt: fingerprint, claimed: approved.base.snapshotFingerprint } };
  }
  const selected = {
    schema: 'f28-selected-snapshot/1',
    generation: digest(`f28-synthetic-generation\0${sidecar.graphId}\0${fingerprint}`),
    snapshotFingerprint: fingerprint,
    state,
    files: materialized,
  };
  const targetFiles = materialized.map((item) => {
    const entry = entries.find((candidate) => candidate.path === item.path);
    return { fileId: entry.fileId, path: item.path, content: item.content };
  });
  for (const fileId of approved.applyOrder) {
    const file = approved.files[fileId];
    const text = Buffer.from(file.targetContentHex, 'hex').toString('utf8');
    const existing = targetFiles.find((item) => item.fileId === fileId);
    if (existing) { existing.path = file.path; existing.content = text; }
    else targetFiles.push({ fileId, path: file.path, content: text });
  }
  targetFiles.sort((a, b) => Buffer.from(a.fileId).compare(Buffer.from(b.fileId)));
  const comparison = compareSnapshots(selected, {
    schema: TARGET_SCHEMA, complete: true, authorizeMissingDeletes: false, files: targetFiles,
  });
  if (!comparison.eligibility.eligible) {
    return { code: 'journal-plan-mismatch',
      reason: 'the recomputed comparison is not eligible',
      detail: { conflicts: comparison.conflicts, invalid: comparison.invalid } };
  }
  if (comparison.plan.planId !== approved.planId) {
    return { code: 'journal-plan-mismatch',
      reason: 'the journal names a plan the comparison module does not reproduce',
      detail: { recomputed: comparison.plan.planId, claimed: approved.planId } };
  }
  return { ok: true, planId: comparison.plan.planId };
}

/*
 * Roll-forward only. Classifies EVERY file before applying ANY of them, so a
 * third state anywhere in the transaction prevents all further note writes.
 */
function recoverIncoming(context, { gate } = {}) {
  let journal;
  let value;
  let records;
  try {
    journal = PI.readJournal(context);
    if (!journal.value && !journal.bytes) return { outcome: 'none', mutated: false };
    records = PI.readRecords(context);
    value = validateJournal(context, journal, records);
  } catch (error) {
    return refuse(error.code || 'journal-invalid', error.message, error.detail);
  }
  if (value.state === 'closed') {
    return { outcome: 'none', mutated: false, code: 'journal-closed',
      proposalId: value.approved.proposalId };
  }

  const approved = value.approved;
  const opened = PI.openGraph(context);
  const sidecar = opened.sidecar || records.sidecar;
  if (!sidecar) return refuse('records-not-accepted', 'no accepted sidecar is present');
  if (sidecar.graphId !== approved.graphId) {
    return refuse('journal-graph-mismatch', 'the journal names a different graph lineage');
  }

  const atBase = sidecar.metadataRevision === approved.base.metadataRevision
    && sidecar.acceptedSnapshotFingerprint === approved.base.snapshotFingerprint
    && sidecar.acceptedTransactionId === approved.base.acceptedTransactionId;
  const atTarget = sidecar.metadataRevision === approved.target.metadataRevision;
  if (!atBase && !atTarget) {
    return refuse('journal-base-mismatch',
      'the journal base matches neither the accepted records nor its own target',
      { accepted: sidecar.metadataRevision, base: approved.base.metadataRevision,
        target: approved.target.metadataRevision });
  }

  // ---- whole-transaction preflight: classify every file before writing any
  const classified = [];
  for (const fileId of approved.applyOrder) {
    const file = approved.files[fileId];
    const disk = stableRead(context, file.path);
    if (!disk.stable) {
      return refuse('unstable-read', `${file.path} did not read back identically twice`,
        { fileId });
    }
    let state;
    if (disk.present && disk.hash === file.targetContentHash) state = 'applied';
    else if (!disk.present && !file.beforeImage.presence) state = 'pending';
    else if (disk.present && file.beforeImage.presence
             && disk.hash === file.beforeImage.contentHash) state = 'pending';
    else state = 'third-state';
    classified.push({ fileId, path: file.path, state,
      diskContentHash: disk.present ? disk.hash : null, present: disk.present });
  }
  const thirdStates = classified.filter((item) => item.state === 'third-state');
  if (thirdStates.length) {
    return {
      outcome: 'third-state',
      mutated: false,
      code: 'third-state',
      reason: 'a file is in neither its before nor its target state; recovery stops before any further note mutation',
      classified,
      thirdStates,
      note: 'nothing was rolled back, nothing was reapplied, every before-image and journal byte is retained',
    };
  }

  const progressDisagreement = classified.filter((item) =>
    (item.state === 'applied') !== value.progress.applied.includes(item.fileId));

  /*
   * The plan is RECOMPUTED, never echoed. A partially applied graph cannot
   * rebuild the base snapshot from disk, so the base is rebuilt from the
   * journal's own before-images -- each of which is first checked against the
   * accepted sidecar's content hash, so a journal cannot smuggle in a base the
   * records never accepted. Files outside the transaction must still be at
   * their accepted bytes on disk.
   */
  if (atBase) {
    const verdict = recomputePlan(context, sidecar, approved);
    if (verdict.code) return refuse(verdict.code, verdict.reason, verdict.detail || {});
  }

  const pending = classified.filter((item) => item.state === 'pending');
  let wrote = [];
  try {
    if (pending.length) {
      assertAppClosed(gate, 'recovery-note-writes');
      if (atTarget) {
        return refuse('journal-base-mismatch',
          'the records already advanced while files remain unapplied; this needs review, not a roll-forward',
          { classified });
      }
      for (const item of pending) {
        assertAppClosed(gate, `recovery-note-write:${item.fileId}`);
        const file = approved.files[item.fileId];
        // Recheck immediately before this write, through the helper's own
        // precondition. Still a recheck-then-rename, not a compare-and-swap.
        applyOneFile(context, file);
        wrote.push(item.fileId);
      }
    }
  } catch (error) {
    return interrupted(error.code || 'recovery-write-failed', error.message,
      { wrote, classified, detail: error.detail || null });
  }

  let transactionId = value.progress.transactionId;
  let recordsAccepted = atTarget;
  try {
    if (!atTarget) {
      assertAppClosed(gate, 'recovery-record-step');
      const accepted = acceptRecords(context, approved, sidecar, null);
      if (accepted.outcome !== 'accepted') {
        return interrupted('records-refused',
          `the store refused the identity update during recovery: ${accepted.code}`,
          { wrote, classified, storeCode: accepted.code });
      }
      transactionId = accepted.transactionId || accepted.recovered?.transactionId || null;
      recordsAccepted = true;
    }
    const closed = journalBody(approved,
      { applied: approved.applyOrder, recordsAccepted, transactionId, closed: true },
      value.supersedes);
    PI.writeJournal(context, closed, journal.hash.replace(/^sha256:/, ''));
    return {
      outcome: 'recovered',
      mutated: wrote.length > 0,
      wrote,
      classified,
      progressDisagreement,
      recordsAlreadyAccepted: atTarget,
      transactionId,
      metadataRevision: approved.target.metadataRevision,
      proposalId: approved.proposalId,
    };
  } catch (error) {
    return interrupted(error.code || 'recovery-failed', error.message,
      { wrote, classified, detail: error.detail || null });
  }
}

module.exports = {
  IncomingError,
  JOURNAL_SCHEMA,
  MAX_JOURNAL_BYTES,
  MAX_NOTE_BYTES,
  PREVIEW_SCHEMA,
  PROPOSAL_SCHEMA,
  applyIncoming,
  buildProposal,
  checkNotePath,
  decodeNoteHex,
  encodeNote,
  journalBody,
  planIncoming,
  recomputePlan,
  recoverIncoming,
  stableRead,
  validateJournal,
  validateProposal,
};
