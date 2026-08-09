#!/usr/bin/env bun
/**
 * Refreshes `data/.download-cache.json` from the public registries.
 *
 *   bun run fetch:downloads
 *
 * The package list is read from `data/github-profile.yaml`, so publishing a new
 * crate or provider means editing that file and re-running this — never editing
 * the cache by hand.
 *
 * Cache keys mirror the registry that owns the figure:
 *   crate:<name>                  crates.io
 *   provider:<namespace>/<name>   Terraform Registry
 *
 * Failure policy: a package that cannot be fetched keeps whatever figure the
 * cache already held rather than being zeroed or dropped. A transient 503 must
 * never silently rewrite the strongest evidence on the site. If *every* lookup
 * fails the script exits non-zero, so a broken CI refresh is loud.
 */
import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { DownloadCache, GithubProfile } from "../src/types/github-profile";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, ".download-cache.json");

// crates.io requires a User-Agent identifying the caller, and returns 403
// without one.
const USER_AGENT =
  "elioseverojunior.github.io download-stats (github.com/elioseverojunior)";

const MAX_ATTEMPTS = 3;

interface Target {
  readonly key: string;
  readonly url: string;
  /** Pulls the download total out of that registry's response shape. */
  readonly read: (payload: unknown) => number | null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `{crate: {downloads: 26343}}` */
function readCrate(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const crate = (payload as { crate?: unknown }).crate;
  if (typeof crate !== "object" || crate === null) {
    return null;
  }
  return readNumber((crate as { downloads?: unknown }).downloads);
}

/** `{downloads: 3896}` */
function readProvider(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  return readNumber((payload as { downloads?: unknown }).downloads);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches one target, retrying transient failures with exponential backoff. */
async function fetchOne(target: Target): Promise<number | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(target.url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
      });

      // A 404 is a fact about the package, not a transient fault — retrying
      // cannot change it, so stop immediately.
      if (response.status === 404) {
        console.warn(`  ${target.key}: not found (404)`);
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const value = target.read(await response.json());
      if (value === null) {
        console.warn(`  ${target.key}: no download field in response`);
      }
      return value;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_ATTEMPTS) {
        console.warn(`  ${target.key}: ${reason} (giving up)`);
        return null;
      }
      const backoff = 2 ** (attempt - 1) * 500;
      console.warn(`  ${target.key}: ${reason} (retry in ${backoff}ms)`);
      await sleep(backoff);
    }
  }
  return null;
}

function loadCache(): DownloadCache {
  if (!fs.existsSync(CACHE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as DownloadCache;
  } catch {
    console.warn("Existing cache is unreadable; starting from empty.");
    return {};
  }
}

function collectTargets(profile: GithubProfile): Target[] {
  const crates = profile.projects.crates.map((crate) => crate.name);

  // Packages under `recent` are excluded from the site's downloads table, but
  // their figures are still fetched: the data belongs in the cache even when
  // the design chooses not to measure a just-published package on it.
  const recentCrates = (profile.projects.recent ?? []).flatMap(
    (entry) => entry.crates ?? [],
  );

  const crateTargets: Target[] = [...new Set([...crates, ...recentCrates])].map(
    (name) => ({
      key: `crate:${name}`,
      url: `https://crates.io/api/v1/crates/${name}`,
      read: readCrate,
    }),
  );

  const providerTargets: Target[] = profile.projects.terraform_providers.map(
    (provider) => ({
      key: `provider:${provider.namespace}/${provider.name}`,
      url: `https://registry.terraform.io/v1/providers/${provider.namespace}/${provider.name}`,
      read: readProvider,
    }),
  );

  return [...crateTargets, ...providerTargets];
}

async function main(): Promise<void> {
  const profile = parseYaml(
    fs.readFileSync(path.join(DATA_DIR, "github-profile.yaml"), "utf8"),
  ) as GithubProfile;

  const targets = collectTargets(profile);
  const previous = loadCache();

  console.log(`Fetching download counts for ${targets.length} packages…`);

  const results = await Promise.all(
    targets.map(async (target) => ({
      target,
      value: await fetchOne(target),
    })),
  );

  const fetched = results.filter((result) => result.value !== null);
  if (fetched.length === 0) {
    console.error("Every lookup failed; leaving the cache untouched.");
    process.exitCode = 1;
    return;
  }

  const next: Record<string, number> = {};
  results.forEach(({ target, value }) => {
    const carried = previous[target.key];
    const resolved = value ?? carried;
    if (resolved !== undefined) {
      next[target.key] = resolved;
    }
  });

  // Sorted keys keep the diff readable when only one figure moves.
  const sorted = Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
  );

  fs.writeFileSync(CACHE_FILE, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");

  const total = Object.values(sorted).reduce((sum, value) => sum + value, 0);
  console.log(
    `\nWrote ${Object.keys(sorted).length} entries (${fetched.length} refreshed, ` +
      `${results.length - fetched.length} carried over).`,
  );
  console.log(`Combined downloads: ${total.toLocaleString("en-US")}`);
}

await main();
