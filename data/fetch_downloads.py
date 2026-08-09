#!/usr/bin/env python3
"""Refresh `.download-cache.json` from the public package registries.

    uv run profile-data           # installed console script
    uv run fetch_downloads.py     # the module directly

The package list is read from `profile.yml`, so publishing a new crate or
provider means editing that file and re-running this — never editing the cache
by hand.

Cache keys mirror the registry that owns the figure:

    crate:<name>                   crates.io
    provider:<namespace>/<name>    Terraform Registry

Both halves of a key are recovered from the project's registry URL rather than
from separate YAML fields: the URL is the canonical pointer, so identity cannot
drift away from the thing actually being measured.

Failure policy: a package that cannot be fetched keeps whatever figure the
cache already held rather than being zeroed or dropped. A transient 503 must
never silently rewrite the strongest evidence on the site. If *every* lookup
fails the script exits non-zero, so a broken CI refresh is loud.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import httpx
from ruamel.yaml import YAML

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_PROFILE_PATH = SCRIPT_DIR / "profile.yml"
DEFAULT_CACHE_PATH = SCRIPT_DIR / ".download-cache.json"

# crates.io requires a User-Agent identifying the caller, and returns 403
# without one.
USER_AGENT = "elioseverojunior.github.io download-stats (github.com/elioseverojunior)"

MAX_ATTEMPTS = 3
BASE_BACKOFF_SECONDS = 0.5
DEFAULT_CONCURRENCY = 6
DEFAULT_TIMEOUT_SECONDS = 15.0

CRATE_URL_PATTERN = re.compile(r"^https://crates\.io/crates/(?P<name>[^/?#]+)")
PROVIDER_URL_PATTERN = re.compile(
    r"^https://registry\.terraform\.io/providers/"
    r"(?P<namespace>[^/?#]+)/(?P<name>[^/?#]+)"
)

LOGGER = logging.getLogger("fetch-downloads")

DownloadReader = Callable[[object], "int | None"]
DownloadCache = dict[str, int]


class TransientFetchError(RuntimeError):
    """A failure worth retrying: network fault, timeout, 429, or 5xx."""


@dataclass(frozen=True, slots=True)
class Target:
    """One package to measure, plus the reader for its registry's shape."""

    key: str
    url: str
    read: DownloadReader


# --------------------------------------------------------------------------- #
# Response readers — one per registry response shape.
# --------------------------------------------------------------------------- #


