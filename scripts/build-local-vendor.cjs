const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const source = path.resolve(repoRoot, '..', 'heavy-file-format', 'dist-embed');
const target = path.join(repoRoot, 'vendor', 'heavy-file-format', 'dist-embed');
const entry = path.join(source, 'hvy-embed.js');

if (!fs.existsSync(entry)) {
  console.error(`Missing ${entry}`);
  console.error('Run npm run build:embed in ../heavy-file-format before packaging.');
  process.exit(1);
}

fs.rmSync(target, { force: true, recursive: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });
sanitizeBundledEnv(target);

console.log(`Copied ${source} -> ${target}`);

function sanitizeBundledEnv(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      sanitizeBundledEnv(fullPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }

    const original = fs.readFileSync(fullPath, 'utf8');
    const sanitized = original.replace(
      /(VITE_(?:OPENAI|ANTHROPIC|QWEN)_API_KEY:\s*)["'][^"']*["']/g,
      '$1""'
    );
    if (sanitized !== original) {
      fs.writeFileSync(fullPath, sanitized);
    }
  }
}
