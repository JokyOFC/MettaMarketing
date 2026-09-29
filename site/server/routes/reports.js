// Reports (docs/API.md "Visão geral, relatórios e histórico"): deliveries,
// approvals, downloads and finance, always computed from real rows inside the
// caller's scope. Each report answers JSON or, with ?format=csv, a UTF-8 CSV
// with BOM and ";" separators (Excel pt-BR). Also exports the small time and
// CSV helpers shared by routes/activity.js and routes/overview.js.

import { Router } from "express";
import { assertBrand, assertClient, scopeSql } from "../lib/access.js";
import { logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { validation } from "../lib/errors.js";
import { contentDisposition } from "../lib/http.js";
import { parseJson } from "../lib/serialize.js";
import { parse, schemas, z } from "../lib/validate.js";

// ------------------------------------------------------------------ time

// Reports and history group by the team's local day (America/Sao_Paulo has
// had no daylight saving time since 2019, so a fixed offset is exact).
export const TZ_OFFSET_MINUTES = -180;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const localToday = (nowMs = Date.now()) => new Date(nowMs + TZ_OFFSET_MINUTES * MINUTE).toISOString().slice(0, 10);

export function addDaysToDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// UTC instant of local midnight at the start of `date` (YYYY-MM-DD).
export const localDayStartIso = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - TZ_OFFSET_MINUTES * MINUTE).toISOString();

// Local calendar date of an ISO instant (calendar dates pass through).
export function localDateOf(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + TZ_OFFSET_MINUTES * MINUTE).toISOString().slice(0, 10);
}

// "28/09/2026 14:30" in local time; calendar dates -> "28/09/2026".
export function formatLocalDateTime(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.split("-").reverse().join("/");
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return "";
  const local = new Date(ms + TZ_OFFSET_MINUTES * MINUTE).toISOString();
  return `${local.slice(8, 10)}/${local.slice(5, 7)}/${local.slice(0, 4)} ${local.slice(11, 16)}`;
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * HOUR));

function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export const hoursBetween = (fromIso, toIso) => {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return (b - a) / HOUR;
};

// Bucket key for a local date: day -> date, week -> Monday, month -> YYYY-MM.
function bucketKey(date, interval) {
  if (!date) return null;
  if (interval === "month") return date.slice(0, 7);
  if (interval === "week") return mondayOf(date);
  return date;
}

// Every bucket of the range (empty ones included, so charts stay honest).
function buckets(from, to, interval) {
  const out = [];
  if (interval === "month") {
    let [y, m] = from.slice(0, 7).split("-").map(Number);
    const [ty, tm] = to.slice(0, 7).split("-").map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      out.push({ key, start: `${key}-01`, end: `${key}-${String(lastDay).padStart(2, "0")}` });
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }
  const step = interval === "week" ? 7 : 1;
  for (let day = interval === "week" ? mondayOf(from) : from; day <= to; day = addDaysToDate(day, step))
    out.push({ key: day, start: day, end: interval === "week" ? addDaysToDate(day, 6) : day });
  return out;
}

function autoInterval(from, to) {
  const span = daysBetween(from, to) + 1;
  if (span <= 31) return "day";
  if (span <= 186) return "week";
  return "month";
}

// ------------------------------------------------------------------- CSV

const BOM = "﻿";
const numberFormat = (digits) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
const integerFmt = numberFormat(0);
const decimalFmt = numberFormat(1);
const moneyFmt = numberFormat(2);

// Numbers become pt-BR decimals; text that a spreadsheet would read as a
// formula (=, +, -, @) is neutralised with a leading apostrophe.
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    text = Number.isInteger(value) ? integerFmt.format(value) : decimalFmt.format(value);
  } else if (value && typeof value === "object" && "money" in value) {
    text = moneyFmt.format(Number(value.money) / 100);
  } else {
    text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  }
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvMoney = (cents) => (cents === null || cents === undefined ? null : { money: cents });

export function sendCsv(res, filename, header, rows) {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(";"));
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", contentDisposition(filename));
  res.send(`${BOM}${lines.join("\r\n")}\r\n`);
}

// -------------------------------------------------------------- queries

const opt = (schema) => z.preprocess((value) => (value === "" || value === null ? undefined : value), schema.optional());

const reportQuery = z.object({
  from: opt(schemas.date),
  to: opt(schemas.date),
  clientId: opt(z.string().max(64)),
  brandId: opt(z.string().max(64)),
  interval: opt(z.enum(["day", "week", "month"])),
  audience: opt(z.enum(["client", "team", "all"])),
  format: opt(z.enum(["json", "csv"])),
});

