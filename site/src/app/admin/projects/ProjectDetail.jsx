import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowUpRight, CloudUpload, History, Package, Pencil, Plus, Users } from "lucide-react";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  Menu,
  PageHeader,
  Panel,
  ProgressBar,
  Skeleton,
  SkeletonCards,
  StatusBadge,
  Thumb,
  formatDate,
  formatNumber,
  formatRelative,
  roleLabel,
  statusLabel,
  useApi,
  useMediaQuery,
  useToast,
} from "../../ui/index.js";
import { DueLabel, PersonCell, cx, noticeChannels, useSticky } from "../clients/crmShared.jsx";
import ProjectFormDrawer from "./ProjectFormDrawer.jsx";
import TaskBoard, { moveTask } from "./TaskBoard.jsx";
import TaskDrawer from "./TaskDrawer.jsx";
import { MemberPicker, OPEN_PROJECT, PROJECT_STATUS_OPTIONS, memberRoleLabel } from "./projectShared.jsx";
import "../clients/crm.css";

const STATUS_HINTS = {
  planning: "Escopo e briefing em definição",
  in_progress: "Equipe produzindo",
  in_review: "Em revisão interna ou com o cliente",
  delivered: "Entregas finais disponibilizadas",
  paused: "Trabalho em pausa",
  archived: "Sai das listas; histórico preservado",
};

const countTasks = (tasks) => {
  const counts = { todo: 0, doing: 0, review: 0, done: 0, total: tasks.length };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
};

const materialPath = (material) => (material.kind === "post" ? `/admin/conteudo/${material.id}` : `/admin/biblioteca/${material.id}`);

function MembersDrawer({ open, onClose, project, onSaved }) {
  const toast = useToast();
  const options = useApi(open ? "/projects/options" : null, { params: { brandId: project.brand.id } });
  const [members, setMembers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (open) {
      setMembers(project.members.map((m) => ({ userId: m.id, role: m.memberRole })));
      setError(null);
    }
  }, [open, project.members]);

  // current members stay listed even if they are no longer eligible
  const staff = useMemo(() => {
    const list = options.data?.staff ?? [];
    const extra = project.members
      .filter((m) => !list.some((s) => s.id === m.id))
      .map((m) => ({ id: m.id, name: m.name, role: m.role, jobTitle: m.jobTitle, status: m.status, eligible: false, reason: "Sem acesso a este cliente" }));
    return [...list, ...extra];
  }, [options.data, project.members]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.put(`/projects/${project.id}/members`, { members });
      const notified = res.notified ?? 0;
      toast.success(
        notified
          ? `Equipe atualizada. ${notified === 1 ? "A nova pessoa foi avisada" : `${notified} novas pessoas foram avisadas`} ${noticeChannels(res)}`
          : "Equipe atualizada.",
      );
      onSaved(res.project);
      onClose();
    } catch (err) {
      setError(err.fields?.members || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      size="sm"
      eyebrow={project.name}
      title="Equipe do projeto"
      description="Quem entra recebe o aviso “Novo projeto atribuído” na plataforma e, com o envio configurado, por e-mail. Designers só veem os projetos em que estão."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Salvar equipe
          </Button>
        </>
      }
    >
      {options.loading ? (
        <SkeletonCards count={3} aspect={6} lines={0} minWidth={240} label="Carregando equipe" />
      ) : options.error ? (
        <ErrorState error={options.error} onRetry={options.reload} compact />
      ) : (
        <MemberPicker staff={staff} value={members} onChange={setMembers} error={error} />
      )}
    </Drawer>
  );
}

