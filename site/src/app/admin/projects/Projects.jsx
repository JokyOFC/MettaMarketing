import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckSquare, FolderKanban, LayoutGrid, List, Plus } from "lucide-react";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Button,
  DataTable,
  ErrorState,
  EmptyState,
  FilterBar,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  SkeletonCards,
  StatusBadge,
  Switch,
  useApi,
  useIsNarrow,
} from "../../ui/index.js";
import { BrandMark, DueLabel, MemberStack } from "../clients/crmShared.jsx";
import ProjectFormDrawer from "./ProjectFormDrawer.jsx";
import { MaterialLine, OPEN_PROJECT, PROJECT_STATUS_OPTIONS, ProjectCard, TaskProgress } from "./projectShared.jsx";
import "../clients/crm.css";

// "abertos": every project not delivered nor archived (the Clientes page links here).
const OPEN_STATUSES = PROJECT_STATUS_OPTIONS.map((option) => option.value).filter(OPEN_PROJECT).join(",");
const STATUS_FILTERS = [{ value: "abertos", label: "Em aberto (não entregues)" }, ...PROJECT_STATUS_OPTIONS];

const VIEW_OPTIONS = [
  { value: "cards", label: "Cards", icon: LayoutGrid },
  { value: "lista", label: "Lista", icon: List },
];
const TASK_LABEL = { todo: "A fazer", doing: "Em andamento", review: "Em revisão", done: "Concluída" };