/**
 * Parses the shared query (?from&to&clientId&brandId&interval&format) and
 * checks the ids against the viewer's scope (out of scope -> 404).
 * -> { from, to, fromIso, toIso, interval, clientId, brandId, format, audience }
 */
export async function reportRange(req, { forceInterval } = {}) {
  const q = parse(reportQuery, req.query);
  const to = q.to ?? localToday();
  const from = q.from ?? addDaysToDate(to, -89);
  if (from > to) throw validation({ from: "A data inicial precisa ser anterior à data final." });
  if (daysBetween(from, to) > 3660) throw validation({ from: "Escolha um período de até 10 anos." });
  if (q.clientId) await assertClient(req, q.clientId);
  if (q.brandId) {
    const brand = await assertBrand(req, q.brandId);
    if (q.clientId && brand.client_id !== q.clientId) throw validation({ brandId: "Esta marca não pertence ao cliente escolhido." });
  }
  return {
    from,
    to,
    fromIso: localDayStartIso(from),
    toIso: localDayStartIso(addDaysToDate(to, 1)),
    interval: forceInterval ?? q.interval ?? autoInterval(from, to),
    clientId: q.clientId ?? null,
    brandId: q.brandId ?? null,
    audience: q.audience ?? "client",
    format: q.format ?? "json",
  };
}

const increment = (map, key, init, fn) => {
  if (key === null || key === undefined) return;
  if (!map.has(key)) map.set(key, init());
  fn(map.get(key));
};
const sortDesc = (list, field = "total") => list.sort((a, b) => b[field] - a[field] || String(a.name ?? "").localeCompare(String(b.name ?? ""), "pt-BR"));
const avg = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
const ratio = (a, b) => (b ? a / b : null);

// Adds the client/brand filters (aliases b = brands, m or other for brand id).
function withFilters(range, where, params, { client = "b.client_id", brand = "b.id" } = {}) {
  if (range.clientId) {
    where.push(`${client} = ?`);
    params.push(range.clientId);
  }
  if (range.brandId) {
    where.push(`${brand} = ?`);
    params.push(range.brandId);
  }
}

const rangeOut = (range) => ({ from: range.from, to: range.to, interval: range.interval });
const fileStamp = (range) => `${range.from}-a-${range.to}`;

// ------------------------------------------------------------- deliveries