function StatusControl({ project, canEdit, onChange }) {
  if (!canEdit) return <StatusBadge kind="project" value={project.status} />;
  return (
    <Menu
      label="Alterar status do projeto"
      minWidth={260}
      trigger={
        <button type="button" className="crm-statusctl" aria-label={`Status: ${statusLabel("project", project.status)}. Alterar`}>
          <StatusBadge kind="project" value={project.status} />
          <span className="crm-statusctl__hint">Alterar</span>
        </button>
      }
      items={PROJECT_STATUS_OPTIONS.map((option) => ({
        label: option.label,
        description: STATUS_HINTS[option.value],
        icon: option.value === project.status ? "check" : undefined,
        disabled: option.value === project.status,
        onSelect: () => onChange(option.value),
      }))}
    />
  );
}

function MaterialsGrid({ materials, project, permissions }) {
  const items = materials.items;
  const uploadTo = `/admin/biblioteca/enviar?projectId=${project.id}&brandId=${project.brand.id}`;
  return (
    <Panel
      title="Materiais do projeto"
      description={items.length ? `${formatNumber(materials.total)} ${materials.total === 1 ? "material" : "materiais"} · rascunhos ficam privados até a liberação.` : undefined}
      actions={
        <div className="ui-cluster">
          {permissions.canViewLibrary && items.length > 0 && (
            <Button size="sm" variant="ghost" iconRight={ArrowUpRight} to={`/admin/biblioteca?projectId=${project.id}`}>
              Na biblioteca
            </Button>
          )}
          {permissions.canUpload && (
            <Button size="sm" icon={CloudUpload} to={uploadTo}>
              Enviar arquivos
            </Button>
          )}
        </div>
      }
    >
      {items.length ? (
        <ul className="crm-thumbs">
          {items.map((material, index) => (
            <li key={material.id} className="ui-enter" style={{ "--i": index }}>
              <Link to={materialPath(material)} className="crm-thumb">
                <Thumb
                  thumb={material.thumb}
                  aspect={1}
                  bg={material.previewBg && material.previewBg !== "auto" ? material.previewBg : "auto"}
                  mediaKind={material.thumb?.mediaKind}
                  format={material.formats?.[0]}
                  name={material.title}
                  alt=""
                />
                <span className="crm-thumb__title">{material.title}</span>
                <span className="crm-thumb__meta">
                  {material.category?.name}
                  {material.version && ` · v${material.version.number}`}
                </span>
                <span className="crm-thumb__badges">
                  <StatusBadge kind="visibility" value={material.visibility} size="sm" />
                  {material.visibility === "released" && material.approvalStatus !== "none" && (
                    <StatusBadge kind="approval" value={material.approvalStatus} size="sm" />
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          compact
          icon={CloudUpload}
          title="Nenhum material neste projeto ainda"
          description="Envie os arquivos como rascunho: eles ficam privados para a equipe até a gestão liberar ao cliente."
          action={
            permissions.canUpload && (
              <Button size="sm" variant="primary" icon={CloudUpload} to={uploadTo}>
                Enviar arquivos
              </Button>
            )
          }
        />
      )}
    </Panel>
  );
}

function DetailSkeleton() {
  return (
    <div className="crm-page" aria-busy="true">
      <div className="crm-skelhead">
        <Skeleton width={160} height={12} />
        <Skeleton width="48%" height={34} />
        <Skeleton width="30%" height={14} />
      </div>
      <SkeletonCards count={4} aspect={0.9} lines={1} minWidth={220} label="Carregando projeto" />
    </div>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const touch = useMediaQuery("(pointer: coarse)");
  const [params, setParams] = useSearchParams();
  const { data, error, loading, reload, setData } = useApi(`/projects/${id}`);
  const project = data?.project;
  usePageTitle(project?.name || "Projeto", {
    crumbs: [{ label: "Projetos e tarefas", to: "/admin/projetos" }, { label: project?.name || "Projeto" }],
  });
  const [editing, setEditing] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [taskDrawer, setTaskDrawer] = useState(null); // { task } | { status }
  const taskView = useSticky(taskDrawer);
  const moveSeq = useRef(0);
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  // ?tarefa=<id> (notifications) opens that task
  const taskParam = params.get("tarefa");
  useEffect(() => {
    if (!taskParam || !data) return;
    const task = data.tasks.find((t) => t.id === taskParam);
    if (task) setTaskDrawer({ task });
    else toast.info("Esta tarefa não existe mais.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskParam, Boolean(data)]);
  const closeTask = () => {
    setTaskDrawer(null);
    if (taskParam) {
      const next = new URLSearchParams(params);
      next.delete("tarefa");
      setParams(next, { replace: true });
    }
  };

  if (loading) return <DetailSkeleton />;
  if (error && !data)
    return (
      <div className="crm-page">
        <ErrorState
          error={error}
          title={error.status === 404 ? "Projeto não encontrado" : undefined}
          onRetry={reload}
          action={
            <Button size="sm" variant="ghost" to="/admin/projetos">
              Voltar para projetos
            </Button>
          }
        />
      </div>
    );
  if (!data) return null;
  const { tasks, kits, materials, activity, permissions } = data;
  const counts = countTasks(tasks);
  const open = OPEN_PROJECT(project.status);

  const setTasks = (next) =>
    setData((current) => ({ ...current, tasks: next, project: { ...current.project, taskCounts: countTasks(next) } }));

  // optimistic move; only the latest answer may replace the board
  const onMove = async (taskId, status, index) => {
    const previous = tasks;
    const seq = ++moveSeq.current;
    setTasks(moveTask(tasks, taskId, status, index));
    try {
      const res = await api.patch(`/tasks/${taskId}`, { status, sortOrder: index });
      if (seq === moveSeq.current) setTasks(res.tasks);
    } catch (err) {
      if (seq === moveSeq.current) setTasks(previous);
      toast.error(err);
      reload();
    }
  };

  const changeStatus = async (status) => {
    if (status === "archived") return setArchiveConfirm(true);
    await applyStatus(status).catch((err) => toast.error(err));
  };
  const applyStatus = async (status) => {
    const res = await api.patch(`/projects/${project.id}`, { status });
    setData((current) => ({ ...current, project: { ...current.project, ...res.project } }));
    toast.success(`Status do projeto: ${statusLabel("project", status)}.`);
    reload();
  };

  const released = project.materialCounts.released;
  const approved = project.materialCounts.approved;

  return (
    <div className="crm-page">
      <PageHeader
        back={{ to: "/admin/projetos", label: "Projetos e tarefas" }}
        eyebrow={
          <>
            {project.client.name} · {project.brand.name}
          </>
        }
        title={project.name}
        meta={
          <>
            <StatusControl project={project} canEdit={permissions.canEdit} onChange={changeStatus} />
            {project.dueDate ? <DueLabel date={project.dueDate} done={!open} /> : <span>Sem prazo</span>}
            {project.startDate && <span>Início {formatDate(project.startDate)}</span>}
            {project.service && <span>{project.service.name}</span>}
            {project.includesEditables && (
              <Badge tone="teal" size="sm">
                Editáveis incluídos
              </Badge>
            )}
            {project.deliveredAt && <span>Entregue em {formatDate(project.deliveredAt)}</span>}
          </>
        }
        description={project.description}
        actions={
          <>
            {permissions.canEdit && (
              <Button icon={Pencil} onClick={() => setEditing(true)}>
                Editar
              </Button>
            )}
            {permissions.canUpload && (
              <Button variant="primary" icon={CloudUpload} to={`/admin/biblioteca/enviar?projectId=${project.id}&brandId=${project.brand.id}`}>
                Enviar arquivos
              </Button>
            )}
          </>
        }
      />

      <div className="crm-projstats">
        <div className="crm-projstat ui-enter" style={{ "--i": 0 }}>
          <span className="crm-projstat__label">Tarefas</span>
          <span className="crm-projstat__value">
            {formatNumber(counts.done)}
            <small>/{formatNumber(counts.total)}</small>
          </span>
          <ProgressBar value={counts.total ? counts.done / counts.total : 0} size="sm" aria-label="Tarefas concluídas" />
        </div>
        <div className="crm-projstat ui-enter" style={{ "--i": 1 }}>
          <span className="crm-projstat__label">Materiais</span>
          <span className="crm-projstat__value">{formatNumber(project.materialCounts.total)}</span>
          <span className="crm-projstat__hint">
            {formatNumber(project.materialCounts.draft + project.materialCounts.internalReview)} em produção · {formatNumber(released)} liberados
          </span>
        </div>
        <div className="crm-projstat ui-enter" style={{ "--i": 2 }}>
          <span className="crm-projstat__label">Com o cliente</span>
          <span className="crm-projstat__value">{formatNumber(project.materialCounts.pending)}</span>
          <span className="crm-projstat__hint">
            aguardando aprovação{project.materialCounts.changesRequested ? ` · ${formatNumber(project.materialCounts.changesRequested)} com ajustes` : ""}
          </span>
        </div>
        <div className="crm-projstat ui-enter" style={{ "--i": 3 }}>
          <span className="crm-projstat__label">Aprovados</span>
          <span className="crm-projstat__value">{formatNumber(approved)}</span>
          <span className="crm-projstat__hint">{kits.length ? `${kits.length} ${kits.length === 1 ? "pacote" : "pacotes"} de entrega` : "nenhum pacote montado"}</span>
        </div>
      </div>

      <section className="crm-boardwrap" aria-labelledby="crm-board-title">
        <div className="crm-boardwrap__head">
          <h2 id="crm-board-title" className="crm-h2">
            Quadro de <em>tarefas</em>
          </h2>
          <p className="ui-meta crm-boardwrap__hint">
            {permissions.canManageTasks
              ? touch
                ? "Use “Mover” em cada tarefa para trocar de coluna ou de posição."
                : "Arraste os cartões ou use “Mover” em cada tarefa."
              : "Somente leitura."}
          </p>
          {permissions.canManageTasks && (
            <Button size="sm" icon={Plus} onClick={() => setTaskDrawer({ status: "todo" })}>
              Nova tarefa
            </Button>
          )}
        </div>
        <TaskBoard
          tasks={tasks}
          canManage={permissions.canManageTasks}
          onOpen={(task) => setTaskDrawer({ task })}
          onCreate={(status) => setTaskDrawer({ status })}
          onMove={onMove}
        />
      </section>

      <div className="crm-detailgrid">
        <div className="crm-detailgrid__main">
          {permissions.canViewLibrary && <MaterialsGrid materials={materials} project={project} permissions={permissions} />}
        </div>
        <aside className="crm-detailgrid__aside">
          <Panel
            title="Equipe"
            index={0}
            actions={
              permissions.canManageMembers && (
                <Button size="sm" variant="ghost" icon={Users} onClick={() => setMembersOpen(true)}>
                  Gerenciar
                </Button>
              )
            }
          >
            {project.members.length ? (
              <ul className="crm-peoplelist">
                {project.members.map((member) => (
                  <li key={member.id} className="crm-peoplelist__row">
                    <PersonCell name={member.name} detail={member.jobTitle || roleLabel(member.role)} size={30} muted={member.status === "disabled"} />
                    <Badge tone={member.memberRole === "lead" ? "olive" : "slate"} size="sm">
                      {memberRoleLabel(member.memberRole)}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                compact
                icon={Users}
                title="Ninguém atribuído"
                description="Adicione a equipe: cada pessoa recebe o aviso do projeto."
                action={
                  permissions.canManageMembers && (
                    <Button size="sm" variant="primary" onClick={() => setMembersOpen(true)}>
                      Atribuir equipe
                    </Button>
                  )
                }
              />
            )}
          </Panel>

          <Panel
            title="Pacote final e kits"
            index={1}
            actions={
              permissions.canViewLibrary && (
                <Button size="sm" variant="ghost" iconRight={ArrowUpRight} to={`/admin/kits?brandId=${project.brand.id}&projectId=${project.id}`}>
                  {kits.length ? "Gerenciar" : "Montar"}
                </Button>
              )
            }
          >
            {kits.length ? (
              <ul className="crm-kits">
                {kits.map((kit) => (
                  <li key={kit.id} className="crm-kits__row">
                    <Package size={18} strokeWidth={1.4} aria-hidden="true" />
                    <span className="crm-kits__text">
                      <span className="crm-kits__name">{kit.name}</span>
                      <span className="ui-meta">
                        {statusLabel("kitKind", kit.kind)} · {kit.itemCount} {kit.itemCount === 1 ? "item" : "itens"}
                        {kit.releasedAt && ` · liberado ${formatRelative(kit.releasedAt)}`}
                      </span>
                    </span>
                    <StatusBadge kind="kit" value={kit.status} size="sm" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ui-muted crm-panel-text">
                Monte o pacote final com os arquivos aprovados. O cliente baixa tudo em um ZIP organizado quando ele for liberado.
              </p>
            )}
          </Panel>

          <Panel
            title="Atividade"
            index={2}
            actions={
              <Button size="sm" variant="ghost" icon={History} to={`/admin/historico?projectId=${project.id}`}>
                Histórico
              </Button>
            }
          >
            {activity.length ? (
              <ol className="crm-timeline">
                {activity.slice(0, 10).map((entry) => (
                  <li key={entry.id} className={cx("crm-timeline__item", entry.visibility === "client" && "is-client")}>
                    <span className="crm-timeline__dot" aria-hidden="true" />
                    <p className="crm-timeline__text">{entry.summary}</p>
                    <p className="crm-timeline__meta">
                      {entry.actor?.name ?? "Sistema"} · <time dateTime={entry.createdAt}>{formatRelative(entry.createdAt)}</time>
                      {entry.visibility === "client" && " · visível ao cliente"}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="ui-muted crm-panel-text">Nenhuma atividade registrada ainda.</p>
            )}
          </Panel>
        </aside>
      </div>

      {permissions.canEdit && (
        <ProjectFormDrawer
          open={editing}
          onClose={() => setEditing(false)}
          project={project}
          onSaved={(next) => setData((current) => ({ ...current, project: { ...current.project, ...next } }))}
        />
      )}
      {permissions.canManageMembers && (
        <MembersDrawer
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
          project={project}
          onSaved={(next) => {
            setData((current) => ({ ...current, project: { ...current.project, ...next } }));
            reload();
          }}
        />
      )}
      <TaskDrawer
        open={Boolean(taskDrawer)}
        onClose={closeTask}
        projectId={project.id}
        task={taskView?.task ?? null}
        defaultStatus={taskView?.status ?? "todo"}
        members={project.members.filter((m) => m.status !== "disabled")}
        materials={materials.items}
        canEdit={permissions.canManageTasks}
        canDelete={Boolean(taskView?.task) && (permissions.canDeleteAnyTask || taskView.task.createdBy?.id === user?.id)}
        onSaved={(next) => {
          setTasks(next);
          reload();
        }}
        onDeleted={(taskId) => {
          setTasks(tasks.filter((t) => t.id !== taskId));
          reload();
        }}
      />
      <ConfirmDialog
        open={archiveConfirm}
        onClose={() => setArchiveConfirm(false)}
        tone="danger"
        title={`Arquivar ${project.name}?`}
        description="O projeto sai das listas da equipe e do portal do cliente. Tarefas, materiais e histórico são preservados."
        confirmLabel="Arquivar projeto"
        onConfirm={() => applyStatus("archived").then(() => navigate("/admin/projetos"))}
      />
    </div>
  );
}
