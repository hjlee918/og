'use strict';
//
// ONE synthetic graph per batch, reused safely.
//
// Earlier runs created a fresh graph on every attempt, which left seventeen
// folders in the shared Logseq Test root while the checks were being worked
// out. This keeps one graph for the batch and reuses it, but only after
// proving it is still ours and still intact:
//
//   * canonical containment inside the permitted root (traversal and symlink
//     escape rejected),
//   * every file the generator wrote still present and byte-identical to what
//     the templates produce now,
//
// and it never deletes, resets or renames anything -- a graph that fails those
// checks is left untouched and a new one is created beside it.
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const B = require('./allowed-root.js');
const graphGen = require('./make-synthetic-graph.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function expectedFiles() {
  const out = {};
  for (const [name, body] of Object.entries(graphGen.PAGES)) {
    out[`pages/${name}`] = sha256(Buffer.from(body, 'utf8'));
  }
  return out;
}

function verifyReusable(graph) {
  const problems = [];
  try {
    B.assertInsideAllowedRoot('batch graph', graph);
  } catch (e) {
    return { ok: false, problems: [`containment: ${e.message}`] };
  }
  if (!fs.existsSync(path.join(graph, 'logseq', 'config.edn'))) {
    problems.push('logseq/config.edn is missing');
  }
  for (const [rel, want] of Object.entries(expectedFiles())) {
    const p = path.join(graph, rel);
    let got;
    try { got = sha256(fs.readFileSync(p)); } catch (e) { problems.push(`${rel}: ${e.code || e.message}`); continue; }
    if (got !== want) problems.push(`${rel}: content differs from the template`);
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
