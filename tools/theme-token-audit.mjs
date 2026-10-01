import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/* harness 真实主题 token（来自 client/Theme inspect ✓） */
const REAL = new Set([
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-brand-primary",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-idle-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-specific-sidebar-fill",
]);

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor") continue;
      walk(full);
      continue;
    }
    if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(full);
  }
}
walk("src/client");

const used = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/--dsw-[a-z0-9-]+/g)) {
    const name = match[0];
    if (!used.has(name)) used.set(name, new Set());
    used.get(name).add(file);
  }
}

console.log("=== 未被 harness 定义的名字（会掉进硬编码兜底 ✗）===");
let bad = 0;
for (const [name, where] of [...used].sort()) {
  if (REAL.has(name)) continue;
  bad += 1;
  console.log(`  ${name.padEnd(42)} ${[...where].join(", ")}`);
}
console.log(`\n总计：用到的 token 名 ${used.size} 个，其中不存在的 ${bad} 个`);
console.log("\n=== 存在但没用到的真实 token ===");
for (const name of REAL) if (!used.has(name)) console.log("  " + name);