function MyTasks() {
  const { data } = useApi("/me/tasks");
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <section className="crm-mytasks" aria-labelledby="crm-mytasks-title">
      <div className="crm-mytasks__head">
        <h2 id="crm-mytasks-title" className="crm-mytasks__title">
          <CheckSquare size={17} strokeWidth={1.4} aria-hidden="true" /> Suas tarefas abertas
        </h2>
        <span className="ui-meta">{items.length === 1 ? "1 tarefa" : `${items.length} tarefas`}</span>
      </div>
      <ul className="crm-mytasks__list">
        {items.slice(0, 12).map((task, index) => (
          <li key={task.id} className="ui-enter" style={{ "--i": index }}>
            <Link to={`/admin/projetos/${task.project.id}?tarefa=${task.id}`} className="crm-mytask">
              <span className="crm-mytask__status" data-status={task.status}>
                {TASK_LABEL[task.status]}
              </span>
              <span className="crm-mytask__title">{task.title}</span>
              <span className="crm-mytask__meta">
                {task.brand.name} · {task.project.name}
              </span>
              {task.dueDate && <DueLabel date={task.dueDate} compact />}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Projects() {
  usePageTitle("Projetos e tarefas");
  const navigate = useNavigate();
  const narrow = useIsNarrow();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const clientId = params.get("clientId") ?? "";
  const brandId = params.get("brandId") ?? "";
  const status = params.get("status") ?? "";
  const mine = params.get("mine") === "1";
  const q = params.get("q") ?? "";
  const view = params.get("view") === "lista" ? "lista" : "cards";
  const [creating, setCreating] = useState(params.get("novo") === "1");

  const { data, error, loading, refreshing, reload } = useApi("/projects", {
    params: { clientId, brandId, status: status === "abertos" ? OPEN_STATUSES : status, mine: mine ? 1 : undefined, q },
  });
  const clients = useApi(can("clients.view") ? "/clients" : null);
  const brands = useApi("/brands", { params: { clientId: clientId || undefined, status: "active" } });
  const items = data?.items ?? [];
  const canCreate = Boolean(data?.permissions?.canCreate ?? can("projects.manage"));

  const setParam = (updates) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  const activeFilters = [clientId, brandId, status, mine].filter(Boolean).length;
  const onlyMine = mine && activeFilters === 1 && !q;

  const columns = [
    {
      key: "name",
      header: "Projeto",
      primary: true,
      sortable: true,
      sortValue: (p) => p.name,
      render: (p) => (
        <span className="crm-namecell">
          <BrandMark name={p.brand.name} size={32} />
          <span className="crm-namecell__text">
            <span className="crm-namecell__title">{p.name}</span>
            <span className="crm-namecell__meta">
              {p.brand.name} · {p.client.name}
            </span>
          </span>
        </span>
      ),
    },
    { key: "status", header: "Status", nowrap: true, render: (p) => <StatusBadge kind="project" value={p.status} size="sm" /> },
    {
      key: "dueDate",
      header: "Prazo",
      nowrap: true,
      sortable: true,
      sortValue: (p) => p.dueDate ?? "9999",
      render: (p) => (p.dueDate ? <DueLabel date={p.dueDate} done={!OPEN_PROJECT(p.status)} compact /> : <span className="ui-muted">—</span>),
    },
    { key: "tasks", header: "Tarefas", render: (p) => <div className="crm-cellprogress"><TaskProgress counts={p.taskCounts} compact /></div> },
    { key: "materials", header: "Materiais", hideOnMobile: true, render: (p) => <MaterialLine counts={p.materialCounts} /> },
    { key: "members", header: "Equipe", render: (p) => <MemberStack members={p.members} size={24} /> },
  ];

  const clientOptions = (clients.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }));
  const brandOptions = (brands.data?.items ?? []).map((b) => ({ value: b.id, label: clientId ? b.name : `${b.name} · ${b.client?.name ?? ""}` }));

  let body;
  if (loading) body = <SkeletonCards count={6} aspect={2.4} lines={3} minWidth={300} label="Carregando projetos" />;
  else if (error && !data) body = <ErrorState error={error} onRetry={reload} />;
  else if (!items.length)
    body = (
      <EmptyState
        icon={FolderKanban}
        title={onlyMine ? "Você ainda não está em nenhum projeto" : activeFilters || q ? "Nenhum projeto com estes filtros" : "Nenhum projeto aberto ainda"}
        description={
          onlyMine
            ? "Quando a gestão colocar você em um projeto, ele aparece aqui. Desligue “Meus projetos” para ver todos."
            : activeFilters || q
            ? "Ajuste a busca ou limpe os filtros para ver todos os projetos."
            : canCreate
              ? "Abra um projeto para uma marca, escolha o serviço e atribua a equipe. Cada pessoa recebe o aviso do projeto atribuído."
              : "Quando a gestão colocar você em um projeto, ele aparece aqui com as tarefas e os materiais."
        }
        action={
          activeFilters || q ? (
            <Button size="sm" onClick={() => setParam({ clientId: "", brandId: "", status: "", mine: "", q: "" })}>
              Limpar filtros
            </Button>
          ) : (
            canCreate && (
              <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
                Novo projeto
              </Button>
            )
          )
        }
      />
    );
  else if (view === "lista" && !narrow)
    body = (
      <DataTable
        caption="Projetos"
        columns={columns}
        rows={items}
        rowLabel={(p) => p.name}
        onRowClick={(p) => navigate(`/admin/projetos/${p.id}`)}
        rowClassName={(p) => (OPEN_PROJECT(p.status) ? undefined : "crm-row--muted")}
      />
    );
  else
    body = (
      <div className="crm-project-grid" aria-busy={refreshing || undefined}>
        {items.map((project, index) => (
          <ProjectCard key={project.id} project={project} index={index} />
        ))}
      </div>
    );

  return (
    <div className="crm-page">
      <PageHeader
        eyebrow="Produção"
        title="Projetos e"
        accent="tarefas"
        description="Cada projeto liga uma marca ao serviço contratado, à equipe atribuída, às tarefas e aos materiais entregues."
        actions={
          canCreate && (
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              Novo projeto
            </Button>
          )
        }
      />

      <MyTasks />

      <FilterBar
        search={
          <SearchInput value={q} onChange={(value) => setParam({ q: value.trim() })} placeholder="Buscar projeto, marca ou cliente" label="Buscar projetos" shortcut={narrow ? undefined : "/"} />
        }
        activeCount={activeFilters}
        onClear={() => setParam({ clientId: "", brandId: "", status: "", mine: "" })}
        summary={data ? `${items.length} ${items.length === 1 ? "projeto" : "projetos"}${refreshing ? " · atualizando…" : ""}` : null}
        actions={!narrow && <Segmented aria-label="Visualização" options={VIEW_OPTIONS} value={view} onChange={(v) => setParam({ view: v === "lista" ? "lista" : "" })} iconOnly size="sm" />}
      >
        {clientOptions.length > 1 && (
          <Select
            aria-label="Cliente"
            size="sm"
            placeholder="Todos os clientes"
            options={clientOptions}
            value={clientId}
            onValueChange={(value) => setParam({ clientId: value, brandId: "" })}
          />
        )}
        <Select aria-label="Marca" size="sm" placeholder="Todas as marcas" options={brandOptions} value={brandId} onValueChange={(value) => setParam({ brandId: value })} />
        <Select
          aria-label="Status"
          size="sm"
          placeholder="Em aberto e entregues"
          options={STATUS_FILTERS}
          value={status}
          onValueChange={(value) => setParam({ status: value })}
        />
        <Switch label="Meus projetos" checked={mine} onCheckedChange={(on) => setParam({ mine: on ? "1" : "" })} className="crm-filter-switch" />
      </FilterBar>

      {body}

      {canCreate && (
        <ProjectFormDrawer
          open={creating}
          onClose={() => {
            setCreating(false);
            if (params.get("novo")) setParam({ novo: "" });
          }}
          defaults={{ brandId: brandId || undefined, clientId: clientId || undefined }}
          onSaved={(project) => navigate(`/admin/projetos/${project.id}`)}
        />
      )}
    </div>
  );
}
