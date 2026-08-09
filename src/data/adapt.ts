import {
  formatDuration,
  formatPeriod,
  parseMetric,
  parseYearMonth,
  prose,
} from './format';
// Relative, not `@site/*`: this module is imported by docusaurus.config.ts and
// evaluated in plain Node, where the `@site` alias does not exist.
import type {DownloadCache, GithubProfile} from '../types/github-profile';
import type {Profile, Skill, SkillKind} from '../types/profile';
import type {
  SiteCertification,
  SiteLink,
  SiteMetric,
  SiteProfile,
  SiteProject,
  SiteRole,
  SiteSkill,
  SiteSkillGroup,
} from '../types/site';

/* ==========================================================================
   Shared helpers
   ========================================================================== */

/**
 * The two sources name the same tool differently — the record writes
 * "AWS Athena" and "HashiCorp Consul" where the curated file writes "Athena"
 * and "Consul". Stripping the vendor prefix lets depth ratings from the record
 * attach to the curated groups instead of silently failing to match.
 */
function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(aws|amazon|hashicorp|apache)\s+/, '')
    .replace(/[^a-z0-9+#]/g, '');
}

function toSiteSkill(skill: Skill): SiteSkill {
  return {name: skill.name, level: skill.level, core: skill.prominence === 1};
}

function crateUrl(name: string): string {
  return `https://crates.io/crates/${name}`;
}

function providerUrl(namespace: string, name: string): string {
  return `https://registry.terraform.io/providers/${namespace}/${name}/latest/docs`;
}

function sumDownloads(projects: readonly SiteProject[]): number {
  return projects.reduce((total, project) => total + (project.downloads ?? 0), 0);
}

function earliestYear(starts: readonly string[], fallback: number): number {
  const years = starts
    .map((start) => parseYearMonth(start)?.year)
    .filter((year): year is number => year !== undefined);
  return years.length === 0 ? fallback : Math.min(...years);
}

/** `https://github.com/elioseverojunior` -> `/elioseverojunior`. */
function handleOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/'
      ? parsed.hostname
      : parsed.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * Substitutes `{{years}}` in prose with the years computed from the record.
 *
 * The tagline and summary state a length of career, which is the one claim on
 * the page that silently rots — "20+ years" was written once and would have to
 * be remembered every January. Writing `{{years}}` instead keeps the sentence
 * in the data file while deriving the number from the earliest start date, so
 * it is correct on its own.
 */
function applyTokens(text: string, years: number): string {
  return text.replace(/\{\{\s*years\s*\}\}/g, String(years));
}

const LINK_LABELS: Readonly<Record<string, string>> = {
  github: 'GitHub',
  github_org: 'GitHub',
  linkedin: 'LinkedIn',
  stackoverflow: 'Stack Overflow',
  readthedocs: 'Read the Docs',
};

/* ==========================================================================
   Employer grouping
   ========================================================================== */

/** One title at one employer, before grouping. */
interface RawTenure {
  readonly id: string;
  readonly company: string;
  readonly industry?: string;
  readonly title: string;
  readonly start: string;
  /** `null` (record) or the string `present` (curated file) means open. */
  readonly end: string | null;
  readonly featured: boolean;
  readonly bullets: readonly string[];
  readonly tech: readonly SiteSkill[];
  readonly metrics: readonly SiteMetric[];
}

function isOpen(end: string | null): boolean {
  return end === null || end === 'present';
}

/**
 * Folds consecutive entries at the same employer into one role.
 *
 * Both sources record a promotion as a separate entry — Rdi Software appears
 * three times, as developer, senior, then lead. Rendered as three sibling
 * blocks that repeats the employer name three times and reads as three
 * separate jobs rather than one four-year tenure with two promotions, which
 * undersells exactly the roles that show progression.
 *
 * Only *consecutive* entries are folded, so a genuine return to a former
 * employer years later would still stand as its own role.
 */
function groupByEmployer(raw: readonly RawTenure[], now: Date): SiteRole[] {
  const groups: RawTenure[][] = [];

  raw.forEach((tenure) => {
    const current = groups.at(-1);
    const head = current?.[0];
    if (current !== undefined && head?.company === tenure.company) {
      current.push(tenure);
    } else {
      groups.push([tenure]);
    }
  });

  return groups.flatMap((members): SiteRole[] => {
    // Entries arrive newest-first, so the span runs from the last member's
    // start to the first member's end.
    const newest = members[0];
    const oldest = members[members.length - 1];
    if (newest === undefined || oldest === undefined) {
      return [];
    }

    return [
      {
        id: newest.id,
        company: newest.company,
        title: newest.title,
        period: formatPeriod(oldest.start, newest.end),
        duration: formatDuration(oldest.start, newest.end, now),
        industry: members.find((member) => member.industry !== undefined)
          ?.industry,
        current: isOpen(newest.end),
        featured: members.some((member) => member.featured),
        tenures: members.map((member) => ({
          id: member.id,
          title: member.title,
          period: formatPeriod(member.start, member.end),
          duration: formatDuration(member.start, member.end, now),
          bullets: member.bullets,
          tech: member.tech,
          metrics: member.metrics,
        })),
      },
    ];
  });
}

/* ==========================================================================
   Landing view — driven by the curated pitch
   ========================================================================== */

/**
 * Builds the landing view from `github-profile.yaml`.
 *
 * The curated file carries no contact details or acronym, so those are taken
 * from the structured record — the one place they are written down.
 */
export function adaptLanding(
  gh: GithubProfile,
  record: Profile,
  downloads: DownloadCache,
  now: Date,
): SiteProfile {
  const depthByName = new Map(
    record.skills.map((skill) => [normalizeSkillName(skill.name), skill]),
  );

  // The curated file has no industry field; the record does, keyed by employer.
  const industryByEmployer = new Map(
    record.experience
      .filter((role) => role.industry !== undefined)
      .map((role) => [role.employer.toLowerCase(), role.industry]),
  );

  const roles = groupByEmployer(
    gh.experience.map(
      (entry, index): RawTenure => ({
        id: `${entry.company}-${entry.start}-${index}`,
        company: entry.company,
        industry: industryByEmployer.get(entry.company.toLowerCase()),
        title: entry.title,
        start: entry.start,
        end: entry.end,
        featured: entry.featured,
        bullets: entry.bullets.map(prose),
        tech: [],
        metrics: [],
      }),
    ),
    now,
  );

  const metrics: SiteMetric[] = gh.impact.map((entry, index) => {
    const parsed = parseMetric(entry.metric);
    return {
      id: `impact-${index}`,
      display: entry.metric,
      value: parsed.value,
      prefix: parsed.prefix,
      suffix: parsed.suffix,
      label: prose(entry.label),
      detail: entry.detail === undefined ? undefined : prose(entry.detail),
    };
  });

  const skillGroups: SiteSkillGroup[] = gh.skill_order
    .map((label) => ({
      id: label.toLowerCase().replace(/\s+/g, '-'),
      label,
      skills: (gh.skills[label] ?? []).map((name) => {
        const known = depthByName.get(normalizeSkillName(name));
        return {name, level: known?.level, core: known?.prominence === 1};
      }),
    }))
    .filter((group) => group.skills.length > 0);

  const crates: SiteProject[] = gh.projects.crates.map((crate) => ({
    id: `crate-${crate.name}`,
    name: crate.name,
    kind: 'Rust crate',
    summary: crate.summary,
    url: crateUrl(crate.name),
    repo: crate.repo,
    downloads: downloads[`crate:${crate.name}`],
  }));

  const providers: SiteProject[] = gh.projects.terraform_providers.map(
    (provider) => ({
      id: `provider-${provider.namespace}-${provider.name}`,
      name: provider.name,
      kind: 'Terraform provider',
      summary: provider.summary,
      url: providerUrl(provider.namespace, provider.name),
      repo: provider.repo,
      downloads: downloads[`provider:${provider.namespace}/${provider.name}`],
    }),
  );

  // Highest usage first: the table doubles as evidence, so the strongest
  // figures should not be buried behind alphabetical accident.
  const projects = [...crates, ...providers].sort(
    (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0),
  );

  const links: SiteLink[] = Object.entries(gh.links)
    // `site` is this page; linking a visitor back to where they already are is
    // noise, so it is dropped rather than rendered.
    .filter(([key]) => key !== 'site')
    .map(([key, url]) => ({
      name: LINK_LABELS[key] ?? key,
      handle: handleOf(url),
      url,
    }));

  const startYear = earliestYear(
    record.experience.map((role) => role.start),
    now.getFullYear(),
  );

  return {
    name: gh.identity.name,
    acronym: record.person.acronym,
    headline: gh.identity.headline,
    tagline: applyTokens(gh.identity.tagline, now.getFullYear() - startYear),
    summary: applyTokens(gh.identity.summary, now.getFullYear() - startYear),
    location: record.person.location,
    email: record.person.email,
    startYear,
    years: now.getFullYear() - startYear,
    links,
    languages: record.person.languages.map(
      (language) => `${language.name} (${language.level})`,
    ),
    currentRole: roles.find((role) => role.current),
    metrics,
    roles,
    skillGroups,
    skillCount: skillGroups.reduce(
      (total, group) => total + group.skills.length,
      0,
    ),
    projects,
    recentProjects: (gh.projects.recent ?? []).map((entry) => ({
      id: `recent-${entry.name}`,
      name: entry.name,
      summary: entry.summary,
      url: `https://github.com/${entry.repo}`,
      shipped: entry.shipped,
    })),
    downloadsTotal: sumDownloads(projects),
    education: gh.education.map((entry) => ({
      degree: entry.degree,
      field: entry.field,
      institution: entry.institution,
      year: entry.year,
    })),
    certifications: gh.certifications.map(
      (entry): SiteCertification => ({
        name: entry.name,
        // The source leaves one issuer blank; rendering an empty heading would
        // look like a bug, so it is labelled honestly instead.
        issuer: entry.issuer === '' ? 'Independent' : entry.issuer,
      }),
    ),
  };
}

/* ==========================================================================
   CV view — driven by the complete structured record
   ========================================================================== */

const KIND_ORDER: readonly SkillKind[] = [
  'cloud',
  'container',
  'iac',
  'cicd',
  'observability',
  'language',
  'database',
  'storage',
  'framework',
  'methodology',
];

const KIND_LABELS: Readonly<Record<SkillKind, string>> = {
  cloud: 'Cloud Platforms',
  container: 'Containers & Orchestration',
  iac: 'Infrastructure as Code',
  cicd: 'Delivery & CI/CD',
  observability: 'Observability',
  language: 'Languages',
  database: 'Data & Databases',
  storage: 'Storage & Messaging',
  framework: 'Frameworks',
  methodology: 'Ways of Working',
};

/** Builds the long-form view from `profile.yaml` — every role, every skill. */
export function adaptRecord(
  record: Profile,
  downloads: DownloadCache,
  now: Date,
): SiteProfile {
  const byId = new Map(record.skills.map((skill) => [skill.id, skill]));

  const roles = groupByEmployer(
    record.experience.map(
      (role): RawTenure => ({
        id: role.id,
        company: role.employer,
        industry: role.industry,
        title: role.titles.join(' · '),
        start: role.start,
        end: role.end,
        // The record carries no editorial flag; /cv expands everything anyway.
        featured: true,
        bullets: [],
        tech: role.tech
          .map((id) => byId.get(id))
          .filter((skill): skill is Skill => skill !== undefined)
          .map(toSiteSkill),
        metrics: role.metrics.map((metric) => {
          const display = `${metric.value}${metric.unit === 'percent' ? '%' : ''}`;
          const parsed = parseMetric(display);
          return {
            id: `${role.id}-${metric.id}`,
            display,
            value: parsed.value,
            prefix: parsed.prefix,
            suffix: parsed.suffix,
            label: metric.unit === 'percent' ? '' : metric.unit,
            detail: prose(metric.claim),
            source: role.employer,
          };
        }),
      }),
    ),
    now,
  );

  const skillGroups: SiteSkillGroup[] = KIND_ORDER.map((kind) => ({
    id: kind,
    label: KIND_LABELS[kind],
    skills: record.skills
      .filter((skill) => skill.kind === kind)
      .sort((a, b) => {
        const prominence =
          (a.prominence ?? Number.MAX_SAFE_INTEGER) -
          (b.prominence ?? Number.MAX_SAFE_INTEGER);
        return prominence !== 0 ? prominence : b.level - a.level;
      })
      .map(toSiteSkill),
  })).filter((group) => group.skills.length > 0);

  const projects: SiteProject[] = record.projects
    .map((project) => {
      const isCrate = project.kind === 'crate';
      // Registry namespace is not a field in the record; it is recoverable
      // from the published URL, which is transcribed there verbatim.
      const namespace = /providers\/([^/]+)\//.exec(project.url)?.[1];
      const registryName = /providers\/[^/]+\/([^/]+)/.exec(project.url)?.[1];
      const key = isCrate
        ? `crate:${project.name}`
        : `provider:${namespace ?? ''}/${registryName ?? ''}`;
      return {
        id: project.id,
        name: project.name,
        kind: isCrate ? 'Rust crate' : 'Terraform provider',
        summary: prose(project.summary),
        url: project.url,
        downloads: downloads[key],
      };
    })
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));

  const startYear = earliestYear(
    record.experience.map((role) => role.start),
    now.getFullYear(),
  );

  return {
    name: record.person.name,
    acronym: record.person.acronym,
    headline: 'Senior SRE & Cloud Engineer',
    tagline: '',
    summary: '',
    location: record.person.location,
    email: record.person.email,
    startYear,
    years: now.getFullYear() - startYear,
    links: record.person.links.map((link) => ({
      name: link.name,
      handle: link.handle,
      url: link.url,
    })),
    languages: record.person.languages.map(
      (language) => `${language.name} (${language.level})`,
    ),
    currentRole: roles.find((role) => role.current),
    metrics: roles.flatMap((role) =>
      role.tenures.flatMap((tenure) => tenure.metrics),
    ),
    roles,
    skillGroups,
    skillCount: record.skills.length,
    projects,
    recentProjects: [],
    downloadsTotal: sumDownloads(projects),
    education: record.education.map((entry) => ({
      degree: entry.degree,
      field: entry.field,
      institution: entry.institution,
      year: String(entry.year),
    })),
    certifications: record.certifications.map((entry) => ({
      name: entry.name,
      issuer: entry.issuer,
      year: entry.year,
    })),
  };
}
