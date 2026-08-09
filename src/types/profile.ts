/**
 * Types for `data/profile.yaml`.
 *
 * The YAML file is the single source of truth for every fact on this site; it
 * is copied verbatim from the CV repository. These declarations describe that
 * file's shape so the rest of the site can consume it under `strict` mode
 * rather than passing `unknown` around.
 *
 * Dates arrive as strings, not `Date`. `start: 2024-10` is not a YAML 1.2
 * timestamp (that requires a full yyyy-mm-dd), so the parser leaves it as the
 * string "2024-10" — verified against the real file rather than assumed.
 */

/** Skill category, as used by the `kind` key. */
export type SkillKind =
  | 'cloud'
  | 'container'
  | 'iac'
  | 'cicd'
  | 'observability'
  | 'language'
  | 'framework'
  | 'database'
  | 'storage'
  | 'methodology';

/**
 * Self-assessed depth, 1-5. Per profile.yaml: 5 = daily working tool, owned
 * and debugged unaided in production; 1 = aware only.
 */
export type SkillLevel = 1 | 2 | 3 | 4 | 5;

/**
 * How central a skill is to how this career is presented — deliberately
 * independent of `level`. 1 = lead with this, 3 = include if there is room.
 * Absent means "do not feature".
 */
export type Prominence = 1 | 2 | 3;

export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly kind: SkillKind;
  readonly level: SkillLevel;
  readonly prominence?: Prominence;
}

/** A quantified outcome attached to a role. */
export interface Metric {
  readonly id: string;
  readonly value: number;
  readonly unit: string;
  readonly claim: string;
}

export interface Role {
  readonly id: string;
  readonly employer: string;
  readonly industry?: string;
  /** `YYYY-MM`. */
  readonly start: string;
  /** `YYYY-MM`, or `null` for the current role. */
  readonly end: string | null;
  readonly titles: readonly string[];
  /** Skill `id`s, resolved against `Profile.skills`. */
  readonly tech: readonly string[];
  readonly metrics: readonly Metric[];
}

export interface ProfileLink {
  readonly name: string;
  readonly handle: string;
  readonly url: string;
}

export interface SpokenLanguage {
  readonly name: string;
  readonly level: string;
}

export interface Person {
  readonly name: string;
  readonly acronym: string;
  readonly email: string;
  readonly location: string;
  /**
   * Optional because it is stripped before the profile reaches the browser —
   * see docusaurus.config.ts. It exists in data/profile.yaml, never in the
   * shipped bundle.
   */
  readonly phone?: string;
  readonly links: readonly ProfileLink[];
  readonly languages: readonly SpokenLanguage[];
}

export interface Education {
  readonly degree: string;
  readonly field: string;
  readonly institution: string;
  readonly year: number;
  readonly state: string;
}

export interface Certification {
  readonly name: string;
  readonly issuer: string;
  readonly year?: number;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly url: string;
  readonly summary: string;
}

export interface Profile {
  readonly person: Person;
  readonly skills: readonly Skill[];
  readonly experience: readonly Role[];
  readonly education: readonly Education[];
  readonly certifications: readonly Certification[];
  readonly projects: readonly Project[];
}

/** A metric paired with the role it was achieved in, for flat rendering. */
export interface AttributedMetric extends Metric {
  readonly employer: string;
  readonly roleId: string;
}
