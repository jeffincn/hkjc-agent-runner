export const SOURCE_GRADES = ["official", "reported", "model", "unverified"] as const;
export type SourceGrade = (typeof SOURCE_GRADES)[number];

export interface RoleDef {
  id: string;
  name: string;
  /** Routing tags: odds, quant, strategy, contrarian, nursing, review, and any others. */
  tags: string[];
  instructions: string;
  memory: string;
  source_grade: SourceGrade;
  /** Path inside the migration bundle, kept so a conclusion can be traced back. */
  source_file: string;
}

export interface RoleBundle {
  source: string;
  imported_at: string | null;
  roles: RoleDef[];
}

import bundle from "../roles/bundle.json";

const loaded = bundle as RoleBundle;
let override: RoleDef[] | null = null;

/** Tests inject a fixture bundle; production always uses roles/bundle.json. */
export function setRolesForTest(roles: RoleDef[] | null): void {
  override = roles;
}

export function roleBundle(): RoleBundle {
  return override ? { ...loaded, roles: override } : loaded;
}

export function allRoles(): RoleDef[] {
  return override ?? loaded.roles;
}

export function rolesByTags(tags: string[]): RoleDef[] {
  const want = new Set(tags);
  return loaded.roles.filter((r) => r.tags.some((t) => want.has(t)));
}

export function isSourceGrade(v: unknown): v is SourceGrade {
  return typeof v === "string" && (SOURCE_GRADES as readonly string[]).includes(v);
}
