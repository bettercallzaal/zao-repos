#!/usr/bin/env node
/**
 * Pulls every public repo across the ZAO GitHub accounts and writes docs/data.json.
 *
 * Only public repos are collected. The workflow runs with the default GITHUB_TOKEN,
 * which has no visibility into private repos on other accounts, so nothing private
 * can leak into the published page even by accident.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/data.json');

const ACCOUNTS = ['bettercallzaal', 'ZAODEVZ', 'ZAO-DEVZ'];
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

const NOW = new Date();
const iso = (d) => d.toISOString();
const daysAgo = (n) => new Date(NOW.getTime() - n * 864e5);
const SINCE_30 = iso(daysAgo(30));
const SINCE_90 = iso(daysAgo(90));
const SINCE_365 = iso(daysAgo(365));

// Repo name -> product line. First match wins, so order matters.
const BRANDS = [
  ['WaveWarZ', /wavewarz|wwtracker|^ww|warz/i],
  ['ZAO OS', /zaoos|zao-os|zaonexus|zao101|zao-101/i],
  ['ZAO Stock', /zaostock|zao-stock|za-ostock/i],
  ['COC Concertz', /cocconcert|coc-concert/i],
  ['FISHBOWLZ', /fishbowl/i],
  ['ZABAL', /zabal/i],
  ['ZOL', /^zol/i],
  ['POIDH', /poidh/i],
  ['Sparkz', /sparkz/i],
  ['Zlank', /zlank/i],
  ['ZAI', /^zai/i],
  ['Fractal', /fractal/i],
  ['Cowork', /cowork/i],
  ['SongJam / Music', /songjam|zounz|music|juke|concert|openmic|zoostr|nostr/i],
  ['BetterCallZaal', /bettercallzaal|^bcz/i],
  ['Client Work', /riverside|16statestreet|crownvics|firsttimehomebuyer|farmdrop|imanprojects|compliance-zm|cedartide|ethboulder|gnome-pear|duodo|ltae|walker/i],
  ['Personal', /zaaltimeline|zaalcaster|birthday|^resume|^zski/i],
  ['Agents & Bots', /bot|agent|scribe|scout|mentor|orchestrat|eliza/i],
  ['Dev Infra', /dotfiles|vault|skills|orca|^ecc$|harness|template|config|finance/i],
  ['ZAO Core', /^zao|^za-o|^the?zao/i],
  ['Experiments', /raycast|mixer|textsplitter|spacetovideo|custompdf|viz1|sidebyside|snap|^jax$|^expo-|b-zbuild|zignite|zingfisher|zuke|zalora|aurdour|zdeepmeeting/i],
];
const brandOf = (name) => {
  const hit = BRANDS.find(([, re]) => re.test(name));
  return hit ? hit[0] : 'Other';
};

/* ------------------------------------------------------------------ GraphQL */

