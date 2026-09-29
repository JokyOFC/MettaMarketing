import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Download, FolderKanban, FolderOpen, Package } from "lucide-react";
import { useDownloads } from "../../api/downloads.js";
import { useBrand, usePageTitle } from "../../shell/index.js";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  ProgressBar,
  SkeletonCards,
  StatusBadge,
  formatDate,
  formatNumber,
  formatRelative,
  statusLabel,
  useApi,
} from "../../ui/index.js";
import { DueLabel, cx } from "../../admin/clients/crmShared.jsx";
import "../../admin/clients/crm.css";

const CLOSED = new Set(["delivered", "archived"]);

function Progress({ project }) {
  const total = project.materialCount;
  if (!total)
    return (
      <p className="crm-cproj__waiting">
        Nenhuma entrega liberada ainda. Quando a equipe liberar os primeiros materiais, você acompanha o andamento aqui.
      </p>
    );
  // Approval and delivery are different things (PLATFORM §3): the bar counts
  // what no longer waits for approval; deliveries (final files made
  // available) are listed on their own.
  const settled = project.finalizedCount;
  const approved = project.approvedCount;
  const exempt = Math.max(0, settled - approved);
  const delivered = project.deliveredCount ?? 0;
  return (
    <div className="crm-cproj__progress">
      <ProgressBar
        value={settled / total}
        label={`${formatNumber(settled)} de ${formatNumber(total)} sem aprovação pendente`}
        showValue
      />
      <ul className="crm-cproj__facts">
        <li>
          <strong>{formatNumber(total)}</strong> {total === 1 ? "material liberado" : "materiais liberados"}
        </li>
        {approved > 0 && (
          <li>
            <strong>{formatNumber(approved)}</strong> {approved === 1 ? "aprovado" : "aprovados"}
          </li>
        )}
        {exempt > 0 && (
          <li>
            <strong>{formatNumber(exempt)}</strong> sem necessidade de aprovação
          </li>
        )}
        {delivered > 0 && (
          <li>
            <strong>{formatNumber(delivered)}</strong> {delivered === 1 ? "entregue" : "entregues"} com os arquivos finais
          </li>
        )}
        {project.pendingCount > 0 && (
          <li className="is-attention">
            <Link to="/painel/conteudo">
              <strong>{formatNumber(project.pendingCount)}</strong> aguardando sua aprovação
            </Link>
          </li>
        )}
        {project.changesRequestedCount > 0 && (
          <li>
            <strong>{formatNumber(project.changesRequestedCount)}</strong> com ajustes em andamento
          </li>
        )}
        {project.lastReleaseAt && <li>Última liberação {formatRelative(project.lastReleaseAt)}</li>}
      </ul>
    </div>
  );
}

