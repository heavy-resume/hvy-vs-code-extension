const fs = require('node:fs');
const path = require('node:path');

const mode = process.argv[2];
const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const dependencyName = 'heavy-file-format-ref-impl';
const values = {
  local: 'file:../heavy-file-format',
  git: 'git+https://github.com/heavy-resume/heavy-file-format.git#v0.1.0',
};

if (!Object.prototype.hasOwnProperty.call(values, mode)) {
  console.error('Usage: node scripts/set-hvy-dependency.cjs <local|git>');
  process.exit(1);
}

packageJson.dependencies = packageJson.dependencies || {};
packageJson.dependencies[dependencyName] = values[mode];

fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`${dependencyName} -> ${values[mode]}`);
