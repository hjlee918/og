'use strict';
//
// ONE synthetic graph per batch, reused safely.
//
// Repeated attempts must not litter the shared Logseq Test root, and must not
// silently pick up a folder that is no longer ours. This keeps one graph for
// the feature batch and reuses it, but only after proving, PER FILE:
//
//   * canonical containment inside the permitted root (traversal and symlink
//     escape rejected), for the graph, its config and every page;
//   * that the file is a regular file and not a symbolic link;
//   * that its bytes are still exactly what this batch's templates produce.
//
// It never deletes, resets or renames anything. A graph that fails any check is
// left untouched and a new one is created beside it, with the reason recorded.
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const B = require('../../f27-pilot/checks/allowed-root.js');
const graphGen = require('./make-outgoing-graph.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function expectedFiles() {
  const out = {};
  for (const [name, body] of Object.entries(graphGen.PAGES)) {
    out[`pages/${name}`] = sha256(Buffer.from(body, 'utf8'));
  }
  out['logseq/config.edn'] = sha256(Buffer.from(graphGen.CONFIG, 'utf8'));
  return out;
}

function verifyReusable(graph) {
  const problems = [];
  try {
    B.assertInsideAllowedRoot('batch graph', graph);
  } catch (e) {
    return { ok: false, problems: [`containment: ${e.message}`] };
  }
  for (const [rel, want] of Object.entries(expectedFiles())) {
    const p = path.join(graph, rel);
    try {
      B.assertInsideAllowedRoot('batch file', p);
      // A regular file, not a link: containment of the PATH is not containment
      // of what reading it would reach.
      const st = fs.lstatSync(p);
      if (!st.isFile()) { problems.push(`${rel}: not a regular file`); continue; }
      if (sha256(fs.readFileSync(p)) !== want) {
        problems.push(`${rel}: content differs from this batch's template`);
      }
    } catch (e) {
      problems.push(`${rel}: ${e.code || e.message}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * @param {string} stateFile where the batch's graph path is recorded
 * @returns {{graph:string, reused:boolean, problems:string[]}}
 */
function ensure(stateFile) {
  let recorded = null;
  try { recorded = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { recorded = null; }

  if (recorded && typeof recorded.graph === 'string') {
    const v = verifyReusable(recorded.graph);
    if (v.ok) return { graph: recorded.graph, reused: true, problems: [] };
    // Left exactly as it is. Nothing in the shared root is ever removed here.
    const built = graphGen.build();
    fs.writeFileSync(stateFile, JSON.stringify(
      { graph: built.graph, at: new Date().toISOString(),
        supersededBecause: v.problems }, null, 2) + '\n');
    return { graph: built.graph, reused: false, problems: v.problems };
  }

  const built = graphGen.build();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(
    { graph: built.graph, at: new Date().toISOString() }, null, 2) + '\n');
  return { graph: built.graph, reused: false, problems: [] };
}

module.exports = { ensure, verifyReusable, expectedFiles };