async function deliveriesReport(req, range) {
  const db = req.ctx.db;
  const scope = scopeSql.materials(req, "m", "b");
  const where = ["v.released_at IS NOT NULL", "v.released_at >= ?", "v.released_at < ?", scope.sql];
  const params = [range.fromIso, range.toIso, ...scope.params];
  withFilters(range, where, params);
  const rows = await db.all(
    `SELECT v.id AS version_id, v.number, v.released_at, v.released_by, ru.name AS released_by_name,
            m.id AS material_id, m.title, m.kind, m.brand_id, b.name AS brand_name, b.client_id, cl.name AS client_name,
            m.category_id, cat.name AS category_name, cat.area AS category_area, m.project_id, p.name AS project_name,
            NOT EXISTS (
              SELECT 1 FROM material_versions pv
               WHERE pv.material_id = v.material_id AND pv.released_at IS NOT NULL
                 AND (pv.released_at < v.released_at OR (pv.released_at = v.released_at AND pv.number < v.number))
            ) AS is_first
       FROM material_versions v
       JOIN materials m ON m.id = v.material_id
       JOIN brands b ON b.id = m.brand_id
       JOIN clients cl ON cl.id = b.client_id
       JOIN categories cat ON cat.id = m.category_id
       LEFT JOIN projects p ON p.id = m.project_id
       LEFT JOIN users ru ON ru.id = v.released_by
      WHERE ${where.join(" AND ")}
      ORDER BY v.released_at DESC, v.id`,
    params,
  );

  // Final files delivered in the period (materials.delivered_at).
  const deliveredWhere = ["m.delivered_at >= ?", "m.delivered_at < ?", scope.sql];
  const deliveredParams = [range.fromIso, range.toIso, ...scope.params];
  withFilters(range, deliveredWhere, deliveredParams);
  const delivered = (await db.get(
    `SELECT COUNT(*) AS n FROM materials m JOIN brands b ON b.id = m.brand_id WHERE ${deliveredWhere.join(" AND ")}`,
    deliveredParams,
  )).n;

  const series = new Map(buckets(range.from, range.to, range.interval).map((b) => [b.key, { period: b.key, start: b.start, end: b.end, total: 0, newMaterials: 0, newVersions: 0 }]));
  const byClient = new Map();
  const byBrand = new Map();
  const byCategory = new Map();
  const materials = new Set();
  let newMaterials = 0;
  for (const row of rows) {
    const first = Boolean(row.is_first);
    if (first) newMaterials += 1;
    materials.add(row.material_id);
    const bucket = series.get(bucketKey(localDateOf(row.released_at), range.interval));
    if (bucket) {
      bucket.total += 1;
      bucket[first ? "newMaterials" : "newVersions"] += 1;
    }
    increment(byClient, row.client_id, () => ({ id: row.client_id, name: row.client_name, total: 0, newMaterials: 0, newVersions: 0 }), (e) => {
      e.total += 1;
      e[first ? "newMaterials" : "newVersions"] += 1;
    });
    increment(byBrand, row.brand_id, () => ({ id: row.brand_id, name: row.brand_name, client: { id: row.client_id, name: row.client_name }, total: 0 }), (e) => {
      e.total += 1;
    });
    increment(byCategory, row.category_id, () => ({ id: row.category_id, name: row.category_name, area: row.category_area, total: 0 }), (e) => {
      e.total += 1;
    });
  }

  const items = rows.map((row) => ({
    versionId: row.version_id,
    versionNumber: row.number,
    releasedAt: row.released_at,
    isNewMaterial: Boolean(row.is_first),
    material: { id: row.material_id, title: row.title, kind: row.kind },
    client: { id: row.client_id, name: row.client_name },
    brand: { id: row.brand_id, name: row.brand_name },
    category: { id: row.category_id, name: row.category_name, area: row.category_area },
    project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
    releasedBy: row.released_by ? { id: row.released_by, name: row.released_by_name ?? "Usuário removido" } : null,
  }));

  return {
    data: {
      range: rangeOut(range),
      totals: {
        releases: rows.length,
        newMaterials,
        newVersions: rows.length - newMaterials,
        materials: materials.size,
        clients: byClient.size,
        brands: byBrand.size,
        delivered,
      },
      series: [...series.values()],
      byClient: sortDesc([...byClient.values()]),
      byBrand: sortDesc([...byBrand.values()]),
      byCategory: sortDesc([...byCategory.values()]),
      items: items.slice(0, 300),
      itemsTotal: items.length,
    },
    csv: {
      filename: `metta-entregas-${fileStamp(range)}.csv`,
      header: ["Data da liberação", "Cliente", "Marca", "Categoria", "Material", "Tipo", "Versão", "Novo material", "Projeto", "Liberado por"],
      rows: items.map((item) => [
        formatLocalDateTime(item.releasedAt),
        item.client.name,
        item.brand.name,
        item.category.name,
        item.material.title,
        item.material.kind === "post" ? "Publicação" : "Material",
        item.versionNumber,
        item.isNewMaterial ? "Sim" : "Não (nova versão)",
        item.project?.name ?? "",
        item.releasedBy?.name ?? "",
      ]),
    },
  };
}

// -------------------------------------------------------------- approvals

const DECISION_LABEL = { approved: "Aprovado", changes_requested: "Ajustes solicitados" };

