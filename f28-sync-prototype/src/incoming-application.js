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

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new IncomingError('malformed-record', `${label} must be a non-empty string without NUL`);
  }
  return value;
}

/*
 * The canonical body a proposal's identity is computed over: every field except
 * the identity itself. Recomputing it is what makes a changed body a changed
 * proposal, instead of the same proposal wearing its old ID.
 */
function proposalBody(proposal) {
  return {
    schema: proposal.schema,
    graphId: proposal.graphId,
    base: proposal.base,
    target: proposal.target,
    originReplicaId: proposal.originReplicaId,
    planId: proposal.planId,
    files: proposal.files,
  };
}

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
  requireText(proposal.graphId, 'proposal.graphId');
  requireText(proposal.originReplicaId, 'proposal.originReplicaId');
  /*
   * The plan identity is a fixed shape produced by the planner. The earlier
   * placeholder condition here could never throw for any string, which let a
   * proposal name an arbitrary plan; it is replaced by the exact form.
   */
  if (typeof proposal.planId !== 'string' || !/^plan-[0-9a-f]{32}$/.test(proposal.planId)) {
    throw new IncomingError('malformed-record', 'planId is not a well-formed plan identity');
  }
  exactKeys(proposal.base,
    ['metadataRevision', 'snapshotFingerprint', 'acceptedTransactionId'], 'proposal.base');
  requireText(proposal.base.metadataRevision, 'proposal.base.metadataRevision');
  if (!/^sha256:[0-9a-f]{64}$/.test(String(proposal.base.snapshotFingerprint))) {
    throw new IncomingError('malformed-record', 'proposal.base.snapshotFingerprint is malformed');
  }
  if (!isHash(proposal.base.acceptedTransactionId)) {
    throw new IncomingError('malformed-record', 'proposal.base.acceptedTransactionId must be 64 hex');
  }
  exactKeys(proposal.target, ['metadataRevision'], 'proposal.target');
  requireText(proposal.target.metadataRevision, 'proposal.target.metadataRevision');

  if (!Array.isArray(proposal.files) || proposal.files.length === 0) {
    throw new IncomingError('malformed-record', 'proposal names no files');
  }
  const seen = new Set();
  for (const file of proposal.files) {
    /*
     * `acceptedRevision` is deliberately NOT part of a proposal. The revision
     * that gets stored is derived from the executed comparison plan, never
     * chosen by whoever sent the change.
     */
    exactKeys(file, ['fileId', 'kind', 'path', 'baseContentHash', 'targetContentHex'],
      'proposal file');
    requireText(file.fileId, 'proposal file fileId');
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
    if (typeof file.targetContentHex !== 'string') {
      throw new IncomingError('malformed-record', 'targetContentHex must be a string');
    }
    checkNotePath(file.path, `proposal path for ${file.fileId}`);
  }

  const recomputed = digest(stableStringify(proposalBody(proposal)));
  if (recomputed !== proposal.proposalId) {
    throw new IncomingError('proposal-identity-mismatch',
      'the proposal identity does not match its own contents',
      { recomputed, claimed: proposal.proposalId });
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
  return { ...body, proposalId: digest(stableStringify(proposalBody(body))) };
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
    /*
     * The journal slot holds one transaction per owned run and is never reused,
     * so a retained journal of ANY kind refuses here too. Producing an
     * approvable preview for something application will refuse would only invite
     * an operator to approve it.
     */
    const journal = PI.readJournal(context);
    if (journal.bytes) {
      const openJournal = Boolean(journal.value) && !journal.malformed
        && journal.value.state === 'open';
      const unparseable = journal.malformed || !journal.value;
      return refuse(
        unparseable ? 'journal-malformed' : openJournal ? 'transaction-outstanding'
          : 'journal-slot-occupied',
        unparseable
          ? 'a journal is present that does not parse; it is retained for review'
          : openJournal
            ? 'an unfinished incoming transaction holds the journal slot for this owned graph'
            : 'a retained journal holds the slot; it is not overwritten, so use a fresh owned run',
        { retainedJournalHash: journal.hash,
          retainedProposalId: journal.value?.approved?.proposalId || null });
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

    const records = PI.readRecords(context);
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

    /*
     * The accepted revision each file will be STORED under comes from the
     * executed comparison plan -- a deterministic compare-revision -- never from
     * the proposal. Files the plan does not touch keep the revision the accepted
     * sidecar already names.
     */
    const plannedRevision = new Map(comparison.plan.actions
      .map((action) => [action.operation.fileId, action.operation.revisionId]));
    for (const file of files) {
      const revision = plannedRevision.get(file.fileId);
      if (!revision) {
        return refuse('plan-mismatch',
          `the recomputed plan contains no action for ${file.fileId}`, { fileId: file.fileId });
      }
      file.acceptedRevision = revision;
    }
    const changedIds = new Set(files.map((file) => file.fileId));
    const unchanged = {};
    for (const entry of acceptedFiles) {
      if (changedIds.has(entry.fileId)) continue;
      unchanged[entry.fileId] = {
        path: entry.path,
        contentHash: sidecar.identity.files[entry.fileId].acceptedContentHash,
        acceptedRevision: plannedRevision.get(entry.fileId) || entry.acceptedRevision,
      };
    }

    /*
     * The exact snapshot, transaction and record bytes this transaction intends
     * to publish, computed BEFORE anything is written, so the approval binds
     * them and recovery can prove them afterwards instead of inferring
     * completion from a revision label.
     */
    const projectedFiles = [
      ...Object.entries(unchanged).map(([fileId, entry]) => ({
        fileId, path: entry.path, acceptedRevision: entry.acceptedRevision,
        content: snapshot.files.find((item) => item.path === entry.path).content,
      })),
      ...files.map((file) => ({
        fileId: file.fileId, path: file.path,
        acceptedRevision: file.acceptedRevision, content: file.targetText,
      })),
    ];
    let intended;
    try {
      const projectedSnapshot = PI.snapshotFromFiles(sidecar.graphId, projectedFiles);
      const derived = PI.deriveUpdate({
        accepted: sidecar,
        probe: records,
        request: {
          metadataRevision: proposal.target.metadataRevision,
          files: projectedFiles.map((file) => ({
            fileId: file.fileId, path: file.path, content: file.content,
            acceptedRevision: file.acceptedRevision,
          })),
        },
        snapshot: projectedSnapshot,
      });
      intended = {
        metadataRevision: proposal.target.metadataRevision,
        snapshotFingerprint: projectedSnapshot.snapshotFingerprint,
        transactionId: derived.transactionId,
        sidecarHash: PI.bytesHash(derived.sidecarBytes),
        deviceHash: PI.bytesHash(derived.deviceBytes),
      };
    } catch (error) {
      return refuse('projection-failed',
        `the intended post-application state could not be derived: ${error.message}`);
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
      target: intended,
      unchanged,
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
          acceptedRevision: file.acceptedRevision,
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

function journalBody(approved, progress) {
  const body = {
    schema: JOURNAL_SCHEMA,
    state: progress.recordsAccepted && progress.closed ? 'closed' : 'open',
    approved,
    approvedHash: `sha256:${digest(stableStringify(approved))}`,
    progress: {
      applied: [...progress.applied],
      recordsAccepted: Boolean(progress.recordsAccepted),
      transactionId: progress.transactionId || null,
    },
  };
  return Buffer.from(`${stableStringify(body)}\n`, 'utf8');
}

const APPROVED_KEYS = ['proposalId', 'planId', 'previewFingerprint', 'graphId',
  'graphBinding', 'profileBinding', 'base', 'target', 'applyOrder', 'files', 'unchanged'];
const APPROVED_FILE_KEYS = ['kind', 'path', 'precondition', 'beforeImage',
  'targetContentHash', 'targetContentHex', 'acceptedRevision'];
const TARGET_KEYS = ['metadataRevision', 'snapshotFingerprint', 'transactionId',
  'sidecarHash', 'deviceHash'];

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
  exactKeys(value, ['schema', 'state', 'approved', 'approvedHash', 'progress'], 'journal');
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
  exactKeys(approved.target, TARGET_KEYS, 'journal.approved.target');
  requireText(approved.target.metadataRevision, 'journal.approved.target.metadataRevision');
  if (!/^sha256:[0-9a-f]{64}$/.test(String(approved.target.snapshotFingerprint))
      || !isHash(approved.target.transactionId)
      || !/^sha256:[0-9a-f]{64}$/.test(String(approved.target.sidecarHash))
      || !/^sha256:[0-9a-f]{64}$/.test(String(approved.target.deviceHash))) {
    throw new IncomingError('malformed-record',
      'the journal target does not bind a well-formed snapshot, transaction and record pair');
  }
  if (!approved.unchanged || typeof approved.unchanged !== 'object'
      || Array.isArray(approved.unchanged)) {
    throw new IncomingError('malformed-record', 'journal.approved.unchanged is invalid');
  }
  for (const [fileId, entry] of Object.entries(approved.unchanged)) {
    exactKeys(entry, ['path', 'contentHash', 'acceptedRevision'],
      `journal.approved.unchanged.${fileId}`);
    requireText(entry.path, `unchanged path for ${fileId}`);
    requireText(entry.acceptedRevision, `unchanged acceptedRevision for ${fileId}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(String(entry.contentHash))) {
      throw new IncomingError('malformed-record', `unchanged contentHash for ${fileId} is malformed`);
    }
  }
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
    requireText(file.acceptedRevision, `journal acceptedRevision for ${fileId}`);
    if (Object.prototype.hasOwnProperty.call(approved.unchanged, fileId)) {
      throw new IncomingError('malformed-record',
        `${fileId} appears both as a changed and an unchanged file`);
    }
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

/*
 * Revalidate the complete intended state, then publish.
 *
 * Rereading current bytes and stamping the intended revision on them would
 * silently adopt whatever happens to be on disk -- an unrelated local edit to a
 * file outside the transaction, or a transaction file that no longer holds its
 * approved target. Both are refused here and named for what they are.
 *
 * This narrows the window; it does not remove it. A writer that does not honour
 * the cooperative lock can still change a file between this validation and the
 * store's own reads, and that race is unchanged by this check.
 */
function revalidateIntendedState(context, approved) {
  const drift = [];
  const projected = [];
  for (const fileId of approved.applyOrder) {
    const file = approved.files[fileId];
    const disk = stableRead(context, file.path);
    if (!disk.stable) {
      return { code: 'unstable-read', reason: `${file.path} did not read back identically twice`,
        detail: { fileId } };
    }
    if (!disk.present || disk.hash !== file.targetContentHash) {
      drift.push({ fileId, path: file.path, kind: 'target-divergence',
        expected: file.targetContentHash, observed: disk.present ? disk.hash : null });
      continue;
    }
    projected.push({ fileId, path: file.path, content: disk.bytes.toString('utf8'),
      acceptedRevision: file.acceptedRevision });
  }
  for (const [fileId, entry] of Object.entries(approved.unchanged)) {
    const disk = stableRead(context, entry.path);
    if (!disk.stable) {
      return { code: 'unstable-read', reason: `${entry.path} did not read back identically twice`,
        detail: { fileId } };
    }
    if (!disk.present || `sha256:${disk.hash}` !== entry.contentHash) {
      drift.push({ fileId, path: entry.path, kind: 'unrelated-local-change',
        expected: entry.contentHash, observed: disk.present ? `sha256:${disk.hash}` : null });
      continue;
    }
    projected.push({ fileId, path: entry.path, content: disk.bytes.toString('utf8'),
      acceptedRevision: entry.acceptedRevision });
  }
  if (drift.length) {
    const unrelated = drift.some((item) => item.kind === 'unrelated-local-change');
    return {
      code: unrelated ? 'unrelated-local-change' : 'target-divergence',
      reason: unrelated
        ? 'a file outside this transaction differs from the accepted record; it is not adopted'
        : 'a file in this transaction no longer holds its approved target bytes',
      detail: { drift },
    };
  }
  const snapshot = PI.snapshotFromFiles(approved.graphId, projected);
  if (snapshot.snapshotFingerprint !== approved.target.snapshotFingerprint) {
    return { code: 'projection-mismatch',
      reason: 'the state on disk does not fingerprint as the approved projection',
      detail: { observed: snapshot.snapshotFingerprint,
        approved: approved.target.snapshotFingerprint } };
  }
  return { ok: true, projected, snapshot };
}

function acceptRecords(context, approved, options = {}) {
  const verdict = revalidateIntendedState(context, approved);
  if (verdict.code) return { outcome: 'refused', code: verdict.code, reason: verdict.reason,
    detail: verdict.detail };
  const request = {
    expectedMetadataRevision: approved.base.metadataRevision,
    metadataRevision: approved.target.metadataRevision,
    files: verdict.projected.map((file) => ({
      fileId: file.fileId, path: file.path, content: file.content,
      acceptedRevision: file.acceptedRevision,
    })).sort((a, b) => Buffer.from(a.fileId).compare(Buffer.from(b.fileId))),
    tombstones: [],
  };

  /*
   * Check the binding BEFORE publishing, not after. Re-deriving here costs one
   * pure computation and means a journal naming a transaction, snapshot or
   * record pair other than the one these inputs produce is refused with nothing
   * written, instead of being caught after the store has already published.
   */
  const probe = PI.readRecords(context);
  if (!probe.sidecar || !probe.device) {
    return { outcome: 'refused', code: 'not-enrolled', reason: 'the records are not both present' };
  }
  let derived;
  try {
    derived = PI.deriveUpdate({ accepted: probe.sidecar, probe, request, snapshot: verdict.snapshot });
  } catch (error) {
    return { outcome: 'refused', code: 'projection-failed', reason: error.message };
  }
  const bindingMismatch = [];
  if (derived.transactionId !== approved.target.transactionId) bindingMismatch.push('transactionId');
  if (PI.bytesHash(derived.sidecarBytes) !== approved.target.sidecarHash) bindingMismatch.push('sidecarHash');
  if (PI.bytesHash(derived.deviceBytes) !== approved.target.deviceHash) bindingMismatch.push('deviceHash');
  if (bindingMismatch.length) {
    return { outcome: 'refused', code: 'transaction-mismatch',
      reason: 'these inputs do not produce the transaction and records the approval bound',
      detail: { bindingMismatch,
        derived: { transactionId: derived.transactionId,
          sidecarHash: PI.bytesHash(derived.sidecarBytes),
          deviceHash: PI.bytesHash(derived.deviceBytes) },
        approved: approved.target } };
  }

  const result = PI.updateIdentity(context, request, options);
  if (result.outcome === 'accepted'
      && result.transactionId !== approved.target.transactionId) {
    return { outcome: 'refused', code: 'transaction-mismatch',
      reason: 'the store published a transaction other than the approved one',
      detail: { published: result.transactionId, approved: approved.target.transactionId } };
  }
  return result;
}

/*
 * The post-condition. Nothing closes an incoming journal without this passing.
 *
 * A metadata revision label is not acceptance: an outstanding intent, a
 * malformed record, a device record left at base, or record bytes other than the
 * ones the approval bound all mean the record-store transaction is unresolved.
 */
function proveRecordsAccepted(context, approved) {
  const records = PI.readRecords(context);
  if (records.malformed.length) {
    return { accepted: false, code: 'malformed-record',
      reason: 'a record does not parse', detail: { malformed: records.malformed } };
  }
  if (records.outstandingIntents.length) {
    return { accepted: false, code: 'outstanding-intent',
      reason: 'an identity transaction is still outstanding in the record store',
      detail: { outstandingIntents: records.outstandingIntents }, records };
  }
  const opened = PI.openGraph(context);
  if (opened.outcome !== 'accepted') {
    return { accepted: false, code: opened.code || 'records-not-accepted',
      reason: `the store does not classify the graph as accepted (${opened.outcome})`,
      detail: { outcome: opened.outcome, storeCode: opened.code || null } };
  }
  const { sidecar, device } = opened;
  const target = approved.target;
  const mismatches = [];
  if (sidecar.graphId !== approved.graphId) mismatches.push('graphId');
  if (sidecar.metadataRevision !== target.metadataRevision) mismatches.push('sidecar.metadataRevision');
  if (sidecar.acceptedSnapshotFingerprint !== target.snapshotFingerprint) {
    mismatches.push('sidecar.acceptedSnapshotFingerprint');
  }
  if (sidecar.acceptedTransactionId !== target.transactionId) {
    mismatches.push('sidecar.acceptedTransactionId');
  }
  if (records.sidecarHash !== target.sidecarHash) mismatches.push('sidecarBytes');
  if (records.deviceHash !== target.deviceHash) mismatches.push('deviceBytes');
  if (device.metadataRevision !== target.metadataRevision) mismatches.push('device.metadataRevision');
  if (device.acceptedTransactionId !== target.transactionId) {
    mismatches.push('device.acceptedTransactionId');
  }
  if (mismatches.length) {
    return { accepted: false, code: 'records-do-not-match-approval',
      reason: 'the accepted records are not the ones this approval bound',
      detail: { mismatches,
        observed: { metadataRevision: sidecar.metadataRevision,
          snapshotFingerprint: sidecar.acceptedSnapshotFingerprint,
          transactionId: sidecar.acceptedTransactionId,
          sidecarHash: records.sidecarHash, deviceHash: records.deviceHash },
        approved: target } };
  }
  return { accepted: true, opened, records };
}

/*
 * Phase two. Requires the exact preview fingerprint the operator approved, and
 * proves the owned app is closed before the journal is created and again before
 * every single note write.
 *
 * The journal slot holds ONE transaction per owned run and is never reused. A
 * journal that is present at all -- open, closed or unparseable -- refuses a new
 * proposal, because it carries the only copy of that transaction's before-images
 * and this slice has no approved way to archive it durably first. Another
 * experiment uses a fresh owned run.
 */
function applyIncoming(context, { proposal, approve, gate, failAt = null, recordFailure = null }) {
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

  const { files } = planned.internal;
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
    unchanged: planned.preview.unchanged,
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

  /*
   * The slot is claimed only when it is empty. A retained journal -- including a
   * `closed` one -- is never overwritten: the label is not proof of completion,
   * and the record it holds is the only retained copy of its before-images.
   */
  const existing = PI.readJournal(context);
  if (existing.bytes) {
    const openJournal = Boolean(existing.value) && !existing.malformed
      && existing.value.state === 'open';
    const unparseable = existing.malformed || !existing.value;
    return refuse(
      unparseable ? 'journal-malformed' : openJournal ? 'transaction-outstanding'
        : 'journal-slot-occupied',
      unparseable
        ? 'a journal is present that does not parse; it is retained for review'
        : openJournal
          ? 'an unfinished incoming transaction holds the journal slot for this owned graph'
          : 'a retained journal holds the slot; it is not overwritten, so use a fresh owned run',
      { retainedJournalHash: existing.hash,
        retainedProposalId: existing.value?.approved?.proposalId || null });
  }

  const progress = { applied: [], recordsAccepted: false, transactionId: null, closed: false };
  let bytes = journalBody(approved, progress);
  if (bytes.length > MAX_JOURNAL_BYTES) {
    return refuse('journal-too-large',
      `the serialized journal would be ${bytes.length} bytes; the limit is ${MAX_JOURNAL_BYTES}`);
  }

  try { assertAppClosed(gate, 'journal-create'); }
  catch (error) { return refuse(error.code, error.message, error.detail); }

  if (failAt === 'before-journal') {
    return refuse('injected-failure', 'injected failure before the journal was created');
  }

  try { PI.writeJournal(context, bytes, 'absent'); }
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
      bytes = journalBody(approved, progress);
      PI.writeJournal(context, bytes, journalHash.replace(/^sha256:/, ''));
      journalHash = `sha256:${sha256(bytes)}`;
    }

    assertAppClosed(gate, 'record-step');
    const accepted = acceptRecords(context, approved,
      recordFailure ? { ordering: 'graph-first', failure: recordFailure } : {});
    if (accepted.outcome !== 'accepted') {
      throw new IncomingError(
        String(accepted.outcome || '').startsWith('uncertain')
          ? 'records-uncertain' : 'records-refused',
        `the store did not accept the identity update: ${accepted.code}`,
        { storeOutcome: accepted.outcome, storeCode: accepted.code,
          storeReason: accepted.reason || null, storeDetail: accepted.detail || null });
    }
    if (failAt === 'after-records') {
      throw new IncomingError('injected-failure',
        'injected failure after the records were accepted and before the journal closed');
    }

    /*
     * Prove it, do not assume it. The journal closes only when both records are
     * accepted AND are the exact ones this approval bound.
     */
    const proof = proveRecordsAccepted(context, approved);
    if (!proof.accepted) {
      throw new IncomingError('records-not-proven',
        `the records could not be proven accepted: ${proof.code}`,
        { proofCode: proof.code, proofReason: proof.reason, proofDetail: proof.detail });
    }

    progress.recordsAccepted = true;
    progress.transactionId = approved.target.transactionId;
    progress.closed = true;
    bytes = journalBody(approved, progress);
    PI.writeJournal(context, bytes, journalHash.replace(/^sha256:/, ''));
    return {
      outcome: 'applied',
      mutated: true,
      applied: appliedNow,
      transactionId: approved.target.transactionId,
      metadataRevision: approved.target.metadataRevision,
      snapshotFingerprint: approved.target.snapshotFingerprint,
      preview: planned.preview,
      journalHash: `sha256:${sha256(bytes)}`,
    };
  } catch (error) {
    return interrupted(error.code || 'application-failed', error.message, {
      applied: appliedNow,
      recordsAccepted: progress.recordsAccepted,
      proposalId: approved.proposalId,
      transactionId: approved.target.transactionId,
      detail: error.detail || null,
      note: 'the journal is retained open; recovery reads it, resolves any outstanding identity transaction and classifies from the bytes on disk',
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
 *
 * Nothing here treats a label as a fact. A target metadata revision is not
 * acceptance, and a `closed` journal is not proof of completion: both are
 * checked against the records the approval bound, and an outstanding identity
 * transaction is resolved through the record store's own recovery contract
 * before this layer will close anything.
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

  const approved = value.approved;

  /*
   * A closed journal still has to prove itself. If the records it claims are not
   * the accepted ones, the label is wrong and the state is retained for review
   * rather than reported as a completed transaction.
   */
  if (value.state === 'closed') {
    const proof = proveRecordsAccepted(context, approved);
    if (!proof.accepted) {
      return refuse('closed-journal-not-verified',
        `the journal is labelled closed but the records do not prove it: ${proof.code}`,
        { proofCode: proof.code, proofReason: proof.reason, proofDetail: proof.detail,
          proposalId: approved.proposalId });
    }
    return { outcome: 'none', mutated: false, code: 'journal-closed', verified: true,
      proposalId: approved.proposalId, transactionId: approved.target.transactionId };
  }

  const sidecar = records.sidecar;
  if (!sidecar) return refuse('records-not-accepted', 'no sidecar is present');
  if (records.malformed.length) {
    return refuse('malformed-record', 'a record does not parse; it is retained for review',
      { malformed: records.malformed });
  }
  if (sidecar.graphId !== approved.graphId) {
    return refuse('journal-graph-mismatch', 'the journal names a different graph lineage');
  }

  /*
   * An outstanding identity transaction is only ever OURS or someone else's.
   * Someone else's is never resolved here, and never ignored either.
   */
  const outstanding = records.outstandingIntents;
  if (outstanding.length > 1) {
    return refuse('multiple-outstanding-transactions',
      'more than one identity transaction is outstanding; this needs review',
      { outstanding });
  }
  if (outstanding.length === 1 && outstanding[0] !== approved.target.transactionId) {
    return refuse('unrelated-outstanding-transaction',
      'an identity transaction unrelated to this journal is outstanding; nothing is resolved here',
      { outstanding, approvedTransactionId: approved.target.transactionId });
  }

  const proofBefore = proveRecordsAccepted(context, approved);
  const recordsAlreadyAccepted = proofBefore.accepted;
  const atBase = !recordsAlreadyAccepted
    && outstanding.length === 0
    && sidecar.metadataRevision === approved.base.metadataRevision
    && sidecar.acceptedSnapshotFingerprint === approved.base.snapshotFingerprint
    && sidecar.acceptedTransactionId === approved.base.acceptedTransactionId;

  if (!recordsAlreadyAccepted && !atBase && outstanding.length === 0) {
    return refuse('journal-base-mismatch',
      'the records are neither at this journal\'s base nor provably at its target',
      { accepted: sidecar.metadataRevision, base: approved.base.metadataRevision,
        target: approved.target.metadataRevision,
        proofCode: proofBefore.code, proofReason: proofBefore.reason });
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
  const wrote = [];
  try {
    if (pending.length) {
      if (recordsAlreadyAccepted) {
        return refuse('journal-base-mismatch',
          'the records are already accepted at the target while files remain unapplied; this needs review, not a roll-forward',
          { classified });
      }
      if (outstanding.length) {
        return refuse('outstanding-transaction-with-unapplied-files',
          'an identity transaction is outstanding while files remain unapplied; this needs review',
          { classified, outstanding });
      }
      assertAppClosed(gate, 'recovery-note-writes');
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

  // ---- resolve the record store, through its own recovery contract
  let resolution = recordsAlreadyAccepted ? 'already-accepted' : null;
  try {
    if (!recordsAlreadyAccepted && outstanding.length === 1) {
      assertAppClosed(gate, 'recovery-record-recovery');
      const recoveredStore = PI.recover(context,
        { transactionId: approved.target.transactionId });
      if (recoveredStore.outcome !== 'recovered') {
        return {
          outcome: 'unresolved',
          mutated: wrote.length > 0,
          code: 'identity-transaction-unresolved',
          reason: `the record store did not resolve the outstanding transaction: ${recoveredStore.code || recoveredStore.outcome}`,
          storeOutcome: recoveredStore.outcome,
          storeCode: recoveredStore.code || null,
          wrote,
          classified,
          transactionId: approved.target.transactionId,
          note: 'the incoming journal stays open and every record, intent and before-image is retained',
        };
      }
      resolution = `store-recovered:${recoveredStore.classification}`;
    } else if (!recordsAlreadyAccepted) {
      assertAppClosed(gate, 'recovery-record-step');
      const accepted = acceptRecords(context, approved);
      if (accepted.outcome !== 'accepted') {
        return {
          outcome: String(accepted.outcome || '').startsWith('uncertain') ? 'unresolved' : 'refused',
          mutated: wrote.length > 0,
          code: String(accepted.outcome || '').startsWith('uncertain')
            ? 'identity-transaction-unresolved' : 'records-refused',
          reason: `the store did not accept the identity update during recovery: ${accepted.code}`,
          storeOutcome: accepted.outcome,
          storeCode: accepted.code,
          storeDetail: accepted.detail || null,
          wrote,
          classified,
          note: 'the incoming journal stays open and every retained record is preserved',
        };
      }
      resolution = 'published';
    }
  } catch (error) {
    return interrupted(error.code || 'recovery-record-failed', error.message,
      { wrote, classified, detail: error.detail || null });
  }

  /*
   * Reopen and prove. Both records must be accepted and must be the exact ones
   * this approval bound before the incoming journal may be closed.
   */
  const proof = proveRecordsAccepted(context, approved);
  if (!proof.accepted) {
    return {
      outcome: 'unresolved',
      mutated: wrote.length > 0,
      code: 'records-not-proven',
      reason: `the records could not be proven accepted after recovery: ${proof.code}`,
      proofCode: proof.code,
      proofReason: proof.reason,
      proofDetail: proof.detail,
      wrote,
      classified,
      resolution,
      note: 'the incoming journal stays open; nothing is reported as completed',
    };
  }

  try {
    const closed = journalBody(approved, {
      applied: approved.applyOrder,
      recordsAccepted: true,
      transactionId: approved.target.transactionId,
      closed: true,
    });
    PI.writeJournal(context, closed, journal.hash.replace(/^sha256:/, ''));
  } catch (error) {
    return interrupted(error.code || 'journal-close-failed', error.message,
      { wrote, classified, detail: error.detail || null,
        note: 'the records are accepted and proven; only the journal close failed' });
  }

  return {
    outcome: 'recovered',
    mutated: wrote.length > 0,
    wrote,
    classified,
    progressDisagreement,
    recordsAlreadyAccepted,
    resolution,
    transactionId: approved.target.transactionId,
    metadataRevision: approved.target.metadataRevision,
    snapshotFingerprint: approved.target.snapshotFingerprint,
    proposalId: approved.proposalId,
  };
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
  proposalBody,
  proveRecordsAccepted,
  recomputePlan,
  recoverIncoming,
  revalidateIntendedState,
  stableRead,
  validateJournal,
  validateProposal,
};
