// Warns (never fails) when a PR removes or changes existing locale keys.
// Locale files are edited both by devs and by Shopify ("Edit default theme content"),
// so PRs should only add new keys.

const { execFileSync } = require('child_process');

const MAX_WARNINGS_PER_FILE = 20;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function readAt(sha, file) {
  try {
    return git(['show', `${sha}:${file}`]);
  } catch {
    return null;
  }
}

// Shopify-generated files can start with a /* ... */ header comment.
function parseLocale(content) {
  const json = content.replace(/^\s*\/\*[\s\S]*?\*\//, '');
  return JSON.parse(json);
}

function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out[path] = JSON.stringify(value);
    }
  }
  return out;
}

function findProblems(file, mergeBase, headSha) {
  const before = readAt(mergeBase, file);
  if (before === null) return []; // new locale file

  const after = readAt(headSha, file);
  if (after === null) return ['locale file was deleted'];

  const oldKeys = flatten(parseLocale(before));
  const newKeys = flatten(parseLocale(after));
  const problems = [];

  for (const key of Object.keys(oldKeys)) {
    if (!(key in newKeys)) {
      problems.push(`removed key "${key}"`);
    } else if (oldKeys[key] !== newKeys[key]) {
      problems.push(`changed key "${key}"`);
    }
  }
  return problems;
}

function report(file, problems) {
  problems.slice(0, MAX_WARNINGS_PER_FILE).forEach((problem) => {
    console.log(`::warning file=${file}::${problem}`);
  });

  const hidden = problems.length - MAX_WARNINGS_PER_FILE;
  if (hidden > 0) {
    console.log(`::warning file=${file}::...and ${hidden} more`);
  }
}

function main() {
  const [baseSha, headSha, ...files] = process.argv.slice(2);
  const mergeBase = git(['merge-base', baseSha, headSha]).trim();
  let total = 0;

  for (const file of files) {
    try {
      const problems = findProblems(file, mergeBase, headSha);
      report(file, problems);
      total += problems.length;
    } catch (error) {
      console.log(`::warning file=${file}::could not parse locale file (${error.message})`);
    }
  }

  console.log(
    total
      ? `Found ${total} removed or changed locale keys. PRs should only add new keys.`
      : 'Locale files: only new keys added.'
  );
}

main();
