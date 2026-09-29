// Report bodies (one per tab). Every number comes from the API response.
import { Link } from "react-router-dom";
import {
  BadgeCheck,
  Download,
  FileArchive,
  Hourglass,
  Info,
  Layers,
  PackageCheck,
  Repeat,
  Send,
  Sparkles,
  Timer,
  TriangleAlert,
  Users,
  Wallet,
  CircleCheck,
  Package,
} from "lucide-react";
import {
  Badge,
  DataTable,
  Panel,
  Stat,
  StatusBadge,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelative,
  plural,
  roleLabel,
} from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { formatHours } from "../overview/lib.js";
import { BarList, ChartPanel, SERIES } from "./charts.jsx";

const materialLink = (material) => (material.kind === "post" ? `/admin/conteudo/${material.id}` : `/admin/biblioteca/${material.id}`);
const compactMoney = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });
const moneyAxis = (cents) => compactMoney.format(cents / 100);
const where = (client, brand) => [client?.name, brand && brand.name !== client?.name ? brand.name : null].filter(Boolean).join(" › ");
// Numbers can be null (nothing to average yet) or, with a stale answer, missing.
const none = (value) => value === null || value === undefined || Number.isNaN(value);
const count = (value) => (none(value) ? "—" : formatNumber(value));
const percent = (value) => (none(value) ? "—" : formatPercent(value));
const decimal = (value) => (none(value) ? "—" : Number(value).toFixed(1).replace(".", ","));

function MaterialCell({ material, can }) {
  if (!material) return "—";
  const allowed = material.kind === "post" ? can("content.view") : can("materials.view");
  return allowed ? (
    <Link to={materialLink(material)} className="ov-cell-link">
      {material.title}
    </Link>
  ) : (
    material.title
  );
}

function TableNote({ shown, total }) {
  if (!(total > shown)) return null;
  return (
    <p className="ov-note">
      Mostrando os {formatNumber(shown)} registros mais recentes de {formatNumber(total)}. Exporte o CSV para ver todos.
    </p>
  );
}

// ------------------------------------------------------------- deliveries

export function DeliveriesReport({ data }) {
  const { can } = useAuth();
  const t = data.totals;
  const clientLink = (id) => (can("clients.view") ? `/admin/clientes/${id}` : undefined);
  return (
    <>
      <div className="ov-stats ov-stats--report ov-stats--n4">
        <Stat index={0} icon={Send} label="Liberações" value={count(t.releases)} hint="Versões enviadas aos clientes" />
        <Stat index={1} icon={Sparkles} label="Materiais novos" value={count(t.newMaterials)} hint="Primeira liberação de cada material" />
        <Stat index={2} icon={Layers} label="Novas versões" value={count(t.newVersions)} hint="Depois de ajustes ou atualizações" tone="teal" />
        <Stat index={3} icon={PackageCheck} label="Entregas finais" value={count(t.delivered)} hint="Arquivos finais disponibilizados" />
      </div>
      <ChartPanel
        index={4}
        eyebrow={`${plural(t.clients ?? 0, "cliente", "clientes")} · ${plural(t.materials ?? 0, "material", "materiais")}`}
        title="Liberações por período"
        data={data.series}
        interval={data.range.interval}
        charts={[
          {
            key: "releases",
            series: [
              { key: "newMaterials", label: "Materiais novos", color: SERIES.olive },
              { key: "newVersions", label: "Novas versões", color: SERIES.sage },
            ],
            format: formatNumber,
          },
        ]}
        empty={{ title: "Nenhuma liberação neste período.", description: "Quando a equipe liberar materiais para os clientes, eles aparecem aqui." }}
      />
      <div className="ov-pair">
        <Panel index={5} title="Por cliente" description="Versões liberadas no período.">
          <BarList
            label="Liberações por cliente"
            items={data.byClient.map((c) => ({
              key: c.id,
              label: c.name,
              value: c.total,
              to: clientLink(c.id),
              sublabel: `${plural(c.newMaterials, "material novo", "materiais novos")} · ${plural(c.newVersions, "nova versão", "novas versões")}`,
            }))}
          />
        </Panel>
        <Panel index={6} title="Por categoria" description="Onde a produção se concentrou.">
          <BarList label="Liberações por categoria" color={SERIES.sage} items={data.byCategory.map((c) => ({ key: c.id, label: c.name, value: c.total }))} />
        </Panel>
      </div>
      {data.byBrand.length > 1 && (
        <Panel index={7} title="Por marca">
          <BarList
            label="Liberações por marca"
            items={data.byBrand.map((b) => ({ key: b.id, label: b.name, value: b.total, sublabel: b.client.name !== b.name ? b.client.name : undefined }))}
          />
        </Panel>
      )}
      <Panel index={8} title="Liberações no período" footer={<TableNote shown={data.items.length} total={data.itemsTotal} />}>
        <DataTable
          bare
          dense
          caption="Liberações no período"
          rowKey="versionId"
          rows={data.items}
          empty={{ title: "Nenhuma liberação neste período." }}
          columns={[
            { key: "releasedAt", header: "Data", nowrap: true, render: (r) => formatDateTime(r.releasedAt), sortable: true, sortValue: (r) => r.releasedAt },
            { key: "material", header: "Material", primary: true, render: (r) => <MaterialCell material={r.material} can={can} /> },
            { key: "where", header: "Cliente", render: (r) => where(r.client, r.brand) },
            { key: "category", header: "Categoria", hideOnMobile: true, render: (r) => r.category.name },
            {
              key: "version",
              header: "Versão",
              nowrap: true,
              render: (r) => (
                <span className="ov-cell-version">
                  v{r.versionNumber}
                  {r.isNewMaterial && (
                    <Badge size="sm" tone="olive">
                      Novo
                    </Badge>
                  )}
                </span>
              ),
            },
            { key: "by", header: "Liberado por", hideOnMobile: true, render: (r) => r.releasedBy?.name ?? "—" },
          ]}
        />
      </Panel>
    </>
  );
}

