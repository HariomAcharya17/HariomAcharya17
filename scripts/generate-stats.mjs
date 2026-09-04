// Generates:
//   stats/activity-graph.svg        -> monthly line graph, color cycling
//   stats/activity-graph-daily.svg  -> daily line graph, color cycles per month
//   stats/public-repos.json         -> shields.io "endpoint" badge data
//   stats/private-repos.json        -> shields.io "endpoint" badge data
//
// Requires Node 20+ (built-in fetch) and env vars GH_PAT, GH_USERNAME.

import { writeFile, mkdir } from "node:fs/promises";

const TOKEN = process.env.GH_PAT;
const USERNAME = process.env.GH_USERNAME || "HariomAcharya17";

if (!TOKEN) {
  console.error("Missing GH_PAT secret. Add a Personal Access Token (repo + read:user scopes) as a repo secret named STATS_PAT.");
  process.exit(1);
}

const COLORS = ["#22C55E", "#2563EB", "#EAB308"]; // green, blue, yellow (cycles per month)

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchDailyCommits(username) {
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  from.setDate(from.getDate() + 1);

  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, {
    login: username,
    from: from.toISOString(),
    to: to.toISOString(),
  });

  const days = [];
  for (const week of data.user.contributionsCollection.contributionCalendar.weeks) {
    for (const day of week.contributionDays) {
      days.push({ date: day.date, count: day.contributionCount, month: day.date.slice(0, 7) });
    }
  }
  return days;
}

function buildDailyLineGraphSvg(days) {
  const pxPerDay = 6;
  const width = Math.max(900, days.length * pxPerDay);
  const height = 320;
  const padding = { top: 40, right: 30, bottom: 60, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxCount = Math.max(1, ...days.map((d) => d.count));
  const stepX = days.length > 1 ? chartWidth / (days.length - 1) : 0;

  const monthOrder = [...new Set(days.map((d) => d.month))];
  const monthColor = new Map(monthOrder.map((m, i) => [m, COLORS[i % COLORS.length]]));

  const coords = days.map((d, i) => ({
    x: padding.left + stepX * i,
    y: padding.top + chartHeight - (d.count / maxCount) * chartHeight,
    ...d,
  }));

  const segments = coords
    .slice(0, -1)
    .map((p, i) => {
      const next = coords[i + 1];
      const color = monthColor.get(p.month);
      return `<line x1="${p.x}" y1="${p.y}" x2="${next.x}" y2="${next.y}" stroke="${color}" stroke-width="2.5" stroke-linecap="round" />`;
    })
    .join("\n    ");

  const monthLabelPoints = [];
  let lastMonth = null;
  coords.forEach((p) => {
    if (p.month !== lastMonth) {
      monthLabelPoints.push(p);
      lastMonth = p.month;
    }
  });
  const monthLabels = monthLabelPoints
    .map(
      (p) =>
        `<text x="${p.x}" y="${height - padding.bottom + 22}" font-size="11" fill="#374151" text-anchor="start" font-family="Segoe UI, sans-serif">${new Date(
          `${p.month}-01T00:00:00Z`
        ).toLocaleString("en-US", { month: "short", year: "2-digit" })}</text>` +
        `<line x1="${p.x}" y1="${padding.top}" x2="${p.x}" y2="${height - padding.bottom}" stroke="#E5E7EB" stroke-width="1" stroke-dasharray="2,3" />`
    )
    .join("\n    ");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#FFFFFF" />
  <text x="${padding.left}" y="24" font-size="18" font-weight="bold" fill="#1F2937" font-family="Segoe UI, sans-serif">Daily Commit Activity — Last 12 Months</text>
  <g>
    ${monthLabels}
    ${segments}
  </g>
</svg>`;
}

async function fetchMonthlyCommits(username) {
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  from.setDate(from.getDate() + 1);

  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query, {
    login: username,
    from: from.toISOString(),
    to: to.toISOString(),
  });

  const monthTotals = new Map();

  for (const week of data.user.contributionsCollection.contributionCalendar.weeks) {
    for (const day of week.contributionDays) {
      const monthKey = day.date.slice(0, 7);
      monthTotals.set(monthKey, (monthTotals.get(monthKey) || 0) + day.contributionCount);
    }
  }

  const sortedKeys = [...monthTotals.keys()].sort();
  const last12 = sortedKeys.slice(-12);
  return last12.map((key) => ({
    label: new Date(`${key}-01T00:00:00Z`).toLocaleString("en-US", { month: "short" }),
    count: monthTotals.get(key),
  }));
}

async function fetchRepoCounts(username) {
  let page = 1;
  let publicCount = 0;
  let privateCount = 0;

  while (true) {
    const res = await fetch(
      `https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!res.ok) throw new Error(`REST request failed: ${res.status} ${await res.text()}`);
    const repos = await res.json();
    if (repos.length === 0) break;

    for (const repo of repos) {
      if (repo.private) privateCount++;
      else publicCount++;
    }

    if (repos.length < 100) break;
    page++;
  }

  return { publicCount, privateCount };
}

