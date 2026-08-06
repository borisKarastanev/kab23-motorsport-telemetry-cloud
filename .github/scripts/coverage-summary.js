#!/usr/bin/env node
'use strict';

/**
 * Renders one `coverage-summary.json` as a markdown table.
 *
 * Both coverage tools this repo runs — Jest for the backend, vitest's
 * `@vitest/coverage-v8` for the frontend — produce the same Istanbul-shaped
 * `json-summary` reporter output: `{ total: { statements, branches, functions,
 * lines } }`, each a `{ total, covered, pct }`. One renderer for both, so the
 * number on a job's own step summary and the number in the combined PR
 * comment (`coverage-comment` job in ci.yml) come from the same code path and
 * cannot format the same number two different ways.
 *
 * Runnable standalone — `node coverage-summary.js <title> <path>` — for a
 * job's own `$GITHUB_STEP_SUMMARY` right after its test step, and importable
 * — `require('./coverage-summary').renderCoverageBlock(...)` — for the
 * combined job, which needs both backend and frontend numbers in one comment
 * body built with `actions/github-script`.
 */
const fs = require('fs');

function renderCoverageBlock(title, summaryPath) {
  if (!fs.existsSync(summaryPath)) {
    return (
      `### ${title}\n\n` +
      `_No coverage report found at \`${summaryPath}\` — the test step may ` +
      `not have run, or failed before producing one._\n`
    );
  }

  const { total } = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const row = (label, key) => {
    const metric = total[key];
    return `| ${label} | ${metric.pct.toFixed(2)}% | ${metric.covered} / ${metric.total} |`;
  };

  return [
    `### ${title}`,
    '',
    '| Metric | Coverage | Covered / Total |',
    '| --- | --- | --- |',
    row('Statements', 'statements'),
    row('Branches', 'branches'),
    row('Functions', 'functions'),
    row('Lines', 'lines'),
    '',
  ].join('\n');
}

if (require.main === module) {
  const [title, summaryPath] = process.argv.slice(2);
  if (!title || !summaryPath) {
    console.error(
      'usage: coverage-summary.js <title> <path to coverage-summary.json>',
    );
    process.exit(1);
  }
  console.log(renderCoverageBlock(title, summaryPath));
}

module.exports = { renderCoverageBlock };
