/**
 * Raw shape of `data/github-profile.yaml` — the curated pitch that drives the
 * landing page. Adapted into `SiteProfile`; no component sees these types.
 */

export interface GhIdentity {
  readonly name: string;
  readonly headline: string;
  readonly tagline: string;
  readonly summary: string;
  readonly location: string;
  readonly current_role: {
    readonly title: string;
    readonly company: string;
    readonly since: string;
  };
}

/** Metrics are written as display strings here ("243", "35%", "~60%"). */
export interface GhImpact {
  readonly metric: string;
  readonly label: string;
  readonly detail?: string;
}

export interface GhCrate {
  readonly name: string;
  readonly repo: string;
  readonly summary: string;
}

export interface GhProvider {
  readonly namespace: string;
  readonly name: string;
  readonly repo: string;
  readonly summary: string;
}

export interface GhRecent {
  readonly name: string;
  readonly summary: string;
  readonly repo: string;
  readonly shipped: string;
  readonly crates?: readonly string[];
}

export interface GhExperience {
  readonly title: string;
  readonly company: string;
  readonly start: string;
  /** `YYYY-MM`, or the literal `present`. */
  readonly end: string;
  readonly featured: boolean;
  readonly bullets: readonly string[];
}

export interface GhEducation {
  readonly degree: string;
  readonly field: string;
  readonly institution: string;
  readonly year: string;
}

export interface GhCertification {
  readonly name: string;
  /** May be an empty string in the source. */
  readonly issuer: string;
}

export interface GithubProfile {
  readonly identity: GhIdentity;
  readonly links: Readonly<Record<string, string>>;
  readonly impact: readonly GhImpact[];
  readonly projects: {
    readonly crates: readonly GhCrate[];
    readonly terraform_providers: readonly GhProvider[];
    readonly recent?: readonly GhRecent[];
  };
  readonly skill_order: readonly string[];
  readonly skills: Readonly<Record<string, readonly string[]>>;
  readonly experience: readonly GhExperience[];
  readonly education: readonly GhEducation[];
  readonly certifications: readonly GhCertification[];
}

/**
 * `data/.download-cache.json` — registry download totals keyed by
 * `crate:<name>` or `provider:<namespace>/<name>`.
 */
export type DownloadCache = Readonly<Record<string, number>>;
