/**
 * Reads the team migration ZIP and writes roles/bundle.json.
 * Accepts either:
 *   <role-id>/instructions.md + memory.md + meta.json, or
 *   <role-id>.md with YAML frontmatter (source_grade, tags, name).
 * source_grade must be official | reported | model | unverified; anything else
 * is kept as unverified and listed in the summary so it is not silently upgraded.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { unzipSync } from "fflate";

const zipPath = process.argv[2];
if (!zipPath) {
  console.error("usage: node scripts/import-roles.mjs <roles.zip>");
  process.exit(1);
}
const files = unzipSync(readFileSync(zipPath));
const text = new Map();
for (const [name, bytes] of Object.entries(files)) {
  if (name.endsWith("/")) continue;
  text.set(name.replace(/^\/+/, ""), new TextDecoder().decode(bytes));
}

const GRADES = new Set(["official", "reported", "model", "unverified"]);
const roles = [];
const warnings = [];

function gradeOf(v, file) {
  if (GRADES.has(v)) return v;
  warnings.push(`${file}: source_grade "${v ?? ""}" is not a known grade; stored as unverified`);
  return "unverified";
}

const dirs = new Set();
for (const name of text.keys()) {
  const parts = name.split("/");
  if (parts.length > 1) dirs.add(parts.slice(0, -1).join("/"));
}
for (const dir of [...dirs].sort()) {
  const instr = text.get(`${dir}/instructions.md`) ?? text.get(`${dir}/INSTRUCTION.md`);
  if (!instr) continue;
  let meta = {};
  const raw = text.get(`${dir}/meta.json`);
  if (raw) {
    try { meta = JSON.parse(raw); } catch { warnings.push(`${dir}/meta.json: invalid JSON`); }
  }
  const id = String(meta.id ?? dir.split("/").at(-1));
  roles.push({
    id,
    name: String(meta.name ?? id),
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [id],
    instructions: instr.trim(),
    memory: (text.get(`${dir}/memory.md`) ?? "").trim(),
    source_grade: gradeOf(meta.source_grade, `${dir}/meta.json`),
    source_file: dir,
  });
}

if (roles.length === 0) {
  for (const [name, body] of [...text.entries()].filter(([n]) => n.endsWith(".md")).sort()) {
    const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(body);
    const head = {};
    let instructions = body.trim();
    if (fm) {
      instructions = fm[2].trim();
      for (const line of fm[1].split("\n")) {
        const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
        if (m) head[m[1]] = m[2].trim();
      }
    }
    const id = (head.id || name.replace(/\.md$/, "").split("/").at(-1)).replace(/\s+/g, "-");
    roles.push({
      id,
      name: head.name || id,
      tags: (head.tags || id).split(",").map((s) => s.trim()).filter(Boolean),
      instructions,
      memory: head.memory || "",
      source_grade: gradeOf(head.source_grade, name),
      source_file: name,
    });
  }
}

const seen = new Set();
for (const r of roles) {
  if (seen.has(r.id)) warnings.push(`duplicate role id ${r.id}`);
  seen.add(r.id);
}
const bundle = { source: zipPath, imported_at: new Date().toISOString(), roles };
writeFileSync("roles/bundle.json", JSON.stringify(bundle, null, 2) + "\n");
console.log(`imported ${roles.length} roles`);
for (const r of roles) console.log(`- ${r.id} [${r.source_grade}] tags=${r.tags.join(",")} <= ${r.source_file}`);
for (const w of warnings) console.log(`warning: ${w}`);
if (roles.length !== 8) console.log(`warning: expected 8 roles, found ${roles.length}`);