// -------------------------------------------------------------- approvals

export function ApprovalsReport({ data }) {
  const { can } = useAuth();
  const t = data.totals;
  return (
    <>
      <div className="ov-stats ov-stats--report ov-stats--n4">
        <Stat
          index={0}
          icon={Timer}
          label="Tempo até a decisão"
          value={formatHours(t.avgHoursToDecision)}
          hint={none(t.medianHoursToDecision) ? "Da liberação à resposta do cliente" : `Média · mediana de ${formatHours(t.medianHoursToDecision)}`}
        />
        <Stat
          index={1}
          icon={BadgeCheck}
          label="Taxa de aprovação"
          value={percent(t.approvalRate)}
          hint={`${count(t.approved)} de ${plural(t.decisions ?? 0, "decisão", "decisões")}`}
          tone="teal"
        />
        <Stat
          index={2}
          icon={Repeat}
          label="Rodadas de ajuste"
          value={decimal(t.avgRounds)}
          hint={none(t.firstPassRate) ? "Por material aprovado" : `Por material · ${formatPercent(t.firstPassRate)} aprovados de primeira`}
          tone="clay"
        />
        <Stat
          index={3}
          icon={Hourglass}
          label="Aguardando decisão"
          value={count(t.pendingNow)}
          hint={none(t.avgHoursWaiting) ? "Nenhum material esperando agora" : `Agora · há ${formatHours(t.avgHoursWaiting)} em média`}
          tone="amber"
        />
      </div>
      <ChartPanel
        index={4}
        eyebrow="Decisões dos clientes"
        title="Aprovações e ajustes por período"
        description="O tempo conta da liberação da versão até a decisão do cliente."
        data={data.series}
        interval={data.range.interval}
        charts={[
          {
            key: "decisions",
            series: [
              { key: "approved", label: "Aprovações", color: SERIES.olive },
              { key: "changesRequested", label: "Ajustes solicitados", color: SERIES.clay },
            ],
            format: formatNumber,
          },
        ]}
        empty={{ title: "Nenhuma decisão neste período.", description: "Aprovações e pedidos de ajuste dos clientes aparecem aqui." }}
      />
      <div className="ov-pair">
        <Panel index={5} title="Rodadas até a aprovação" description="Materiais aprovados no período.">
          <BarList
            label="Rodadas de ajuste até a aprovação"
            color={SERIES.clay}
            empty="Nenhum material aprovado neste período."
            items={t.approvedMaterials ? data.roundsDistribution.map((r) => ({ key: r.rounds, label: r.label, value: r.total, color: r.rounds === 0 ? SERIES.olive : undefined })) : []}
          />
        </Panel>
        <Panel index={6} title="Por cliente">
          <DataTable
            bare
            dense
            caption="Decisões por cliente"
            rows={data.byClient}
            empty={{ title: "Sem decisões no período." }}
            columns={[
              { key: "name", header: "Cliente", primary: true, render: (c) => c.name },
              { key: "total", header: "Decisões", align: "end", render: (c) => formatNumber(c.total) },
              { key: "rate", header: "Aprovação", align: "end", render: (c) => percent(c.approvalRate) },
              { key: "hours", header: "Tempo médio", align: "end", nowrap: true, render: (c) => formatHours(c.avgHoursToDecision) },
            ]}
          />
        </Panel>
      </div>
      {data.waiting.length > 0 && (
        <Panel index={7} title="Aguardando decisão há mais tempo" description="Situação atual, independente do período escolhido.">
          <DataTable
            bare
            dense
            caption="Materiais aguardando decisão"
            rowKey={(r) => r.material.id}
            rows={data.waiting}
            columns={[
              { key: "material", header: "Material", primary: true, render: (r) => <MaterialCell material={r.material} can={can} /> },
              { key: "where", header: "Cliente", render: (r) => where(r.client, r.brand) },
              { key: "version", header: "Versão", nowrap: true, render: (r) => (r.versionNumber ? `v${r.versionNumber}` : "—") },
              { key: "released", header: "Liberado", nowrap: true, hideOnMobile: true, render: (r) => (r.releasedAt ? formatRelative(r.releasedAt) : "—") },
              { key: "waiting", header: "Esperando", align: "end", nowrap: true, render: (r) => formatHours(r.hoursWaiting) },
            ]}
          />
        </Panel>
      )}
      <Panel index={8} title="Materiais com decisões no período" footer={<TableNote shown={data.items.length} total={data.itemsTotal} />}>
        <DataTable
          bare
          dense
          caption="Materiais com decisões no período"
          rowKey={(r) => r.material.id}
          rows={data.items}
          empty={{ title: "Nenhuma decisão neste período." }}
          columns={[
            { key: "material", header: "Material", primary: true, render: (r) => <MaterialCell material={r.material} can={can} /> },
            { key: "where", header: "Cliente", render: (r) => where(r.client, r.brand) },
            { key: "decisions", header: "Decisões", align: "end", render: (r) => formatNumber(r.decisions) },
            { key: "rounds", header: "Rodadas", align: "end", render: (r) => (none(r.rounds) ? count(r.changesRequested) : count(r.rounds)) },
            {
              key: "last",
              header: "Última decisão",
              render: (r) => (
                <span className="ov-cell-stack">
                  <StatusBadge kind="decision" value={r.lastDecision?.decision} size="sm" />
                  {r.lastDecision && (
                    <span className="ov-cell-muted">
                      v{r.lastDecision.versionNumber} · {formatRelative(r.lastDecision.at)}
                    </span>
                  )}
                </span>
              ),
            },
            { key: "time", header: "Até aprovar", align: "end", nowrap: true, hideOnMobile: true, render: (r) => formatHours(r.hoursToApproval) },
          ]}
        />
      </Panel>
    </>
  );
}