def read_positive_integer(value: object) -> int | None:
    """Accept only a finite, non-negative count; reject bools and strings."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def read_crate_downloads(payload: object) -> int | None:
    """Read the total out of a crates.io body: `{"crate": {"downloads": 26343}}`."""
    if not isinstance(payload, Mapping):
        return None
    crate = payload.get("crate")
    if not isinstance(crate, Mapping):
        return None
    return read_positive_integer(crate.get("downloads"))


def read_provider_downloads(payload: object) -> int | None:
    """Read the total out of a Terraform Registry body: `{"downloads": 3896}`."""
    if not isinstance(payload, Mapping):
        return None
    return read_positive_integer(payload.get("downloads"))


# --------------------------------------------------------------------------- #
# Discovery — profile.yml -> targets.
# --------------------------------------------------------------------------- #


def load_profile(path: Path) -> Mapping[str, object]:
    """Read the curated profile; a malformed file is fatal, not recoverable."""
    parser = YAML(typ="safe")
    with path.open(encoding="utf-8") as handle:
        profile = parser.load(handle)
    if not isinstance(profile, Mapping):
        raise TypeError(f"{path} does not contain a YAML mapping")
    return profile


def build_target(project: Mapping[str, object]) -> Target | None:
    """Map one `projects[]` entry to a Target, or None if it is not measurable."""
    kind = project.get("kind")
    url = project.get("url")
    if not isinstance(url, str):
        return None

    if kind == "crate":
        match = CRATE_URL_PATTERN.match(url)
        if match is None:
            return None
        name = match["name"]
        return Target(
            key=f"crate:{name}",
            url=f"https://crates.io/api/v1/crates/{name}",
            read=read_crate_downloads,
        )

    if kind == "terraform-provider":
        match = PROVIDER_URL_PATTERN.match(url)
        if match is None:
            return None
        namespace, name = match["namespace"], match["name"]
        return Target(
            key=f"provider:{namespace}/{name}",
            url=(f"https://registry.terraform.io/v1/providers/{namespace}/{name}"),
            read=read_provider_downloads,
        )

    return None


def collect_targets(profile: Mapping[str, object]) -> list[Target]:
    """Every measurable project, deduplicated by cache key, in file order."""
    projects = profile.get("projects")
    if not isinstance(projects, Sequence):
        return []

    seen: set[str] = set()
    targets: list[Target] = []
    for project in projects:
        if not isinstance(project, Mapping):
            continue
        target = build_target(project)
        if target is None:
            LOGGER.debug("discover.skipped project=%s", project.get("id"))
        elif target.key not in seen:
            seen.add(target.key)
            targets.append(target)
    return targets


# --------------------------------------------------------------------------- #
# Fetching — bounded-concurrency async I/O with retry.
# --------------------------------------------------------------------------- #


async def attempt_fetch(client: httpx.AsyncClient, target: Target) -> int | None:
    """One HTTP attempt. Raises TransientFetchError when a retry could help."""
    try:
        response = await client.get(target.url)
    except httpx.HTTPError as error:
        raise TransientFetchError(type(error).__name__) from error

    status = response.status_code
    if status == httpx.codes.NOT_FOUND:
        # A 404 is a fact about the package, not a transient fault — retrying
        # cannot change it, so stop immediately.
        LOGGER.warning("fetch.not_found key=%s", target.key)
        return None
    if status == httpx.codes.TOO_MANY_REQUESTS or response.is_server_error:
        raise TransientFetchError(f"HTTP {status}")
    if response.is_error:
        # Any other 4xx is a fact about the request itself; a retry sends the
        # identical request and earns the identical rejection.
        LOGGER.warning("fetch.rejected key=%s status=%s", target.key, status)
        return None

    try:
        payload = response.json()
    except ValueError as error:
        raise TransientFetchError("malformed JSON") from error

    value = target.read(payload)
    if value is None:
        LOGGER.warning("fetch.no_download_field key=%s", target.key)
    return value


async def fetch_one(
    client: httpx.AsyncClient, target: Target, gate: asyncio.Semaphore
) -> int | None:
    """Fetch one target, retrying transient failures with exponential backoff."""
    # The gate is held across the backoff sleep on purpose: when a registry
    # answers 429 the correct response is fewer requests in flight, not the
    # same number with one of them merely delayed.
    async with gate:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                return await attempt_fetch(client, target)
            except TransientFetchError as error:
                if attempt == MAX_ATTEMPTS:
                    LOGGER.warning(
                        "fetch.exhausted key=%s reason=%s", target.key, error
                    )
                    return None
                backoff = BASE_BACKOFF_SECONDS * 2 ** (attempt - 1)
                LOGGER.warning(
                    "fetch.retry key=%s reason=%s backoff=%.1fs",
                    target.key,
                    error,
                    backoff,
                )
                await asyncio.sleep(backoff)
    return None


async def fetch_all(
    targets: Sequence[Target], *, concurrency: int, timeout_seconds: float
) -> dict[str, int | None]:
    """Fetch every target concurrently under one pooled client.

    The deadline is httpx's, not `asyncio.timeout`'s, on purpose: it applies
    per connect/read/write of each attempt, so a slow registry costs one
    retry rather than consuming a budget shared with every other package.
    """
    gate = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(
        headers={"user-agent": USER_AGENT, "accept": "application/json"},
        timeout=timeout_seconds,
        limits=httpx.Limits(max_connections=concurrency),
        follow_redirects=True,
    ) as client:
        values = await asyncio.gather(
            *(fetch_one(client, target, gate) for target in targets)
        )
    return {target.key: value for target, value in zip(targets, values, strict=True)}


# --------------------------------------------------------------------------- #
# Persistence.
# --------------------------------------------------------------------------- #


def load_cache(path: Path) -> DownloadCache:
    """Load the previous figures; an unreadable cache degrades to empty."""
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError:
        LOGGER.warning("cache.unreadable path=%s (starting from empty)", path)
        return {}
    if not isinstance(raw, Mapping):
        LOGGER.warning("cache.not_an_object path=%s (starting from empty)", path)
        return {}
    return {
        str(key): value
        for key, value in raw.items()
        if read_positive_integer(value) is not None
    }


def write_cache(path: Path, cache: DownloadCache) -> None:
    """Persist with sorted keys so a one-figure change is a one-line diff."""
    ordered = dict(sorted(cache.items()))
    path.write_text(f"{json.dumps(ordered, indent=2)}\n", encoding="utf-8")


def resolve_download_count(fetched: int | None, previous: int | None) -> int | None:
    """Decide the figure that lands in the cache for one package.

    `fetched` is None when the lookup produced no usable number (404, exhausted
    retries, missing field). `previous` is None when the cache has never held a
    figure for this key. Returning None drops the key entirely.
    """
    if fetched is None:
        return previous
    return fetched


def merge(
    fetched: Mapping[str, int | None], previous: Mapping[str, int]
) -> DownloadCache:
    """Reconcile this run against the cache, key by key."""
    merged: DownloadCache = {}
    for key, value in fetched.items():
        resolved = resolve_download_count(value, previous.get(key))
        if resolved is not None:
            merged[key] = resolved
    return merged


# --------------------------------------------------------------------------- #
# Entry point.
# --------------------------------------------------------------------------- #


def configure_logging(*, verbose: bool) -> None:
    """Diagnostics go to stderr; the summary report goes to stdout."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)-7s %(message)s",
        stream=sys.stderr,
    )
    # httpx narrates every request at INFO, which buries this script's own
    # events. Its per-request line is only useful when debugging.
    logging.getLogger("httpx").setLevel(logging.INFO if verbose else logging.WARNING)