async function graphql(query, variables) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `bearer ${TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'zao-repos-dashboard',
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!text) {
      // GitHub answers an over-budget or timed-out query with an empty body.
      if (attempt < 3) { await sleep(3000 * (attempt + 1)); continue; }
      throw new Error(`empty GraphQL response (HTTP ${res.status})`);
    }
    const body = JSON.parse(text);
    if (body.errors) {
      const retryable = body.errors.some((e) => /rate limit|timeout|secondary/i.test(e.message || ''));
      if (retryable && attempt < 3) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      throw new Error(JSON.stringify(body.errors));
    }
    return body.data;
  }
}

const REPO_QUERY = `
query($login:String!, $cursor:String, $since30:GitTimestamp!, $since90:GitTimestamp!, $since365:GitTimestamp!) {
  repositoryOwner(login:$login) {
    login
    ... on User { name avatarUrl }
    ... on Organization { name avatarUrl }
    repositories(first:10, after:$cursor, privacy:PUBLIC, ownerAffiliations:OWNER, orderBy:{field:PUSHED_AT, direction:DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        name nameWithOwner url description homepageUrl
        isArchived isFork isTemplate isEmpty
        createdAt pushedAt updatedAt
        diskUsage stargazerCount forkCount
        watchers { totalCount }
        openIssues: issues(states:OPEN) { totalCount }
        openPRs: pullRequests(states:OPEN) { totalCount }
        licenseInfo { spdxId }
        primaryLanguage { name color }
        languages(first:8, orderBy:{field:SIZE, direction:DESC}) {
          totalSize
          edges { size node { name color } }
        }
        repositoryTopics(first:20) { nodes { topic { name } } }
        latestRelease { tagName publishedAt }
        releases { totalCount }
        defaultBranchRef {
          name
          target {
            ... on Commit {
              committedDate
              messageHeadline
              c30: history(since:$since30) { totalCount }
              c90: history(since:$since90) { totalCount }
              c365: history(since:$since365) { totalCount }
              cAll: history { totalCount }
            }
          }
        }
        readme:      object(expression:"HEAD:README.md")   { ... on Blob { byteSize } }
        readmeLower: object(expression:"HEAD:readme.md")   { ... on Blob { byteSize } }
        claudeMd:    object(expression:"HEAD:CLAUDE.md")   { ... on Blob { byteSize } }
        licenseFile: object(expression:"HEAD:LICENSE")     { ... on Blob { byteSize } }
        gitignore:   object(expression:"HEAD:.gitignore")  { ... on Blob { byteSize } }
        envExample:  object(expression:"HEAD:.env.example"){ ... on Blob { byteSize } }
        workflows:   object(expression:"HEAD:.github/workflows") { ... on Tree { entries { name } } }
        pkg:         object(expression:"HEAD:package.json"){ ... on Blob { text } }
      }
    }
  }
}`;

async function fetchAccount(login) {
  const repos = [];
  let cursor = null;
  let owner = null;
  for (;;) {
    const data = await graphql(REPO_QUERY, {
      login, cursor, since30: SINCE_30, since90: SINCE_90, since365: SINCE_365,
    });
    const ro = data.repositoryOwner;
    if (!ro) break;
    owner = { login: ro.login, name: ro.name, avatarUrl: ro.avatarUrl, totalPublic: ro.repositories.totalCount };
    repos.push(...ro.repositories.nodes);
    if (!ro.repositories.pageInfo.hasNextPage) break;
    cursor = ro.repositories.pageInfo.endCursor;
  }
  return { owner, repos };
}

/* --------------------------------------------------------------------- REST */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'zao-repos-dashboard',
    },
  });
  if (!res.ok) return { ok: false, status: res.status, headers: res.headers, body: null };
  return { ok: true, status: res.status, headers: res.headers, body: await res.json() };
}

// Contributor count without downloading every contributor: ask for 1 per page,
// then read the page count off the Link header.
async function contributorCount(nameWithOwner) {
  const r = await rest(`/repos/${nameWithOwner}/contributors?per_page=1&anon=1`);
  if (!r.ok) return null;
  const link = r.headers.get('link');
  if (link) {
    const m = link.match(/[?&]page=(\d+)>; rel="last"/);
    if (m) return Number(m[1]);
  }
  return Array.isArray(r.body) ? r.body.length : null;
}

async function latestWorkflowRun(nameWithOwner) {
  const r = await rest(`/repos/${nameWithOwner}/actions/runs?per_page=1`);
  if (!r.ok || !r.body?.workflow_runs?.length) return null;
  const run = r.body.workflow_runs[0];
  return {
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    at: run.updated_at,
    url: run.html_url,
  };
}

// Is the advertised deploy actually serving? HEAD first, fall back to GET,
// since a lot of hosts reject HEAD.
async function checkDeploy(url) {
  const attempt = async (method) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal });
      return { status: res.status, finalUrl: res.url };
    } catch (err) {
      const name = String(err.name || err);
      return { status: 0, error: name === 'AbortError' ? 'timeout' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  };
  let r = await attempt('HEAD');
  // A timeout is often just a cold serverless start, so a slow host gets one more GET.
  if (r.status === 0 || r.status === 405 || r.status === 501) r = await attempt('GET');
  return { ...r, checkedAt: iso(new Date()) };
}

// Bounded concurrency so we do not trip GitHub secondary rate limits.
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await worker(items[idx], idx);
      }
    })
  );
  return out;
}

/* ------------------------------------------------------------------ shaping */

function hygiene(repo) {
  const checks = {
    description: Boolean(repo.description && repo.description.trim()),
    topics: repo.topics.length > 0,
    readme: repo.hasReadme,
    license: Boolean(repo.license) || repo.hasLicenseFile,
    homepage: Boolean(repo.homepage),
    ci: repo.workflows.length > 0,
    gitignore: repo.hasGitignore,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  return { checks, passed, total, score: Math.round((passed / total) * 100) };
}

function stalenessBucket(days) {
  if (days <= 7) return 'hot';
  if (days <= 30) return 'active';
  if (days <= 90) return 'warm';
  if (days <= 365) return 'cooling';
  return 'dormant';
}

function shape(node, accountLogin) {
  const target = node.defaultBranchRef?.target ?? null;
  const pushed = new Date(node.pushedAt);
  const ageDays = Math.floor((NOW - pushed) / 864e5);
  const topics = node.repositoryTopics.nodes.map((n) => n.topic.name);

  let pkgDeps = null;
  if (node.pkg?.text) {
    try {
      const p = JSON.parse(node.pkg.text);
      pkgDeps = {
        deps: Object.keys(p.dependencies || {}).length,
        devDeps: Object.keys(p.devDependencies || {}).length,
        framework:
          (p.dependencies?.next && 'Next.js') ||
          (p.dependencies?.astro && 'Astro') ||
          (p.dependencies?.react && 'React') ||
          (p.dependencies?.vue && 'Vue') ||
          (p.dependencies?.express && 'Express') ||
          null,
      };
    } catch { /* malformed package.json is not worth failing the run over */ }
  }

  // A description that just repeats the repo name tells a reader nothing, so
  // treat it as missing rather than letting it pad the hygiene score.
  const rawDesc = node.description?.trim() || null;
  const description = rawDesc && rawDesc.toLowerCase() !== node.name.toLowerCase() ? rawDesc : null;

  const repo = {
    name: node.name,
    nameWithOwner: node.nameWithOwner,
    account: accountLogin,
    url: node.url,
    description,
    homepage: node.homepageUrl,
    brand: brandOf(node.name),
    archived: node.isArchived,
    fork: node.isFork,
    template: node.isTemplate,
    empty: node.isEmpty,
    createdAt: node.createdAt,
    pushedAt: node.pushedAt,
    updatedAt: node.updatedAt,
    ageDays,
    staleness: stalenessBucket(ageDays),
    sizeKB: node.diskUsage,
    stars: node.stargazerCount,
    forks: node.forkCount,
    watchers: node.watchers.totalCount,
    openIssues: node.openIssues.totalCount,
    openPRs: node.openPRs.totalCount,
    license: node.licenseInfo?.spdxId || null,
    language: node.primaryLanguage?.name || null,
    languageColor: node.primaryLanguage?.color || null,
    languages: node.languages.edges.map((e) => ({
      name: e.node.name,
      color: e.node.color,
      pct: node.languages.totalSize ? Math.round((e.size / node.languages.totalSize) * 100) : 0,
    })),
    topics,
    defaultBranch: node.defaultBranchRef?.name || null,
    lastCommit: target ? { at: target.committedDate, message: target.messageHeadline } : null,
    commits30: target?.c30?.totalCount ?? 0,
    commits90: target?.c90?.totalCount ?? 0,
    commits365: target?.c365?.totalCount ?? 0,
    commitsAll: target?.cAll?.totalCount ?? 0,
    latestRelease: node.latestRelease
      ? { tag: node.latestRelease.tagName, at: node.latestRelease.publishedAt }
      : null,
    releaseCount: node.releases.totalCount,
    hasReadme: Boolean(node.readme || node.readmeLower),
    readmeBytes: node.readme?.byteSize || node.readmeLower?.byteSize || 0,
    hasClaudeMd: Boolean(node.claudeMd),
    hasLicenseFile: Boolean(node.licenseFile),
    hasGitignore: Boolean(node.gitignore),
    hasEnvExample: Boolean(node.envExample),
    workflows: node.workflows?.entries?.map((e) => e.name) ?? [],
    pkg: pkgDeps,
  };
  repo.hygiene = hygiene(repo);
  return repo;
}

/* ---------------------------------------------------------------- aggregate */

function summarize(repos) {
  const live = repos.filter((r) => !r.archived);
  const tally = (arr, key) => {
    const m = {};
    for (const r of arr) {
      const k = typeof key === 'function' ? key(r) : r[key];
      if (k == null) continue;
      m[k] = (m[k] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  };

  // 12 months of push activity, oldest first.
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(NOW.getFullYear(), NOW.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, pushes: 0, created: 0 });
  }
  const bump = (dateStr, field) => {
    const k = dateStr.slice(0, 7);
    const m = months.find((x) => x.key === k);
    if (m) m[field] += 1;
  };
  for (const r of repos) {
    bump(r.pushedAt, 'pushes');
    bump(r.createdAt, 'created');
  }

  const deployed = repos.filter((r) => r.homepage);
  return {
    counts: {
      total: repos.length,
      live: live.length,
      archived: repos.filter((r) => r.archived).length,
      forks: repos.filter((r) => r.fork).length,
      empty: repos.filter((r) => r.empty).length,
      deployed: deployed.length,
      withCI: repos.filter((r) => r.workflows.length).length,
      withClaudeMd: repos.filter((r) => r.hasClaudeMd).length,
    },
    totals: {
      stars: repos.reduce((a, r) => a + r.stars, 0),
      forks: repos.reduce((a, r) => a + r.forks, 0),
      openIssues: repos.reduce((a, r) => a + r.openIssues, 0),
      openPRs: repos.reduce((a, r) => a + r.openPRs, 0),
      commits30: repos.reduce((a, r) => a + r.commits30, 0),
      commits90: repos.reduce((a, r) => a + r.commits90, 0),
      commits365: repos.reduce((a, r) => a + r.commits365, 0),
      commitsAll: repos.reduce((a, r) => a + r.commitsAll, 0),
      sizeMB: Math.round(repos.reduce((a, r) => a + (r.sizeKB || 0), 0) / 1024),
      releases: repos.reduce((a, r) => a + r.releaseCount, 0),
    },
    staleness: tally(live, 'staleness'),
    languages: tally(repos, 'language'),
    brands: tally(repos, 'brand'),
    accounts: tally(repos, 'account'),
    months,
    hygieneAverage: Math.round(repos.reduce((a, r) => a + r.hygiene.score, 0) / (repos.length || 1)),
    hygieneGaps: {
      noDescription: repos.filter((r) => !r.hygiene.checks.description).length,
      noTopics: repos.filter((r) => !r.hygiene.checks.topics).length,
      noReadme: repos.filter((r) => !r.hygiene.checks.readme).length,
      noLicense: repos.filter((r) => !r.hygiene.checks.license).length,
      noCI: repos.filter((r) => !r.hygiene.checks.ci).length,
    },
  };
}

/* --------------------------------------------------------------------- main */

async function main() {
  const owners = [];
  let repos = [];

  for (const login of ACCOUNTS) {
    process.stderr.write(`fetching ${login}... `);
    const { owner, repos: nodes } = await fetchAccount(login);
    if (owner) owners.push(owner);
    repos.push(...nodes.map((n) => shape(n, login)));
    process.stderr.write(`${nodes.length} public repos\n`);
  }

  // Contributor counts and CI status, for non-empty repos only.
  const active = repos.filter((r) => !r.empty);
  process.stderr.write(`contributors for ${active.length} repos...\n`);
  const contributors = await pool(active, 8, (r) => contributorCount(r.nameWithOwner));
  active.forEach((r, i) => { r.contributors = contributors[i]; });

  const withCI = repos.filter((r) => r.workflows.length);
  process.stderr.write(`CI status for ${withCI.length} repos...\n`);
  const runs = await pool(withCI, 8, (r) => latestWorkflowRun(r.nameWithOwner));
  withCI.forEach((r, i) => { r.lastRun = runs[i]; });

  const deployed = repos.filter((r) => r.homepage);
  process.stderr.write(`probing ${deployed.length} deploy URLs...\n`);
  const probes = await pool(deployed, 10, (r) => checkDeploy(r.homepage));
  deployed.forEach((r, i) => { r.deploy = probes[i]; });

  // Owner-level contribution graph, public commits only.
  const contributions = {};
  for (const login of ACCOUNTS) {
    try {
      const d = await graphql(
        `query($login:String!){ user(login:$login){ contributionsCollection {
            totalCommitContributions totalPullRequestContributions totalIssueContributions
            totalRepositoryContributions
            contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
        } } }`,
        { login }
      );
      const c = d.user?.contributionsCollection;
      if (c) {
        contributions[login] = {
          commits: c.totalCommitContributions,
          prs: c.totalPullRequestContributions,
          issues: c.totalIssueContributions,
          newRepos: c.totalRepositoryContributions,
          total: c.contributionCalendar.totalContributions,
          days: c.contributionCalendar.weeks.flatMap((w) =>
            w.contributionDays.map((d) => [d.date, d.contributionCount])
          ),
        };
      }
    } catch {
      // Organizations have no contribution graph; that is expected.
    }
  }

  repos.sort((a, b) => (a.pushedAt < b.pushedAt ? 1 : -1));

  const payload = {
    generatedAt: iso(NOW),
    owners,
    contributions,
    summary: summarize(repos),
    repos,
    note: 'Public repositories only. Private repositories are never fetched or published by this workflow.',
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 1));
  process.stderr.write(`wrote ${OUT} (${repos.length} repos)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