async function approvalsReport(req, range) {
  const db = req.ctx.db;
  const scope = scopeSql.materials(req, "m", "b");
  const where = ["ap.created_at >= ?", "ap.created_at < ?", scope.sql];
  const params = [range.fromIso, range.toIso, ...scope.params];
  withFilters(range, where, params);
  const decisions = await db.all(
    `SELECT ap.id, ap.decision, ap.created_at, ap.version_id, ap.material_id, ap.user_id, u.name AS user_name,
            v.number AS version_number, v.released_at AS version_released_at,
            m.title, m.kind, m.brand_id, b.name AS brand_name, b.client_id, cl.name AS client_name
       FROM approvals ap
       JOIN material_versions v ON v.id = ap.version_id
       JOIN materials m ON m.id = ap.material_id
       JOIN brands b ON b.id = m.brand_id
       JOIN clients cl ON cl.id = b.client_id
       LEFT JOIN users u ON u.id = ap.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY ap.created_at DESC, ap.id`,
    params,
  );

  // Adjustment rounds: change requests since the previous approval, counted
  // over each material's whole decision log.
  const materialIds = [...new Set(decisions.map((d) => d.material_id))];
  const history = new Map();
  for (let i = 0; i < materialIds.length; i += 400) {
    const chunk = materialIds.slice(i, i + 400);
    for (const row of await db.all(
      `SELECT id, material_id, decision, created_at FROM approvals WHERE material_id IN (${chunk.map(() => "?").join(", ")})
        ORDER BY created_at, id`,
      chunk,
    )) {
      if (!history.has(row.material_id)) history.set(row.material_id, []);
      history.get(row.material_id).push(row);
    }
  }
  const roundsAt = new Map(); // approval id -> rounds before it
  for (const log of history.values()) {
    let open = 0;
    for (const row of log) {
      if (row.decision === "changes_requested") open += 1;
      else {
        roundsAt.set(row.id, open);
        open = 0;
      }
    }
  }

  const series = new Map(buckets(range.from, range.to, range.interval).map((b) => [b.key, { period: b.key, start: b.start, end: b.end, approved: 0, changesRequested: 0, total: 0 }]));
  const byClient = new Map();
  const perMaterial = new Map();
  const hours = [];
  const approvalHours = [];
  const rounds = [];
  const distribution = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let approved = 0;
  for (const d of decisions) {
    const isApproved = d.decision === "approved";
    if (isApproved) approved += 1;
    const h = d.version_released_at ? hoursBetween(d.version_released_at, d.created_at) : null;
    if (h !== null) {
      hours.push(h);
      if (isApproved) approvalHours.push(h);
    }
    if (isApproved && roundsAt.has(d.id)) {
      const r = roundsAt.get(d.id);
      rounds.push(r);
      distribution[Math.min(3, r)] += 1;
    }
    const bucket = series.get(bucketKey(localDateOf(d.created_at), range.interval));
    if (bucket) {
      bucket.total += 1;
      bucket[isApproved ? "approved" : "changesRequested"] += 1;
    }
    increment(byClient, d.client_id, () => ({ id: d.client_id, name: d.client_name, total: 0, approved: 0, changesRequested: 0, hours: [] }), (e) => {
      e.total += 1;
      e[isApproved ? "approved" : "changesRequested"] += 1;
      if (h !== null) e.hours.push(h);
    });
    increment(
      perMaterial,
      d.material_id,
      () => ({
        material: { id: d.material_id, title: d.title, kind: d.kind },
        client: { id: d.client_id, name: d.client_name },
        brand: { id: d.brand_id, name: d.brand_name },
        decisions: 0,
        approvals: 0,
        changesRequested: 0,
        rounds: null,
        hoursToApproval: null,
        lastDecision: null,
      }),
      (e) => {
        e.decisions += 1;
        if (isApproved) e.approvals += 1;
        else e.changesRequested += 1;
        // decisions arrive newest first: the first one seen is the latest
        if (!e.lastDecision)
          e.lastDecision = { decision: d.decision, at: d.created_at, versionNumber: d.version_number, user: d.user_id ? { id: d.user_id, name: d.user_name } : null };
        if (isApproved && e.rounds === null) {
          e.rounds = roundsAt.get(d.id) ?? 0;
          e.hoursToApproval = h === null ? null : round1(h);
        }
      },
    );
  }

  // Materials waiting for the client right now (not limited to the period).
  const pendingWhere = ["m.approval_status = 'pending'", "m.visibility = 'released'", "m.archived_at IS NULL", scope.sql];
  const pendingParams = [...scope.params];
  withFilters(range, pendingWhere, pendingParams);
  const pendingRows = await db.all(
    `SELECT m.id, m.title, m.kind, b.id AS brand_id, b.name AS brand_name, b.client_id, cl.name AS client_name,
            rv.number AS version_number, rv.released_at
       FROM materials m
       JOIN brands b ON b.id = m.brand_id
       JOIN clients cl ON cl.id = b.client_id
       LEFT JOIN material_versions rv ON rv.id = m.released_version_id
      WHERE ${pendingWhere.join(" AND ")}
      ORDER BY rv.released_at, m.id`,
    pendingParams,
  );
  const nowIso = new Date().toISOString();
  const waiting = pendingRows.map((row) => ({
    material: { id: row.id, title: row.title, kind: row.kind },
    client: { id: row.client_id, name: row.client_name },
    brand: { id: row.brand_id, name: row.brand_name },
    versionNumber: row.version_number ?? null,
    releasedAt: row.released_at ?? null,
    hoursWaiting: row.released_at ? round1(hoursBetween(row.released_at, nowIso)) : null,
  }));
  const waitingHours = waiting.map((w) => w.hoursWaiting).filter((h) => h !== null);

  const items = [...perMaterial.values()].sort((a, b) => String(b.lastDecision.at).localeCompare(String(a.lastDecision.at)));

  return {
    data: {
      range: rangeOut(range),
      totals: {
        decisions: decisions.length,
        approved,
        changesRequested: decisions.length - approved,
        approvalRate: ratio(approved, decisions.length),
        avgHoursToDecision: round1(avg(hours)),
        medianHoursToDecision: round1(median(hours)),
        avgHoursToApproval: round1(avg(approvalHours)),
        approvedMaterials: rounds.length,
        avgRounds: rounds.length ? Math.round(avg(rounds) * 100) / 100 : null,
        firstPassRate: ratio(distribution[0], rounds.length),
        materials: perMaterial.size,
        pendingNow: waiting.length,
        avgHoursWaiting: round1(avg(waitingHours)),
      },
      roundsDistribution: [
        { rounds: 0, label: "Aprovados de primeira", total: distribution[0] },
        { rounds: 1, label: "1 rodada de ajustes", total: distribution[1] },
        { rounds: 2, label: "2 rodadas de ajustes", total: distribution[2] },
        { rounds: 3, label: "3 rodadas ou mais", total: distribution[3] },
      ],
      series: [...series.values()],
      byClient: sortDesc(
        [...byClient.values()].map(({ hours: list, ...entry }) => ({
          ...entry,
          approvalRate: ratio(entry.approved, entry.total),
          avgHoursToDecision: round1(avg(list)),
        })),
      ),
      waiting: [...waiting].sort((a, b) => (b.hoursWaiting ?? 0) - (a.hoursWaiting ?? 0)).slice(0, 20),
      items: items.slice(0, 300),
      itemsTotal: items.length,
    },
    csv: {
      filename: `metta-aprovacoes-${fileStamp(range)}.csv`,
      header: ["Data da decisão", "Cliente", "Marca", "Material", "Versão", "Decisão", "Horas desde a liberação", "Rodadas de ajuste antes da aprovação", "Pessoa"],
      rows: decisions.map((d) => {
        const h = d.version_released_at ? hoursBetween(d.version_released_at, d.created_at) : null;
        return [
          formatLocalDateTime(d.created_at),
          d.client_name,
          d.brand_name,
          d.title,
          d.version_number,
          DECISION_LABEL[d.decision] ?? d.decision,
          h === null ? null : round1(h),
          d.decision === "approved" ? (roundsAt.get(d.id) ?? 0) : null,
          d.user_name ?? "",
        ];
      }),
    },
  };
}

