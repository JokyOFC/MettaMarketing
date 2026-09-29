import { useEffect, useId, useState } from "react";
import { ArrowUpRight, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../api/client.js";
import {
  Button,
  ConfirmDialog,
  DateInput,
  Drawer,
  Field,
  Input,
  Select,
  Textarea,
  formatDateTime,
  roleLabel,
  useToast,
} from "../../ui/index.js";
import { clean, useForm } from "../clients/crmShared.jsx";
import { TASK_COLUMNS, memberRoleLabel } from "./projectShared.jsx";
import "../clients/crm.css";

const EMPTY = { title: "", description: "", assigneeId: "", dueDate: "", status: "todo", materialId: "" };

const fromTask = (task) => ({
  title: task.title,
  description: task.description ?? "",
  assigneeId: task.assignee?.id ?? "",
  dueDate: task.dueDate ?? "",
  status: task.status,
  materialId: task.material?.id ?? "",
});

const materialPath = (material) => (material.kind === "post" ? `/admin/conteudo/${material.id}` : `/admin/biblioteca/${material.id}`);

/**
 * Create or edit a task. members: project members (possible assignees);
 * materials: the project's materials (optional link). onSaved(tasks) gets the
 * refreshed task list from the server.
 */
export default function TaskDrawer({ open, onClose, projectId, task = null, defaultStatus = "todo", members = [], materials = [], canEdit, canDelete, onSaved, onDeleted }) {
  const editing = Boolean(task);
  const toast = useToast();
  const formId = useId();
  const form = useForm(EMPTY);
  const { values, bind, fieldError } = form;
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.reset(task ? fromTask(task) : { ...EMPTY, status: defaultStatus });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  const submit = async (event) => {
    event.preventDefault();
    if (!canEdit) return onClose();
    if (!values.title.trim()) return form.setErrors({ title: "Dê um título à tarefa." });
    const body = {
      title: values.title.trim(),
      description: clean(values.description),
      assigneeId: values.assigneeId || null,
      dueDate: values.dueDate || null,
      materialId: values.materialId || null,
    };
    setSaving(true);
    try {
      let res;
      if (editing) {
        if (values.status !== task.status) body.status = values.status;
        res = await api.patch(`/tasks/${task.id}`, body);
        toast.success("Tarefa salva.");
      } else {
        res = await api.post(`/projects/${projectId}/tasks`, { ...body, status: values.status });
        const assignee = members.find((m) => m.id === body.assigneeId);
        toast.success(assignee ? `Tarefa criada. ${assignee.name} foi avisado(a).` : "Tarefa criada.");
      }
      onSaved?.(res.tasks, res.task);
      onClose?.();
    } catch (error) {
      if (!form.fail(error)) toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  // assignee options: project members, plus the current assignee if they left
  const assigneeOptions = members.map((m) => ({ value: m.id, label: `${m.name} · ${memberRoleLabel(m.memberRole) || roleLabel(m.role)}` }));
  if (task?.assignee && !members.some((m) => m.id === task.assignee.id))
    assigneeOptions.push({ value: task.assignee.id, label: `${task.assignee.name} (fora da equipe)` });
  const materialOptions = materials.map((m) => ({ value: m.id, label: `${m.title} · ${m.category?.name ?? ""}` }));
  if (task?.material && !materials.some((m) => m.id === task.material.id)) materialOptions.push({ value: task.material.id, label: task.material.title });
  const linked = values.materialId ? materials.find((m) => m.id === values.materialId) ?? task?.material : null;

  return (
    <>
      <Drawer
        open={open}
        onClose={saving ? undefined : onClose}
        dismissible={!saving}
        size="sm"
        eyebrow={editing ? "Tarefa" : "Nova tarefa"}
        title={editing ? task.title : "Criar tarefa"}
        description={editing && task.createdBy ? `Criada por ${task.createdBy.name} em ${formatDateTime(task.createdAt)}` : undefined}
        footer={
          <>
            {editing && canDelete && (
              <Button variant="ghost" icon={Trash2} className="crm-foot-start crm-danger-link" onClick={() => setConfirmDelete(true)} disabled={saving}>
                Excluir
              </Button>
            )}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {canEdit ? "Cancelar" : "Fechar"}
            </Button>
            {canEdit && (
              <Button variant="primary" type="submit" form={formId} loading={saving}>
                {editing ? "Salvar tarefa" : "Criar tarefa"}
              </Button>
            )}
          </>
        }
      >
        <form ref={form.ref} id={formId} className="crm-form" onSubmit={submit} noValidate>
          <fieldset disabled={!canEdit} className="crm-form__plain">
            <Field label="Título" required error={fieldError("title")}>
              <Input {...bind("title")} data-autofocus={!editing || undefined} placeholder="Ex.: Ajustar versão monocromática" />
            </Field>
            <Field label="Descrição" optional error={fieldError("description")}>
              <Textarea {...bind("description")} rows={4} autoGrow placeholder="Contexto, referências e critério de pronto." />
            </Field>
            <div className="crm-form__row">
              <Field label="Responsável" error={fieldError("assigneeId")} hint={!members.length ? "Adicione pessoas à equipe do projeto." : undefined}>
                <Select {...bind("assigneeId")} placeholder="Sem responsável" options={assigneeOptions} />
              </Field>
              <Field label="Prazo" optional error={fieldError("dueDate")}>
                <DateInput {...bind("dueDate")} />
              </Field>
            </div>
            <Field label="Coluna" error={fieldError("status")}>
              <Select {...bind("status")} options={TASK_COLUMNS} />
            </Field>
            <Field
              label="Material relacionado"
              optional
              error={fieldError("materialId")}
              hint={!materials.length ? "Os materiais enviados para este projeto aparecem aqui." : undefined}
              labelAside={
                linked && (
                  <Link className="crm-inline-link" to={materialPath(linked)}>
                    Abrir <ArrowUpRight size={13} strokeWidth={1.4} aria-hidden="true" />
                  </Link>
                )
              }
            >
              <Select {...bind("materialId")} placeholder="Nenhum" options={materialOptions} />
            </Field>
            {editing && task.completedAt && <p className="crm-form__note">Concluída em {formatDateTime(task.completedAt)}.</p>}
          </fieldset>
        </form>
      </Drawer>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        tone="danger"
        title="Excluir esta tarefa?"
        description={`“${task?.title ?? ""}” sai do quadro. A exclusão fica registrada no histórico do projeto.`}
        confirmLabel="Excluir tarefa"
        icon={Trash2}
        onConfirm={async () => {
          await api.del(`/tasks/${task.id}`);
          toast.success("Tarefa excluída.");
          onDeleted?.(task.id);
          onClose?.();
        }}
      />
    </>
  );
}