// -------------------------------------------------------------- downloads

const AUDIENCE_NOTE = {
  client: (n) => (n ? `${plural(n, "download da equipe Metta fica", "downloads da equipe Metta ficam")} fora desta visão.` : "Somente downloads feitos pelos clientes."),
  team: (n) => (n ? `${plural(n, "download de cliente fica", "downloads de clientes ficam")} fora desta visão.` : "Somente downloads da equipe Metta."),
  all: () => "Clientes e equipe Metta.",
};

export function DownloadsReport({ data }) {
  const { can } = useAuth();
  const t = data.totals;
  const audienceNote = AUDIENCE_NOTE[data.audience] ?? AUDIENCE_NOTE.client;
  return (
    <>
      <div className="ov-callout" role="note">
        <Info size={18} strokeWidth={1.4} aria-hidden="true" />
        <p>
          <strong>Download não é aprovação.</strong> Estes números mostram quem baixou o quê. As decisões dos clientes ficam registradas
          separadamente, na aba Aprovações.
        </p>
      </div>
      <div className="ov-stats ov-stats--report ov-stats--n4">
        <Stat index={0} icon={Download} label="Downloads de arquivos" value={count(t.files)} hint={audienceNote(t.excluded)} />
        <Stat index={1} icon={FileArchive} label="Pacotes ZIP" value={count(t.zips)} hint="Kits, seleções e carrosséis" />
        <Stat index={2} icon={Users} label="Pessoas" value={count(t.users)} hint={plural(t.clients ?? 0, "cliente", "clientes")} />
        <Stat index={3} icon={Package} label="Materiais baixados" value={count(t.materials)} hint="Materiais diferentes, também dentro de ZIPs" />
      </div>
      <ChartPanel
        index={4}
        eyebrow="Uso dos arquivos"
        title="Downloads por período"
        data={data.series}
        interval={data.range.interval}
        charts={[
          {
            key: "downloads",
            series: [
              { key: "files", label: "Arquivos", color: SERIES.olive },
              { key: "zips", label: "Pacotes ZIP", color: SERIES.sage },
            ],
            format: formatNumber,
          },
        ]}
        empty={{ title: "Nenhum download neste período.", description: "Downloads de arquivos e pacotes aparecem aqui assim que acontecerem." }}
      />
      <div className="ov-trio">
        <Panel index={5} title="Por cliente">
          <BarList
            label="Downloads por cliente"
            items={data.byClient.map((c) => ({
              key: c.id,
              label: c.name,
              value: c.total,
              sublabel: `${plural(c.files, "arquivo", "arquivos")} · ${plural(c.zips, "ZIP", "ZIPs")} · ${plural(c.users, "pessoa", "pessoas")}`,
            }))}
          />
        </Panel>
        <Panel index={6} title="Materiais mais baixados">
          <BarList
            label="Materiais mais baixados"
            color={SERIES.sage}
            items={data.byMaterial.map((m) => ({
              key: m.id,
              label: m.title,
              value: m.total,
              to: m.kind ? ((m.kind === "post" ? can("content.view") : can("materials.view")) ? materialLink(m) : undefined) : undefined,
              sublabel: [where(m.client, m.brand), plural(m.users, "pessoa", "pessoas"), m.zips ? plural(m.zips, "vez em ZIP", "vezes em ZIP") : null]
                .filter(Boolean)
                .join(" · "),
            }))}
          />
        </Panel>
        <Panel index={7} title="Por pessoa">
          <BarList
            label="Downloads por pessoa"
            items={data.byUser.map((p) => ({
              key: p.id,
              label: p.name,
              value: p.total,
              sublabel: p.client ? p.client.name : roleLabel(p.role),
            }))}
          />
        </Panel>
      </div>
      <Panel index={8} title="Downloads recentes" footer={<TableNote shown={data.items.length} total={data.itemsTotal} />}>
        <DataTable
          bare
          dense
          caption="Downloads recentes"
          rows={data.items}
          empty={{ title: "Nenhum download neste período." }}
          columns={[
            { key: "at", header: "Data", nowrap: true, render: (r) => formatDateTime(r.createdAt) },
            {
              key: "name",
              header: "Arquivo ou pacote",
              primary: true,
              render: (r) => (
                <span className="ov-cell-stack">
                  <span className="ov-cell-file">{r.name}</span>
                  {r.material ? (
                    <span className="ov-cell-muted">{r.material.title}</span>
                  ) : r.materialCount > 1 ? (
                    <span className="ov-cell-muted">{plural(r.materialCount, "material", "materiais")}</span>
                  ) : null}
                </span>
              ),
            },
            { key: "kind", header: "Tipo", render: (r) => (r.kind === "zip" ? "ZIP" : "Arquivo") },
            { key: "who", header: "Pessoa", render: (r) => `${r.user.name}${r.user.role !== "client" ? " (equipe)" : ""}` },
            { key: "where", header: "Cliente", hideOnMobile: true, render: (r) => where(r.client, r.brand) || "—" },
          ]}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- finance

const MOVEMENT = {
  paid: { label: "Pago", tone: "olive" },
  pending: { label: "Pendente", tone: "amber" },
  failed: { label: "Falhou", tone: "red" },
};

export function FinanceReport({ data }) {
  const t = data.totals;
  return (
    <>
      <div className="ov-stats ov-stats--report ov-stats--money ov-stats--n4">
        <Stat index={0} icon={CircleCheck} label="Recebido" value={formatMoney(t.paidCents ?? 0)} hint={plural(t.paidCount ?? 0, "pagamento confirmado", "pagamentos confirmados")} />
        <Stat index={1} icon={Wallet} label="Pendente" value={formatMoney(t.pendingCents ?? 0)} hint={plural(t.pendingCount ?? 0, "cobrança em aberto", "cobranças em aberto")} tone="amber" />
        <Stat index={2} icon={TriangleAlert} label="Falhou" value={formatMoney(t.failedCents ?? 0)} hint={plural(t.failedCount ?? 0, "cobrança recusada", "cobranças recusadas")} tone="red" />
        <Stat
          index={3}
          icon={Repeat}
          label="Assinaturas ativas"
          value={count(t.activeSubscriptions)}
          hint={t.recurringCents ? `${formatMoney(t.recurringCents)} por mês, hoje` : "Nenhuma cobrança recorrente ativa"}
        />
      </div>
      {data.brandFilterExcludesSubscriptions && (
        <p className="ov-note">Assinaturas são da conta do cliente, não de uma marca: com o filtro de marca, só os pedidos entram no relatório.</p>
      )}
      <ChartPanel
        index={4}
        eyebrow="Por mês"
        title="Recebido, pendente e falhas"
        description="Recebido pela data de confirmação, pendente pela data da cobrança e falhas pela data da recusa."
        data={data.series}
        interval={data.range.interval}
        tableFormat={formatMoney}
        charts={[
          { key: "paid", title: "Recebido", series: [{ key: "paidCents", label: "Recebido", color: SERIES.olive }], format: formatMoney, axisFormat: moneyAxis, integer: false },
          { key: "pending", title: "Pendente", series: [{ key: "pendingCents", label: "Pendente", color: SERIES.amber }], format: formatMoney, axisFormat: moneyAxis, integer: false },
          { key: "failed", title: "Falhou", series: [{ key: "failedCents", label: "Falhou", color: SERIES.red }], format: formatMoney, axisFormat: moneyAxis, integer: false },
        ]}
        empty={{ title: "Nenhuma movimentação neste período.", description: "Pedidos e cobranças de assinatura aparecem aqui conforme são registrados." }}
      />
      <Panel index={5} title="Por cliente">
        <DataTable
          bare
          dense
          caption="Valores por cliente"
          rows={data.byClient}
          empty={{ title: "Sem movimentações no período." }}
          columns={[
            { key: "name", header: "Cliente", primary: true, render: (c) => c.name },
            { key: "paid", header: "Recebido", align: "end", nowrap: true, render: (c) => formatMoney(c.paidCents), sortable: true, sortValue: (c) => c.paidCents },
            { key: "pending", header: "Pendente", align: "end", nowrap: true, render: (c) => formatMoney(c.pendingCents), sortable: true, sortValue: (c) => c.pendingCents },
            { key: "failed", header: "Falhou", align: "end", nowrap: true, render: (c) => formatMoney(c.failedCents), sortable: true, sortValue: (c) => c.failedCents },
          ]}
        />
      </Panel>
      <Panel index={6} title="Movimentações" footer={<TableNote shown={data.items.length} total={data.itemsTotal} />}>
        <DataTable
          bare
          dense
          caption="Movimentações no período"
          rowKey={(m) => `${m.source}-${m.id}`}
          rows={data.items}
          empty={{ title: "Sem movimentações no período." }}
          columns={[
            { key: "date", header: "Data", nowrap: true, render: (m) => formatDateTime(m.at) },
            { key: "description", header: "Descrição", primary: true, render: (m) => m.description },
            { key: "client", header: "Cliente", render: (m) => where(m.client, m.brand) },
            { key: "source", header: "Origem", hideOnMobile: true, render: (m) => (m.source === "order" ? "Pedido" : "Assinatura") },
            {
              key: "status",
              header: "Situação",
              render: (m) => (
                <Badge tone={MOVEMENT[m.status]?.tone ?? "neutral"} dot size="sm">
                  {MOVEMENT[m.status]?.label ?? m.status}
                </Badge>
              ),
            },
            { key: "amount", header: "Valor", align: "end", nowrap: true, render: (m) => formatMoney(m.amountCents) },
          ]}
        />
      </Panel>
    </>
  );
}