function ProjectItem({ project, index }) {
  const { startZip } = useDownloads();
  const [starting, setStarting] = useState(null);
  const closed = CLOSED.has(project.status);
  const zip = async (key, scope, label) => {
    setStarting(key);
    try {
      await startZip(scope, { label });
    } finally {
      setStarting(null);
    }
  };
  return (
    <article className={cx("crm-cproj ui-enter", closed && "is-closed")} style={{ "--i": Math.min(index, 8) }} aria-labelledby={`proj-${project.id}`}>
      <div className="crm-cproj__main">
        <div className="crm-cproj__top">
          <StatusBadge kind="project" value={project.status} />
          {project.service && <span className="crm-cproj__service">{project.service.name}</span>}
        </div>
        <h2 id={`proj-${project.id}`} className="crm-cproj__title">
          {project.name}
        </h2>
        {project.description && <p className="crm-cproj__desc">{project.description}</p>}
        <dl className="crm-cproj__dates">
          {project.startDate && (
            <div>
              <dt>Início</dt>
              <dd>{formatDate(project.startDate)}</dd>
            </div>
          )}
          {project.deliveredAt ? (
            <div>
              <dt>Entregue em</dt>
              <dd>{formatDate(project.deliveredAt)}</dd>
            </div>
          ) : (
            project.dueDate && (
              <div>
                <dt>Previsão</dt>
                <dd>
                  <DueLabel date={project.dueDate} done={closed} compact />
                </dd>
              </div>
            )
          )}
          {project.includesEditables && (
            <div>
              <dt>Arquivos editáveis</dt>
              <dd>Incluídos</dd>
            </div>
          )}
        </dl>
        <Progress project={project} />
      </div>

      <div className="crm-cproj__side">
        <Button
          variant={project.hasDownloads ? "primary" : "secondary"}
          icon={Download}
          disabled={!project.hasDownloads}
          loading={starting === "project"}
          onClick={() => zip("project", { type: "project", projectId: project.id }, `Pacote final — ${project.name}`)}
          block
        >
          Baixar pacote final
        </Button>
        {!project.hasDownloads && <p className="crm-cproj__note">O download fica disponível quando houver arquivos liberados.</p>}
        <Button variant="ghost" icon={FolderOpen} iconRight={ArrowUpRight} to={`/painel/arquivos?projeto=${project.id}`} block>
          Ver arquivos do projeto
        </Button>
        {project.kits.length > 0 && (
          <div className="crm-cproj__kits">
            <p className="crm-cproj__kitstitle">Pacotes liberados</p>
            <ul>
              {project.kits.map((kit) => (
                <li key={kit.id} className="crm-cproj__kit">
                  <Package size={18} strokeWidth={1.4} aria-hidden="true" />
                  <span className="crm-cproj__kittext">
                    <span className="crm-cproj__kitname">{kit.name}</span>
                    <span className="ui-meta">
                      {statusLabel("kitKind", kit.kind)} · {kit.itemCount} {kit.itemCount === 1 ? "item" : "itens"}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    icon={Download}
                    loading={starting === kit.id}
                    onClick={() => zip(kit.id, { type: "kit", kitId: kit.id }, kit.name)}
                    aria-label={`Baixar ${kit.name}`}
                  >
                    Baixar
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}

export default function ClientProjects() {
  usePageTitle("Projetos");
  const { brand, brandId, brands } = useBrand();
  const { data, error, loading, reload } = useApi(brandId ? "/portal/projects" : null, { params: { brandId } });
  const items = data?.items ?? [];
  const current = items.filter((p) => !CLOSED.has(p.status));
  const done = items.filter((p) => CLOSED.has(p.status));

  let body;
  if (!brands.length)
    body = (
      <EmptyState
        icon={FolderKanban}
        title="Nenhuma marca ativa no seu acesso"
        description="Fale com a equipe Metta para liberar a marca da sua empresa."
      />
    );
  else if (loading) body = <SkeletonCards count={2} aspect={3.2} lines={3} minWidth={520} label="Carregando projetos" />;
  else if (error && !data) body = <ErrorState error={error} onRetry={reload} />;
  else if (!items.length)
    body = (
      <EmptyState
        icon={FolderKanban}
        title="Nenhum projeto por aqui ainda"
        description={`Quando a equipe Metta iniciar um projeto para ${brand?.name ?? "sua marca"}, ele aparece aqui com prazos, entregas e o pacote final.`}
      />
    );
  else
    body = (
      <>
        {current.length > 0 && (
          <section className="crm-cprojects" aria-labelledby="crm-cp-current">
            <h2 id="crm-cp-current" className="crm-cprojects__title">
              Em andamento <span>{current.length}</span>
            </h2>
            {current.map((project, index) => (
              <ProjectItem key={project.id} project={project} index={index} />
            ))}
          </section>
        )}
        {done.length > 0 && (
          <section className="crm-cprojects" aria-labelledby="crm-cp-done">
            <h2 id="crm-cp-done" className="crm-cprojects__title">
              Concluídos <span>{done.length}</span>
            </h2>
            {done.map((project, index) => (
              <ProjectItem key={project.id} project={project} index={current.length + index} />
            ))}
          </section>
        )}
      </>
    );

  return (
    <div className="crm-page crm-page--client">
      <PageHeader
        eyebrow={brand ? brand.name : "Projetos"}
        title="Seus"
        accent="projetos"
        description="Acompanhe o andamento e baixe as entregas liberadas pela equipe Metta. Downloads não contam como aprovação."
      />
      {body}
    </div>
  );
}