function buildLineGraphSvg(points) {
  const width = 900;
  const height = 300;
  const padding = { top: 30, right: 30, bottom: 50, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxCount = Math.max(1, ...points.map((p) => p.count));
  const stepX = points.length > 1 ? chartWidth / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = padding.left + stepX * i;
    const y = padding.top + chartHeight - (p.count / maxCount) * chartHeight;
    return { x, y, ...p };
  });

  const segments = coords
    .slice(0, -1)
    .map((p, i) => {
      const next = coords[i + 1];
      const color = COLORS[i % COLORS.length];
      return `<line x1="${p.x}" y1="${p.y}" x2="${next.x}" y2="${next.y}" stroke="${color}" stroke-width="3" stroke-linecap="round" />`;
    })
    .join("\n    ");

  const dots = coords
    .map((p, i) => {
      const color = COLORS[i % COLORS.length];
      return `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${color}" stroke="#FFFFFF" stroke-width="1.5" />`;
    })
    .join("\n    ");

  const labels = coords
    .map(
      (p) =>
        `<text x="${p.x}" y="${height - padding.bottom + 20}" font-size="11" fill="#374151" text-anchor="middle" font-family="Segoe UI, sans-serif">${p.label}</text>`
    )
    .join("\n    ");

  const countLabels = coords
    .map(
      (p) =>
        `<text x="${p.x}" y="${p.y - 10}" font-size="10" fill="#1F2937" text-anchor="middle" font-family="Segoe UI, sans-serif">${p.count}</text>`
    )
    .join("\n    ");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#FFFFFF" />
  <text x="${padding.left}" y="20" font-size="16" font-weight="bold" fill="#1F2937" font-family="Segoe UI, sans-serif">Monthly Commit Activity</text>
  <g>
    ${segments}
    ${dots}
    ${countLabels}
    ${labels}
  </g>
</svg>`;
}

function buildShieldsEndpoint(label, message, color) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      label,
      message: String(message),
      color,
    },
    null,
    2
  );
}

async function main() {
  await mkdir("stats", { recursive: true });

  const [points, days, counts] = await Promise.all([
    fetchMonthlyCommits(USERNAME),
    fetchDailyCommits(USERNAME),
    fetchRepoCounts(USERNAME),
  ]);

  const svg = buildLineGraphSvg(points);
  await writeFile("stats/activity-graph.svg", svg, "utf8");

  const dailySvg = buildDailyLineGraphSvg(days);
  await writeFile("stats/activity-graph-daily.svg", dailySvg, "utf8");

  await writeFile(
    "stats/public-repos.json",
    buildShieldsEndpoint("Public Repos", counts.publicCount, "2563EB")
  );
  await writeFile(
    "stats/private-repos.json",
    buildShieldsEndpoint("Private Repos", counts.privateCount, "EAB308")
  );

  console.log(`Done. Public: ${counts.publicCount}, Private: ${counts.privateCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
