import { ArrowRight, CalendarClock, ClipboardList } from "lucide-react";
import { useBrand, usePageTitle } from "../../shell/index.js";
import {
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  ProgressBar,
  SkeletonCards,
  StatusBadge,
  formatDate,
  useApi,
} from "../../ui/index.js";
import { dueInfo } from "./questions.jsx";
import "../../admin/briefings/hub.css";

const cx = (...parts) => parts.filter(Boolean).join(" ");
const OPEN = new Set(["awaiting_client", "in_progress"]);

export default function ClientBriefings() {
  usePageTitle("Briefings");
  const { brands } = useBrand();
  const { data, error, loading, reload } = useApi("/briefings", { params: { pageSize: 100 } });
  const items = data?.items ?? [];
  const open = items.filter((item) => OPEN.has(item.status));
  const done = items.filter((item) => !OPEN.has(item.status));
  const multiBrand = brands.length > 1;

  return (
    <div className="hub-page">
      <PageHeader
        eyebrow="Acompanhamento"
        title="Briefings"
        description="Perguntas da equipe Metta para entender sua marca e planejar cada entrega. As respostas ficam salvas enquanto você preenche."
      />

      {loading && <SkeletonCards count={3} aspect={3.2} minWidth={300} label="Carregando briefings" />}
      {error && !data && <ErrorState error={error} onRetry={reload} />}

      {data && items.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title="Nenhum briefing por enquanto"
          description="Quando a equipe Metta precisar de informações para um projeto, o briefing aparece aqui e você recebe um aviso nas notificações."
        />
      )}

      {open.length > 0 && (
        <section className="hub-section" aria-labelledby="hub-open-title">
          <h2 id="hub-open-title" className="hub-section__title">
            Aguardando <em>você</em>
            <span className="hub-section__count">{open.length}</span>
          </h2>
          <div className="hub-bcards">
            {open.map((item, index) => (
              <OpenCard key={item.id} item={item} index={index} showBrand={multiBrand} />
            ))}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section className="hub-section" aria-labelledby="hub-done-title">
          <h2 id="hub-done-title" className="hub-section__title">
            Respondidos
            <span className="hub-section__count">{done.length}</span>
          </h2>
          <ul className="hub-donelist">
            {done.map((item, index) => (
              <li key={item.id}>
                <Card to={`/painel/briefings/${item.id}`} padding="sm" index={open.length + index} className="hub-donecard">
                  <div className="hub-donecard__main">
                    <strong className="hub-donecard__title">{item.title}</strong>
                    <span className="ui-meta">
                      {[multiBrand && item.brand?.name, item.submittedAt && `Enviado em ${formatDate(item.submittedAt)}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  <StatusBadge kind="briefing" value={item.status} size="sm" />
                  <span className="hub-donecard__go">
                    Ver respostas
                    <ArrowRight size={16} strokeWidth={1.4} aria-hidden="true" />
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function OpenCard({ item, index, showBrand }) {
  const due = dueInfo(item.dueDate);
  const { required, requiredAnswered, answered, total } = item.progress;
  const ratio = required ? requiredAnswered / required : total ? answered / total : 0;
  const started = answered > 0;
  return (
    <Card to={`/painel/briefings/${item.id}`} index={index} className="hub-bcard">
      <p className="ui-eyebrow">{[showBrand && item.brand?.name, item.project?.name].filter(Boolean).join(" · ") || "Briefing"}</p>
      <h3 className="hub-bcard__title">{item.title}</h3>
      {due && (
        <p className={cx("hub-due", due.tone && `is-${due.tone}`)}>
          <CalendarClock size={15} strokeWidth={1.4} aria-hidden="true" />
          Prazo {due.text}
        </p>
      )}
      <ProgressBar
        value={ratio}
        size="sm"
        label={
          required
            ? `${requiredAnswered} de ${required} obrigatórias respondidas`
            : `${answered} de ${total} perguntas respondidas`
        }
      />
      <div className="hub-bcard__foot">
        <span className="hub-bcard__cta">
          {started ? "Continuar" : "Começar"}
          <ArrowRight size={16} strokeWidth={1.4} aria-hidden="true" />
        </span>
        <StatusBadge kind="briefing" value={item.status} size="sm" />
      </div>
    </Card>
  );
}