def build_argument_parser() -> argparse.ArgumentParser:
    """Define the command line, defaulting every path to this script's folder."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE_PATH)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE_PATH)
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch and report, but leave the cache file untouched",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser


def report(
    merged: DownloadCache,
    fetched: Mapping[str, int | None],
    previous: Mapping[str, int],
) -> None:
    """Print the human summary to stdout, keeping it separable from the logs."""
    refreshed = sum(1 for value in fetched.values() if value is not None)
    carried = sum(
        1 for key, value in fetched.items() if value is None and key in previous
    )
    total = sum(merged.values())
    print(
        f"\nWrote {len(merged)} entries "
        f"({refreshed} refreshed, {carried} carried over, "
        f"{len(fetched) - refreshed - carried} dropped)."
    )
    print(f"Combined downloads: {total:,}")


def main(argv: Sequence[str] | None = None) -> int:
    """Discover, fetch, merge, persist. Returns the process exit code."""
    args = build_argument_parser().parse_args(argv)
    configure_logging(verbose=args.verbose)

    targets = collect_targets(load_profile(args.profile))
    if not targets:
        LOGGER.error("discover.empty path=%s", args.profile)
        return 1

    previous = load_cache(args.cache)
    LOGGER.info(
        "fetch.start packages=%d concurrency=%d", len(targets), args.concurrency
    )
    fetched = asyncio.run(
        fetch_all(targets, concurrency=args.concurrency, timeout_seconds=args.timeout)
    )

    if not any(value is not None for value in fetched.values()):
        LOGGER.error("fetch.total_failure — leaving the cache untouched")
        return 1

    merged = merge(fetched, previous)
    if args.dry_run:
        LOGGER.info("cache.dry_run path=%s (not written)", args.cache)
    else:
        write_cache(args.cache, merged)
    report(merged, fetched, previous)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