// -------------------------------------------------------------- downloads

// "Logo principal, Carrossel lançamento e mais 3" for a ZIP's CSV cell.
function csvMaterialList(list, max = 10) {
  const titles = list.map((m) => m.title ?? "Material removido");
  if (titles.length <= max) return titles.join(", ");
  return `${titles.slice(0, max).join(", ")} e mais ${titles.length - max}`;
}

async function downloadsReport(req, range) {
  const db = req.ctx.db;
  const scope = scopeSql.clients(req, "cl");
  const base = ["de.created_at >= ?", "de.created_at < ?", scope.sql];
  const baseParams = [range.fromIso, range.toIso, ...scope.params];
  withFilters(range, base, baseParams, { client: "de.client_id", brand: "de.brand_id" });
  const FROM = `FROM download_events de
       JOIN users u ON u.id = de.user_id
       LEFT JOIN clients cl ON cl.id = de.client_id
       LEFT JOIN brands b ON b.id = de.brand_id
       LEFT JOIN materials m ON m.id = de.material_id
       LEFT JOIN material_files f ON f.id = de.file_id
       LEFT JOIN zip_jobs z ON z.id = de.zip_job_id`;
  const audienceSql = { client: "u.role = 'client'", team: "u.role <> 'client'", all: "1 = 1" }[range.audience];
  const rows = await db.all(
    `SELECT de.id, de.kind, de.scope, de.created_at, de.user_id, u.name AS user_name, u.role AS user_role,
            de.client_id, cl.name AS client_name, de.brand_id, b.name AS brand_name,
            de.material_id, m.title AS material_title, m.kind AS material_kind,
            de.file_id, f.display_name AS file_name, f.ext AS file_ext,
            de.zip_job_id, z.label AS zip_label, z.filename AS zip_filename, z.entries AS zip_entries
       ${FROM}
      WHERE ${[...base, audienceSql].join(" AND ")}
      ORDER BY de.created_at DESC, de.id`,
    baseParams,
  );
  // A ZIP event has no material_id: the materials it held are in the job's
  // entries (the same source as the material history). Each ZIP counts once
  // for every material inside it.
  const zipMaterialIds = new Map(); // event id -> [material id]
  const wanted = new Set();
  for (const row of rows) {
    if (row.kind !== "zip" || !row.zip_entries) continue;
    const entries = parseJson(row.zip_entries, []);
    const ids = [...new Set((Array.isArray(entries) ? entries : []).map((e) => e?.m).filter((id) => typeof id === "string" && id))];
    zipMaterialIds.set(row.id, ids);
    ids.forEach((id) => wanted.add(id));
  }
  const zipMaterials = new Map();
  const wantedIds = [...wanted];
  for (let i = 0; i < wantedIds.length; i += 400) {
    const chunk = wantedIds.slice(i, i + 400);
    for (const row of await db.all(
      `SELECT m.id, m.title, m.kind, b.id AS brand_id, b.name AS brand_name, cl.id AS client_id, cl.name AS client_name
         FROM materials m JOIN brands b ON b.id = m.brand_id JOIN clients cl ON cl.id = b.client_id
        WHERE m.id IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
    ))
      zipMaterials.set(row.id, row);
  }
  // [{ id, title, kind, client, brand }] a download event touched.
  const materialsOf = (row) => {
    if (row.kind !== "zip")
      return row.material_id
        ? [{ id: row.material_id, title: row.material_title, kind: row.material_kind, clientId: row.client_id, clientName: row.client_name, brandId: row.brand_id, brandName: row.brand_name }]
        : [];
    return (zipMaterialIds.get(row.id) ?? []).map((id) => {
      const found = zipMaterials.get(id);
      return found
        ? { id, title: found.title, kind: found.kind, clientId: found.client_id, clientName: found.client_name, brandId: found.brand_id, brandName: found.brand_name }
        : { id, title: null, kind: null, clientId: row.client_id, clientName: row.client_name, brandId: row.brand_id, brandName: row.brand_name };
    });
  };
  // How many events the audience filter left out (e.g. team downloads).
  const excluded = range.audience === "all"
    ? 0
    : (await db.get(`SELECT COUNT(*) AS n ${FROM} WHERE ${[...base, `NOT (${audienceSql})`].join(" AND ")}`, baseParams)).n;

  const series = new Map(buckets(range.from, range.to, range.interval).map((b) => [b.key, { period: b.key, start: b.start, end: b.end, files: 0, zips: 0, total: 0 }]));
  const byClient = new Map();
  const byMaterial = new Map();
  const byUser = new Map();
  let files = 0;
  for (const row of rows) {
    const isZip = row.kind === "zip";
    if (!isZip) files += 1;
    const bucket = series.get(bucketKey(localDateOf(row.created_at), range.interval));
    if (bucket) {
      bucket.total += 1;
      bucket[isZip ? "zips" : "files"] += 1;
    }
    increment(byClient, row.client_id, () => ({ id: row.client_id, name: row.client_name, total: 0, files: 0, zips: 0, users: new Set() }), (e) => {
      e.total += 1;
      e[isZip ? "zips" : "files"] += 1;
      e.users.add(row.user_id);
    });
    for (const mat of materialsOf(row))
      increment(
        byMaterial,
        mat.id,
        () => ({
          id: mat.id,
          title: mat.title ?? "Material removido",
          kind: mat.kind ?? null,
          client: mat.clientId ? { id: mat.clientId, name: mat.clientName } : null,
          brand: mat.brandId ? { id: mat.brandId, name: mat.brandName } : null,
          total: 0,
          files: 0,
          zips: 0,
          users: new Set(),
          lastAt: null,
        }),
        (e) => {
          e.total += 1;
          e[isZip ? "zips" : "files"] += 1;
          e.users.add(row.user_id);
          e.lastAt ??= row.created_at;
        },
      );
    increment(
      byUser,
      row.user_id,
      () => ({ id: row.user_id, name: row.user_name, role: row.user_role, client: row.client_id && row.user_role === "client" ? { id: row.client_id, name: row.client_name } : null, total: 0, files: 0, zips: 0, lastAt: null }),
      (e) => {
        e.total += 1;
        e[isZip ? "zips" : "files"] += 1;
        e.lastAt ??= row.created_at;
      },
    );
  }
  const sets = (list) => list.map(({ users, ...entry }) => ({ ...entry, users: users.size }));
  const zipName = (row) => row.zip_label || row.zip_filename || "Pacote ZIP";

  return {
    data: {
      range: rangeOut(range),
      audience: range.audience,
      totals: {
        events: rows.length,
        files,
        zips: rows.length - files,
        users: byUser.size,
        materials: byMaterial.size,
        clients: byClient.size,
        excluded,
      },
      series: [...series.values()],
      byClient: sortDesc(sets([...byClient.values()])),
      byMaterial: sortDesc(sets([...byMaterial.values()])).slice(0, 50),
      byUser: sortDesc([...byUser.values()]).slice(0, 50),
      items: rows.slice(0, 300).map((row) => {
        const touched = row.kind === "zip" ? materialsOf(row) : [];
        const single = touched.length === 1 ? touched[0] : null;
        return {
          id: row.id,
          kind: row.kind,
          createdAt: row.created_at,
          user: { id: row.user_id, name: row.user_name, role: row.user_role },
          client: row.client_id ? { id: row.client_id, name: row.client_name } : null,
          brand: row.brand_id ? { id: row.brand_id, name: row.brand_name } : null,
          material: row.material_id
            ? { id: row.material_id, title: row.material_title ?? "Material removido", kind: row.material_kind ?? null }
            : single
              ? { id: single.id, title: single.title ?? "Material removido", kind: single.kind ?? null }
              : null,
          // materials inside a ZIP (null for single files)
          materialCount: row.kind === "zip" ? touched.length : null,
          name: row.kind === "zip" ? zipName(row) : (row.file_name ?? "Arquivo removido"),
        };
      }),
      itemsTotal: rows.length,
    },
    csv: {
      filename: `metta-downloads-${fileStamp(range)}.csv`,
      header: ["Data", "Cliente", "Marca", "Material", "Arquivo ou pacote", "Tipo", "Pessoa", "Perfil"],
      rows: rows.map((row) => [
        formatLocalDateTime(row.created_at),
        row.client_name ?? "",
        row.brand_name ?? "",
        row.kind === "zip" ? csvMaterialList(materialsOf(row)) : (row.material_title ?? ""),
        row.kind === "zip" ? zipName(row) : (row.file_name ?? ""),
        row.kind === "zip" ? "ZIP" : "Arquivo",
        row.user_name,
        row.user_role === "client" ? "Cliente" : "Equipe Metta",
      ]),
    },
  };
}

// ---------------------------------------------------------------- finance

const MOVEMENT_LABEL = { paid: "Pago", pending: "Pendente", failed: "Falhou" };
const PAID_PAYMENT = new Set(["approved"]);
const FAILED_PAYMENT = new Set(["rejected", "cancelled", "charged_back"]);

async function financeReport(req, range) {
  const db = req.ctx.db;
  const scope = scopeSql.clients(req, "cl");
  const movements = [];

  // Orders: paid by paid_at, pending by issue date, failed by last update.
  const orderWhere = [scope.sql, "o.status IN ('paid', 'pending_payment', 'failed')"];
  const orderParams = [...scope.params];
  withFilters(range, orderWhere, orderParams, { client: "o.client_id", brand: "o.brand_id" });
  for (const row of await db.all(
    `SELECT o.id, o.status, o.amount_cents, o.description, o.due_date, o.paid_at, o.created_at, o.updated_at,
            o.client_id, cl.name AS client_name, o.brand_id, b.name AS brand_name
       FROM orders o JOIN clients cl ON cl.id = o.client_id LEFT JOIN brands b ON b.id = o.brand_id
      WHERE ${orderWhere.join(" AND ")}`,
    orderParams,
  )) {
    const status = row.status === "paid" ? "paid" : row.status === "failed" ? "failed" : "pending";
    const when = status === "paid" ? row.paid_at ?? row.updated_at : status === "failed" ? row.updated_at : row.created_at;
    const date = localDateOf(when);
    if (!date || date < range.from || date > range.to) continue;
    movements.push({
      source: "order",
      id: row.id,
      status,
      amountCents: row.amount_cents,
      dueDate: row.due_date ?? null,
      date,
      at: when,
      description: row.description,
      client: { id: row.client_id, name: row.client_name },
      brand: row.brand_id ? { id: row.brand_id, name: row.brand_name } : null,
    });
  }

  // Subscription charges live only in payments (order payments are counted above).
  if (!range.brandId) {
    const payWhere = [scope.sql, "p.order_id IS NULL", "p.subscription_id IS NOT NULL"];
    const payParams = [...scope.params];
    if (range.clientId) {
      payWhere.push("p.client_id = ?");
      payParams.push(range.clientId);
    }
    for (const row of await db.all(
      `SELECT p.id, p.status, p.amount_cents, p.paid_at, p.created_at, p.client_id, cl.name AS client_name, s.id AS subscription_id,
              sv.name AS service_name
         FROM payments p
         JOIN clients cl ON cl.id = p.client_id
         LEFT JOIN subscriptions s ON s.id = p.subscription_id
         LEFT JOIN services sv ON sv.id = s.service_id
        WHERE ${payWhere.join(" AND ")}`,
      payParams,
    )) {
      const status = PAID_PAYMENT.has(row.status) ? "paid" : FAILED_PAYMENT.has(row.status) ? "failed" : row.status === "refunded" ? null : "pending";
      if (!status) continue;
      const when = status === "paid" ? row.paid_at ?? row.created_at : row.created_at;
      const date = localDateOf(when);
      if (!date || date < range.from || date > range.to) continue;
      movements.push({
        source: "subscription",
        id: row.id,
        status,
        amountCents: row.amount_cents ?? 0,
        date,
        at: when,
        description: row.service_name ? `Assinatura ${row.service_name}` : "Assinatura",
        client: { id: row.client_id, name: row.client_name },
        brand: null,
      });
    }
  }
  movements.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const empty = () => ({ paidCents: 0, paidCount: 0, pendingCents: 0, pendingCount: 0, failedCents: 0, failedCount: 0 });
  const add = (target, m) => {
    target[`${m.status}Cents`] += m.amountCents;
    target[`${m.status}Count`] += 1;
  };
  const totals = empty();
  const series = new Map(buckets(range.from, range.to, range.interval).map((b) => [b.key, { period: b.key, start: b.start, end: b.end, ...empty() }]));
  const byClient = new Map();
  for (const m of movements) {
    add(totals, m);
    const bucket = series.get(bucketKey(m.date, range.interval));
    if (bucket) add(bucket, m);
    increment(byClient, m.client.id, () => ({ id: m.client.id, name: m.client.name, ...empty() }), (e) => add(e, m));
  }

  // Current snapshot (not tied to the period).
  const subWhere = [scope.sql, "s.status = 'active'"];
  const subParams = [...scope.params];
  if (range.clientId) {
    subWhere.push("s.client_id = ?");
    subParams.push(range.clientId);
  }
  const subs = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(s.amount_cents), 0) AS cents FROM subscriptions s JOIN clients cl ON cl.id = s.client_id
      WHERE ${subWhere.join(" AND ")}`,
    subParams,
  );

  return {
    data: {
      range: rangeOut(range),
      totals: { ...totals, activeSubscriptions: subs.n, recurringCents: subs.cents },
      brandFilterExcludesSubscriptions: Boolean(range.brandId),
      series: [...series.values()],
      byClient: [...byClient.values()].sort((a, b) => b.paidCents - a.paidCents || b.pendingCents - a.pendingCents),
      items: movements.slice(0, 300),
      itemsTotal: movements.length,
    },
    csv: {
      filename: `metta-financeiro-${fileStamp(range)}.csv`,
      header: ["Mês", "Data", "Cliente", "Marca", "Descrição", "Origem", "Situação", "Valor (R$)"],
      rows: movements.map((m) => [
        `${m.date.slice(5, 7)}/${m.date.slice(0, 4)}`,
        formatLocalDateTime(m.date),
        m.client.name,
        m.brand?.name ?? "",
        m.description,
        m.source === "order" ? "Pedido" : "Assinatura",
        MOVEMENT_LABEL[m.status],
        csvMoney(m.amountCents),
      ]),
    },
  };
}

// ----------------------------------------------------------------- router

const REPORTS = {
  deliveries: { cap: "reports.view", build: deliveriesReport, label: "entregas" },
  approvals: { cap: "reports.view", build: approvalsReport, label: "aprovações" },
  downloads: { cap: "reports.view", build: downloadsReport, label: "downloads" },
  finance: { cap: "reports.finance", build: financeReport, label: "financeiro", interval: "month" },
};

export default function reportsRoutes() {
  const router = Router();

  // Clients and brands the viewer can filter by.
  router.get("/api/reports/filters", requireAuth, requireCap("reports.view", "reports.finance"), async (req, res) => {
    const db = req.ctx.db;
    const clients = scopeSql.clients(req, "c");
    const brands = scopeSql.brands(req, "b");
    res.json({
      clients: (await db
        .all(`SELECT c.id, c.name, c.status FROM clients c WHERE ${clients.sql} ORDER BY c.name COLLATE utf8mb4_0900_ai_ci`, clients.params))
        .map((row) => ({ id: row.id, name: row.name, status: row.status })),
      brands: (await db
        .all(`SELECT b.id, b.name, b.client_id, b.status FROM brands b WHERE ${brands.sql} ORDER BY b.name COLLATE utf8mb4_0900_ai_ci`, brands.params))
        .map((row) => ({ id: row.id, name: row.name, clientId: row.client_id, status: row.status })),
      reports: Object.entries(REPORTS)
        .filter(([, report]) => req.user.capabilities.includes(report.cap))
        .map(([key]) => key),
    });
  });

  for (const [key, report] of Object.entries(REPORTS)) {
    router.get(`/api/reports/${key}`, requireAuth, requireCap(report.cap), async (req, res) => {
      const range = await reportRange(req, { forceInterval: report.interval && !req.query.interval ? report.interval : undefined });
      const { data, csv } = await report.build(req, range);
      if (range.format !== "csv") return res.json(data);
      await logActivity(req, {
        action: "report.exported",
        entityType: "report",
        entityId: key,
        clientId: range.clientId,
        brandId: range.brandId,
        summary: `${req.user.name} exportou o relatório de ${report.label} (${formatLocalDateTime(range.from)} a ${formatLocalDateTime(range.to)}) em CSV.`,
        data: { report: key, from: range.from, to: range.to, clientId: range.clientId, brandId: range.brandId, rows: csv.rows.length },
      });
      sendCsv(res, csv.filename, csv.header, csv.rows);
    });
  }

  return router;
}
