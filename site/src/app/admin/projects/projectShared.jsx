// Project pieces reused by the projects pages and the client detail.
import { useMemo, useState } from "react";
import { Layers } from "lucide-react";
import {
  Badge,
  Card,
  Checkbox,
  ProgressBar,
  SearchInput,
  Select,
  StatusBadge,
  formatNumber,
  roleLabel,
  statusLabel,
  statusOptions,
} from "../../ui/index.js";
import { BrandMark, DueLabel, MemberStack, PersonCell, cx } from "../clients/crmShared.jsx";
import "../clients/crm.css";

export const PROJECT_STATUS_OPTIONS = statusOptions("project");
export const OPEN_PROJECT = (status) => !["delivered", "archived"].includes(status);

export const TASK_COLUMNS = [
  { value: "todo", label: "A fazer" },
  { value: "doing", label: "Em andamento" },
  { value: "review", label: "Em revisão" },
  { value: "done", label: "Concluído" },
];

export const MEMBER_ROLE_OPTIONS = [
  { value: "lead", label: "Responsável" },
  { value: "designer", label: "Designer" },
  { value: "editor", label: "Editor" },
];
export const memberRoleLabel = (role) => statusLabel("memberRole", role);

export function TaskProgress({ counts, compact = false }) {
  const total = counts?.total ?? 0;
  if (!total) return <p className="crm-progress-empty">Nenhuma tarefa ainda</p>;
  const done = counts.done ?? 0;
  return (
    <ProgressBar
      value={done / total}
      size={compact ? "sm" : "md"}
      label={`${formatNumber(done)} de ${formatNumber(total)} ${total === 1 ? "tarefa concluída" : "tarefas concluídas"}`}
      aria-label={`Tarefas concluídas: ${done} de ${total}`}
    />
  );
}

// "12 materiais · 5 liberados · 2 aguardando aprovação"
export function MaterialLine({ counts }) {
  if (!counts?.total) return <span className="crm-matline is-empty">Sem materiais ainda</span>;
  const parts = [`${formatNumber(counts.total)} ${counts.total === 1 ? "material" : "materiais"}`];
  if (counts.released) parts.push(`${formatNumber(counts.released)} ${counts.released === 1 ? "liberado" : "liberados"}`);
  const attention = [];
  if (counts.pending) attention.push(`${formatNumber(counts.pending)} aguardando aprovação`);
  if (counts.changesRequested) attention.push(`${formatNumber(counts.changesRequested)} com ajustes`);
  return (
    <span className="crm-matline">
      <span className="crm-matline__main">
        <Layers size={14} strokeWidth={1.4} aria-hidden="true" />
        <span>{parts.join(" · ")}</span>
      </span>
      {attention.length > 0 && <span className="crm-matline__attention">{attention.join(" · ")}</span>}
    </span>
  );
}

export function ProjectCard({ project, index, showClient = true }) {
  const open = OPEN_PROJECT(project.status);
  return (
    <Card to={`/admin/projetos/${project.id}`} index={index} padding="none" className={cx("crm-project", !open && "is-closed")}>
      <div className="crm-project__body">
        <div className="crm-project__top">
          <span className="crm-project__brand">
            <BrandMark name={project.brand.name} size={30} />
            <span className="crm-project__brandtext">
              <span className="crm-project__brandname">{project.brand.name}</span>
              {showClient && <span className="crm-project__client">{project.client.name}</span>}
            </span>
          </span>
          <StatusBadge kind="project" value={project.status} size="sm" />
        </div>
        <h3 className="crm-project__title">{project.name}</h3>
        {project.description && <p className="crm-project__desc">{project.description}</p>}
        <div className="crm-project__meta">
          {project.dueDate ? (
            <DueLabel date={project.dueDate} done={!open} />
          ) : (
            <span className="crm-due is-none">Sem prazo definido</span>
          )}
          {project.service && <span className="crm-project__service">{project.service.name}</span>}
        </div>
        <TaskProgress counts={project.taskCounts} compact />
        <MaterialLine counts={project.materialCounts} />
      </div>
      <div className="crm-project__foot">
        <MemberStack members={project.members} />
        {project.isMember && (
          <Badge tone="olive" size="sm">
            Você participa
          </Badge>
        )}
      </div>
    </Card>
  );
}

/**
 * Pick the project team. staff: [{id, name, role, jobTitle, eligible, reason}]
 * value: [{userId, role}] · onChange(next)
 */
export function MemberPicker({ staff = [], value = [], onChange, error }) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Map(value.map((member) => [member.userId, member.role])), [value]);
  const visible = staff.filter((person) => {
    if (!query) return true;
    const text = `${person.name} ${person.jobTitle ?? ""} ${roleLabel(person.role)}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });
  const toggle = (person, on) => {
    if (on) onChange([...value, { userId: person.id, role: person.role === "designer" ? "designer" : "lead" }]);
    else onChange(value.filter((member) => member.userId !== person.id));
  };
  const setRole = (userId, role) => onChange(value.map((member) => (member.userId === userId ? { ...member, role } : member)));

  if (!staff.length)
    return <p className="crm-form__note">Ninguém da equipe pode ser adicionado ainda. Convide pessoas em Equipe e permissões.</p>;

  return (
    <div className={cx("crm-picker", error && "is-invalid")}>
      {staff.length > 7 && (
        <SearchInput value={query} onChange={setQuery} delay={0} size="sm" placeholder="Filtrar pessoas" label="Filtrar pessoas da equipe" />
      )}
      <ul className="crm-picker__list">
        {visible.map((person) => {
          const on = selected.has(person.id);
          const blocked = !person.eligible && !on;
          return (
            <li key={person.id} className={cx("crm-picker__row", on && "is-on", blocked && "is-blocked")}>
              <Checkbox
                checked={on}
                disabled={blocked}
                onCheckedChange={(checked) => toggle(person, checked)}
                label={
                  <PersonCell
                    name={person.name}
                    detail={[roleLabel(person.role), person.jobTitle].filter(Boolean).join(" · ")}
                    size={30}
                  />
                }
                description={blocked ? person.reason : person.status === "invited" ? "Convite pendente — recebe o aviso ao ativar o acesso." : undefined}
              />
              {on && (
                <Select
                  size="sm"
                  aria-label={`Função de ${person.name} no projeto`}
                  options={MEMBER_ROLE_OPTIONS}
                  value={selected.get(person.id)}
                  onValueChange={(role) => setRole(person.id, role)}
                  className="crm-picker__role"
                />
              )}
            </li>
          );
        })}
        {!visible.length && <li className="crm-form__note">Ninguém encontrado com “{query}”.</li>}
      </ul>
      {error && (
        <p className="ui-field__error" role="alert">
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
