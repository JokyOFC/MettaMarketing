import { Link } from "react-router-dom";
import { ArrowRight, BadgeCheck, CalendarDays, CircleAlert, ClipboardList, FileSignature, FolderOpen, History, Shapes, Wallet } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorState,
  Panel,
  ProgressBar,
  SkeletonCards,
  SkeletonRows,
  StatusBadge,
  Thumb,
  formatDate,
  formatMoney,
  formatRelative,
  networkLabel,
  plural,
  postFormatLabel,
  useApi,
} from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle, useBrand } from "../../shell/index.js";
import { ActivityFeed, DateBlock } from "../../admin/activity/feed.jsx";
import { clientMaterialLink, firstName, greeting } from "../../admin/overview/lib.js";
import "../../admin/overview/ov.css";

const cx = (...parts) => parts.filter(Boolean).join(" ");

function thumbBg(material) {
  if (material.previewBg && material.previewBg !== "auto") return material.previewBg;
  return material.category?.area === "identity" ? "light" : "auto";
}

function materialMeta(material) {
  const post = material.post;
  if (post) return [postFormatLabel(post.format), networkLabel(post.network)].filter(Boolean).join(" · ");
  return material.category?.name ?? "";
}

// Card with the real thumbnail (contained, never cropped) and what matters to the client.
function MaterialCard({ material, index, cta }) {
  const number = material.version?.number;
  const releasedAt = material.version?.releasedAt ?? material.releasedAt;
  const slides = material.post?.format === "carrossel" && material.fileCount > 1 ? `${material.fileCount} slides` : null;
  return (
    <li className="ov-mcard ui-enter" style={{ "--i": Math.min(index, 8) }}>
      <Link to={clientMaterialLink(material)} className="ov-mcard__link">
        <Thumb
          thumb={material.thumb}
          aspect={4 / 3}
          fit="contain"
          bg={thumbBg(material)}
          alt=""
          format={material.formats?.[0] ?? " "}
          badge={slides || (number > 1 ? `Versão ${number}` : undefined)}
        />
        <span className="ov-mcard__text">
          <span className="ov-mcard__title">{material.title}</span>
          <span className="ov-mcard__meta">{materialMeta(material)}</span>
          {releasedAt && <span className="ov-mcard__when">Liberado {formatRelative(releasedAt)}</span>}
          {cta && (
            <span className="ov-mcard__cta">
              {cta}
              <ArrowRight size={14} strokeWidth={1.4} aria-hidden="true" />
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

function Briefings({ items }) {
  return (
    <ol className="ov-rows">
      {items.map((briefing, index) => {
        const total = briefing.questionCount || 0;
        const done = briefing.answeredCount || 0;
        return (
          <li key={briefing.id} className="ov-row ui-enter" style={{ "--i": Math.min(index, 8) }}>
            <div className="ov-row__body">
              <Link to={`/painel/briefings/${briefing.id}`} className="ov-row__title ov-stretch">
                {briefing.title}
              </Link>
              <p className="ov-row__meta">
                {briefing.dueDate
                  ? briefing.overdue
                    ? `Prazo era ${formatDate(briefing.dueDate)}`
                    : `Responder até ${formatDate(briefing.dueDate)}`
                  : briefing.sentAt
                    ? `Enviado ${formatRelative(briefing.sentAt)}`
                    : briefing.brand.name}
              </p>
              {total > 0 && (
                <ProgressBar
                  size="sm"
                  value={done / total}
                  label={`${done} de ${total} respondidas`}
                  aria-label={`${done} de ${total} perguntas respondidas`}
                />
              )}
            </div>
            <StatusBadge kind="briefing" value={briefing.status} size="sm" />
          </li>
        );
      })}
    </ol>
  );
}

function Upcoming({ items }) {
  return (
    <ol className="ov-rows">
      {items.map((material, index) => (
        <li key={material.id} className="ov-row ov-row--dated ui-enter" style={{ "--i": Math.min(index, 8) }}>
          <DateBlock date={material.post?.plannedDate} />
          <div className="ov-row__body">
            <Link to={clientMaterialLink(material)} className="ov-row__title ov-stretch">
              {material.title}
              <span className="ui-sr-only">, previsto para {formatDate(material.post?.plannedDate)}</span>
            </Link>
            <p className="ov-row__meta">
              {materialMeta(material)}
              {material.post?.plannedTime ? ` · ${material.post.plannedTime.slice(0, 5)}` : ""}
            </p>
          </div>
          <div className="ov-row__side">
            {material.requiresApproval && <StatusBadge kind="approval" value={material.approvalStatus} size="sm" />}
            {material.post?.publicationStatus && material.post.publicationStatus !== "not_scheduled" && (
              <StatusBadge kind="publication" value={material.post.publicationStatus} size="sm" />
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

const STEPS = [
  {
    title: "A Metta libera suas entregas",
    text: "Quando um material estiver pronto para você, ele aparece aqui e você recebe um aviso.",
  },
  {
    title: "Você revisa e decide",
    text: "Abra a prévia, comente, aprove ou peça ajustes. Cada versão e cada decisão ficam registradas.",
  },
  {
    title: "Tudo pronto para usar",
    text: "Logos, cores, tipografia e conteúdos ficam em Minha marca e Arquivos, com download dos arquivos liberados.",
  },
];

function FirstSteps() {
  return (
    <Panel index={1} eyebrow="Como funciona" title="Seu espaço com a Metta" className="ov-first">
      <ol className="ov-steps">
        {STEPS.map((step, index) => (
          <li key={step.title} className="ov-step ui-enter" style={{ "--i": index + 1 }}>
            <span className="ov-step__n" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="ov-step__title">{step.title}</span>
            <span className="ov-step__text">{step.text}</span>
          </li>
        ))}
      </ol>
      <p className="ov-first__note">
        Se precisarmos de informações sobre sua marca, enviaremos um briefing para você preencher por aqui mesmo.
      </p>
      <div className="ov-first__actions">
        <Button variant="primary" to="/painel/marca" iconRight={ArrowRight}>
          Conhecer Minha marca
        </Button>
      </div>
    </Panel>
  );
}

const SHORTCUTS = [
  { to: "/painel/marca", icon: Shapes, title: "Minha marca", text: "Logos, cores e tipografia prontos para usar." },
  { to: "/painel/arquivos", icon: FolderOpen, title: "Arquivos", text: "Tudo o que foi liberado, com download." },
  { to: "/painel/conteudo", icon: CalendarDays, title: "Conteúdo", text: "Posts, calendário e aprovações." },
  { to: "/painel/historico", icon: History, title: "Histórico", text: "Entregas, versões e decisões registradas." },
];

function Shortcuts() {
  return (
    <nav aria-label="Atalhos">
      <ul className="ov-shortcuts ov-shortcuts--grid">
        {SHORTCUTS.map(({ icon: Glyph, ...link }, index) => (
          <li key={link.to} className="ui-enter" style={{ "--i": Math.min(index + 2, 8) }}>
            <Link to={link.to} className="ov-shortcut">
              <span className="ov-shortcut__icon" aria-hidden="true">
                <Glyph size={18} strokeWidth={1.4} />
              </span>
              <span className="ov-shortcut__text">
                <strong>{link.title}</strong>
                <span>{link.text}</span>
              </span>
              <ArrowRight className="ov-shortcut__go" size={16} strokeWidth={1.4} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// Open charges: awaiting payment, or refused by Mercado Pago and still to pay
// (Financeiro offers "Tentar de novo" for those).
function BillingNotice({ billing }) {
  const open = billing.pendingOrders;
  const failed = billing.failedOrders ?? 0;
  const waiting = open - failed;
  let title;
  let detail;
  if (failed && !waiting) {
    title = failed === 1 ? "Um pagamento não foi aprovado" : `${failed} pagamentos não foram aprovados`;
    detail = `${formatMoney(billing.pendingAmountCents)} ainda em aberto · você pode tentar de novo pelo Financeiro`;
  } else {
    title = open === 1 ? "Há 1 pagamento pendente" : `Há ${open} pagamentos pendentes`;
    detail = [
      formatMoney(billing.pendingAmountCents),
      failed ? plural(failed, "não foi aprovado", "não foram aprovados") : null,
      billing.nextDueDate ? `vencimento ${formatRelative(billing.nextDueDate)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return (
    <div className={cx("ov-notice", failed > 0 && "ov-notice--alert", "ui-enter")} role="status">
      <span className="ov-notice__icon" aria-hidden="true">
        {failed > 0 ? <CircleAlert size={18} strokeWidth={1.4} /> : <Wallet size={18} strokeWidth={1.4} />}
      </span>
      <p className="ov-notice__text">
        <strong>{title}</strong>
        <span>{detail}</span>
      </p>
      <Button size="sm" to="/painel/financeiro" iconRight={ArrowRight}>
        Ver financeiro
      </Button>
    </div>
  );
}

// Contract sent by Metta and still waiting for the client's signature.
function ContractNotice({ count }) {
  return (
    <div className="ov-notice ui-enter" role="status">
      <span className="ov-notice__icon" aria-hidden="true">
        <FileSignature size={18} strokeWidth={1.4} />
      </span>
      <p className="ov-notice__text">
        <strong>{count === 1 ? "Um contrato aguarda sua assinatura" : `${count} contratos aguardam sua assinatura`}</strong>
        <span>Assine pela plataforma, em Financeiro, ou pelo e-mail da AssinaVelox.</span>
      </p>
      <Button size="sm" to="/painel/financeiro#contratos" iconRight={ArrowRight}>
        {count === 1 ? "Ver contrato" : "Ver contratos"}
      </Button>
    </div>
  );
}

function intro(data) {
  if (!data) return "Entregas, aprovações e briefings da sua marca, em um só lugar.";
  const pending = data.totals.pendingApprovals;
  if (pending > 0) return `${plural(pending, "item espera", "itens esperam")} sua aprovação. Quando puder, dê uma olhada.`;
  if (data.totals.released > 0) return "Tudo em dia por aqui. Suas entregas ficam organizadas em Minha marca e Arquivos.";
  return "Este é o seu espaço com a Metta para acompanhar entregas, aprovações e briefings.";
}

export default function ClientOverview() {
  usePageTitle("Início");
  const { user } = useAuth();
  const { brand, brandId, brands } = useBrand();
  const { data, error, loading, refreshing, reload } = useApi("/portal/overview", { params: brandId ? { brandId } : undefined });

  const firstUse = data && data.totals.released === 0 && data.totals.briefingsToFill === 0 && data.totals.activity === 0 && data.billing.pendingOrders === 0;
  const pending = data?.pendingApprovals ?? [];
  const releases = data?.recentReleases ?? [];
  const briefings = data?.briefingsToFill ?? [];
  const upcoming = data?.upcoming ?? [];
  const activity = data?.recentActivity ?? [];
  const side = [
    briefings.length > 0 && (
      <Panel
        key="briefings"
        index={3}
        eyebrow="Precisamos de você"
        title="Briefings para preencher"
        actions={
          <Link to="/painel/briefings" className="ov-more">
            Ver todos <ArrowRight size={14} strokeWidth={1.4} aria-hidden="true" />
          </Link>
        }
      >
        <Briefings items={briefings} />
      </Panel>
    ),
    upcoming.length > 0 && (
      <Panel
        key="upcoming"
        index={4}
        eyebrow="Calendário"
        title="Próximos conteúdos"
        actions={
          <Link to="/painel/conteudo" className="ov-more">
            Ver calendário <ArrowRight size={14} strokeWidth={1.4} aria-hidden="true" />
          </Link>
        }
      >
        <Upcoming items={upcoming} />
      </Panel>
    ),
    activity.length > 0 && (
      <Panel
        key="activity"
        index={5}
        eyebrow="Registro"
        title="Últimas movimentações"
        actions={
          <Link to="/painel/historico" className="ov-more">
            Ver histórico <ArrowRight size={14} strokeWidth={1.4} aria-hidden="true" />
          </Link>
        }
      >
        <ActivityFeed items={activity.slice(0, 6)} showClient={false} showWhere={brands.length > 1} />
      </Panel>
    ),
  ].filter(Boolean);

  return (
    <div className="ov-page ov-page--client">
      <header className="ui-pagehead ov-hello">
        <p className="ui-eyebrow">{brand ? `Marca ${brand.name}` : (user?.client?.name ?? "Área do cliente")}</p>
        <h1 className="ui-pagehead__title">
          {greeting()}, <em>{firstName(user?.name) || "olá"}</em>
        </h1>
        <p className="ui-pagehead__desc">{intro(data)}</p>
      </header>

      {data?.contracts?.awaitingSignature > 0 && <ContractNotice count={data.contracts.awaitingSignature} />}
      {data?.billing?.pendingOrders > 0 && <BillingNotice billing={data.billing} />}

      {loading && (
        <div className="ov-loading">
          <SkeletonCards count={4} aspect={4 / 3} minWidth={200} label="Carregando sua visão geral" />
          <SkeletonRows rows={3} columns={2} />
        </div>
      )}
      {error && !data && <ErrorState error={error} onRetry={() => reload().catch(() => {})} />}

      {data && (
        <div className={cx("ov-client", refreshing && "is-refreshing")}>
          {firstUse && <FirstSteps />}

          {pending.length > 0 && (
            <section className="ov-block ov-block--accent ui-enter" aria-labelledby="ov-approve-title" style={{ "--i": 1 }}>
              <div className="ov-block__head">
                <div>
                  <p className="ui-eyebrow">Sua vez</p>
                  <h2 className="ov-block__title" id="ov-approve-title">
                    Aguardando sua <em>aprovação</em>
                  </h2>
                </div>
                <Link to="/painel/conteudo" className="ov-more">
                  {data.totals.pendingApprovals > pending.length ? `Ver todos (${data.totals.pendingApprovals})` : "Ir para Conteúdo"}
                  <ArrowRight size={14} strokeWidth={1.4} aria-hidden="true" />
                </Link>
              </div>
              <ul className="ov-mgrid">
                {pending.map((material, index) => (
                  <MaterialCard key={material.id} material={material} index={index} cta="Revisar" />
                ))}
              </ul>
            </section>
          )}

          {!firstUse && pending.length === 0 && data.totals.released > 0 && (
            <p className="ov-allclear ov-allclear--block ui-enter">
              <BadgeCheck size={18} strokeWidth={1.4} aria-hidden="true" />
              Nada aguardando sua aprovação agora.
              {data.totals.changesRequested > 0 &&
                ` A equipe está trabalhando em ${plural(data.totals.changesRequested, "ajuste pedido por você", "ajustes pedidos por você")}.`}
            </p>
          )}

          {(releases.length > 0 || side.length > 0) && (
            <div className={cx("ov-columns", releases.length === 0 && "ov-columns--flow")}>
              {releases.length > 0 && (
                <div className="ov-col">
                  <Panel
                    index={2}
                    eyebrow="Recentes"
                    title="Novidades liberadas"
                    actions={
                      <Link to="/painel/arquivos" className="ov-more">
                        Ver arquivos <ArrowRight size={14} strokeWidth={1.4} aria-hidden="true" />
                      </Link>
                    }
                  >
                    <ul className="ov-mgrid ov-mgrid--compact">
                      {releases.map((material, index) => (
                        <MaterialCard key={material.id} material={material} index={index} />
                      ))}
                    </ul>
                  </Panel>
                </div>
              )}
              {releases.length > 0 ? <div className="ov-col">{side}</div> : side}
            </div>
          )}

          {!firstUse && releases.length === 0 && side.length === 0 && pending.length === 0 && (
            <EmptyState
              icon={ClipboardList}
              title="Nada novo por enquanto."
              description="Quando a Metta liberar materiais ou enviar um briefing, eles aparecem aqui."
            />
          )}

          <section className="ov-section" aria-label="Atalhos">
            <Shortcuts />
          </section>
        </div>
      )}
    </div>
  );
}
