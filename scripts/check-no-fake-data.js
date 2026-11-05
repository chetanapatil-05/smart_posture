// scripts/check-no-fake-data.js
// Guardrail script: Fails if repository contains seed/mock/demo/dummy/fake identifiers,
// Math.random in /web or /supabase, or numeric literals used as fake display values in /web.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGET_DIRS = ['web', 'supabase', 'scripts'];
const IGNORE_DIRS = ['node_modules', 'dist', '.git', '.gemini'];
const ALLOWED_FILES = [
  'docs/example-payload.json',
  'scripts/check-no-fake-data.js',
];

// 1. Forbidden identifiers / words
const FORBIDDEN_IDENTIFIERS = [
  /\b(seed|mock|demo|dummy|fake)\b/i,
];

// 2. Forbidden random generator in runtime code
const FORBIDDEN_RANDOM = /Math\.random\s*\(/;

// 3. Forbidden hardcoded mockup numbers used as display values in web
const FORBIDDEN_DISPLAY_NUMBERS = [
  /\b82\b/,
  /\b76\b/,
  /\b42\b/,
  /82\/100/,
  /76%/,
];

let violations = [];

function checkFile(filePath) {
  const relPath = path.relative(ROOT, filePath).replace(/\\/g, '/');
  if (ALLOWED_FILES.includes(relPath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();

    // Check Math.random in /web or /supabase
    if ((relPath.startsWith('web/') || relPath.startsWith('supabase/')) && FORBIDDEN_RANDOM.test(line)) {
      violations.push({
        file: relPath,
        line: lineNum,
        rule: 'Math.random is strictly forbidden in runtime code',
        snippet: trimmed,
      });
    }

    // Check hardcoded display numbers in /web
    if (relPath.startsWith('web/')) {
      for (const pattern of FORBIDDEN_DISPLAY_NUMBERS) {
        if (pattern.test(line)) {
          violations.push({
            file: relPath,
            line: lineNum,
            rule: `Forbidden hardcoded display value (${pattern}) found in frontend`,
            snippet: trimmed,
          });
        }
      }
    }

    // Check forbidden identifiers (excluding comment-only mentions)
    // Strip string comments for identifier check
    const codeOnly = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    for (const pattern of FORBIDDEN_IDENTIFIERS) {
      if (pattern.test(codeOnly)) {
        violations.push({
          file: relPath,
          line: lineNum,
          rule: `Forbidden fake-data identifier matched ${pattern}`,
          snippet: trimmed,
        });
      }
    }
  });
}

function walk(dir) {
  const fullDir = path.resolve(ROOT, dir);
  if (!fs.existsSync(fullDir)) return;

  const entries = fs.readdirSync(fullDir, { withFileTypes: true });
  for (const ent of entries) {
    if (IGNORE_DIRS.includes(ent.name)) continue;
    const fullPath = path.join(fullDir, ent.name);
    if (ent.isDirectory()) {
      walk(fullPath);
    } else if (/\.(js|ts|html|css|json)$/i.test(ent.name)) {
      checkFile(fullPath);
    }
  }
}

console.log('--- Running Guardrail: check:no-fake-data ---');
for (const dir of TARGET_DIRS) {
  walk(dir);
}

if (violations.length > 0) {
  console.error(`\n❌ FAILED: Found ${violations.length} fake-data guardrail violation(s):\n`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line} [${v.rule}]`);
    console.error(`    "${v.snippet}"\n`);
  }
  process.exit(1);
} else {
  console.log('✅ PASSED: Zero fake-data identifiers, Math.random calls, or hardcoded display values detected.');
  console.log('   All dashboard and backend components are strictly real-data driven.\n');
  process.exit(0);
}
