import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../api/client.js";
import {
  Button,
  DateInput,
  Drawer,
  Field,
  Input,
  Select,
  Switch,
  Textarea,
  useApi,
  useToast,
} from "../../ui/index.js";
import { InternalBadge, clean, noticeChannels, useForm } from "../clients/crmShared.jsx";
import { MemberPicker, PROJECT_STATUS_OPTIONS } from "./projectShared.jsx";
import "../clients/crm.css";

const EMPTY = {
  brandId: "",
  serviceId: "",
  name: "",
  description: "",
  status: "planning",
  startDate: "",
  dueDate: "",
  includesEditables: false,
  internalNotes: "",
  members: [],
};

const fromProject = (project) => ({
  ...EMPTY,
  brandId: project.brand.id,
  serviceId: project.service?.id ?? "",
  name: project.name,
  description: project.description ?? "",
  status: project.status,
  startDate: project.startDate ?? "",
  dueDate: project.dueDate ?? "",
  includesEditables: project.includesEditables,
  internalNotes: project.internalNotes ?? "",
});

/**
 * "Novo projeto" (with the team, who are notified) or project edit.
 * defaults: { brandId, clientId } to prefill from a client or brand page.
 */
export default function ProjectFormDrawer({ open, onClose, project = null, defaults = {}, onSaved }) {
  const editing = Boolean(project);
  const toast = useToast();
  const formId = useId();
  const form = useForm(EMPTY);
  const { values, set, bind, fieldError } = form;
  const [saving, setSaving] = useState(false);
  const editablesTouched = useRef(false);
  const options = useApi(open && !editing ? "/projects/options" : null, {
    params: values.brandId ? { brandId: values.brandId } : undefined,
  });
  const services = useApi(open && editing ? "/projects/options" : null);
  const opts = (editing ? services.data : options.data) ?? { brands: [], services: [], staff: [] };

  useEffect(() => {
    if (!open) return;
    editablesTouched.current = false;
    form.reset(project ? fromProject(project) : { ...EMPTY, brandId: defaults.brandId ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);

  // one brand available (or a client with a single brand): choose it
  const brands = useMemo(
    () => (defaults.clientId ? opts.brands.filter((b) => b.clientId === defaults.clientId) : opts.brands),
    [opts.brands, defaults.clientId],
  );
  useEffect(() => {
    if (open && !editing && !values.brandId && brands.length === 1) set("brandId", brands[0].id);
  }, [open, editing, brands, values.brandId, set]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const brand of brands) {
      if (!map.has(brand.client.id)) map.set(brand.client.id, { client: brand.client, brands: [] });
      map.get(brand.client.id).brands.push(brand);
    }
    return [...map.values()];
  }, [brands]);

  // drop members that became ineligible for the chosen client
  useEffect(() => {
    if (editing || !values.members.length || !opts.staff.length) return;
    const eligible = new Set(opts.staff.filter((s) => s.eligible).map((s) => s.id));
    const kept = values.members.filter((m) => eligible.has(m.userId));
    if (kept.length !== values.members.length) set("members", kept);
  }, [opts.staff, editing, values.members, set]);

  const onService = (serviceId) => {
    set("serviceId", serviceId);
    const service = opts.services.find((s) => s.id === serviceId);
    if (service && !editablesTouched.current) set("includesEditables", service.includesEditables);
  };

  const submit = async (event) => {
    event.preventDefault();
    const local = {};
    if (!values.brandId) local.brandId = "Escolha a marca do projeto.";
    if (!values.name.trim()) local.name = "Dê um nome ao projeto.";
    if (values.startDate && values.dueDate && values.dueDate < values.startDate) local.dueDate = "O prazo não pode ser antes do início.";
    if (Object.keys(local).length) {
      form.setErrors(local);
      return;
    }
    const body = {
      name: values.name.trim(),
      description: clean(values.description),
      serviceId: values.serviceId || null,
      startDate: values.startDate || null,
      dueDate: values.dueDate || null,
      includesEditables: values.includesEditables,
      internalNotes: clean(values.internalNotes),
    };
    setSaving(true);
    try {
      if (editing) {
        const res = await api.patch(`/projects/${project.id}`, body);
        toast.success("Projeto atualizado.");
        onSaved?.(res.project);
      } else {
        const res = await api.post("/projects", { ...body, brandId: values.brandId, status: values.status, members: values.members });
        const notified = res.notified ?? 0;
        toast.success(
          notified
            ? `Projeto criado. ${notified === 1 ? "A pessoa atribuída foi avisada" : `As ${notified} pessoas atribuídas foram avisadas`} ${noticeChannels(res)}`
            : "Projeto criado.",
        );
        onSaved?.(res.project);
      }
      onClose?.();
    } catch (error) {
      if (!form.fail(error)) toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  const loadingOptions = (editing ? services : options).loading;

  return (
    <Drawer
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      size="md"
      eyebrow={editing ? "Projeto" : "Novo projeto"}
      title={editing ? `Editar ${project.name}` : "Abrir projeto"}
      description={
        editing
          ? "A equipe e o status ficam na página do projeto."
          : "Escolha a marca, o serviço e quem vai trabalhar. Cada pessoa atribuída recebe o aviso na plataforma e, com o envio configurado, por e-mail."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {editing ? "Salvar alterações" : "Criar projeto"}
          </Button>
        </>
      }
    >
      <form ref={form.ref} id={formId} className="crm-form" onSubmit={submit} noValidate>
        <fieldset className="crm-form__section">
          <legend className="crm-form__legend">
            <span className="crm-form__index">01</span> Marca e serviço
          </legend>
          {editing ? (
            <p className="crm-form__readonly">
              <span className="ui-meta">Marca</span>
              <strong>{project.brand.name}</strong>
              <span className="ui-meta">{project.client.name}</span>
            </p>
          ) : (
            <Field label="Marca" required error={fieldError("brandId")} hint={!loadingOptions && !brands.length ? "Nenhuma marca ativa no seu acesso. Crie a marca no cliente primeiro." : undefined}>
              <Select {...bind("brandId")} placeholder={loadingOptions ? "Carregando marcas…" : "Escolha a marca"} disabled={loadingOptions && !brands.length}>
                {groups.map((group) => (
                  <optgroup key={group.client.id} label={group.client.name}>
                    {group.brands.map((brand) => (
                      <option key={brand.id} value={brand.id}>
                        {brand.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Serviço contratado" optional error={fieldError("serviceId")}>
            <Select value={values.serviceId} onValueChange={onService} placeholder="Sem serviço vinculado">
              {opts.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                  {service.active ? "" : " (inativo)"}
                </option>
              ))}
            </Select>
          </Field>
        </fieldset>

        <fieldset className="crm-form__section">
          <legend className="crm-form__legend">
            <span className="crm-form__index">02</span> Projeto
          </legend>
          <Field label="Nome do projeto" required error={fieldError("name")}>
            <Input {...bind("name")} placeholder="Ex.: Identidade visual 2026" data-autofocus={editing || undefined} />
          </Field>
          <Field label="Descrição" optional error={fieldError("description")}>
            <Textarea {...bind("description")} rows={3} autoGrow placeholder="Escopo, entregas combinadas e referências principais." />
          </Field>
          <div className="crm-form__row crm-form__row--3">
            {!editing && (
              <Field label="Status inicial" error={fieldError("status")}>
                <Select {...bind("status")} options={PROJECT_STATUS_OPTIONS.filter((o) => o.value !== "archived")} />
              </Field>
            )}
            <Field label="Início" optional error={fieldError("startDate")}>
              <DateInput {...bind("startDate")} />
            </Field>
            <Field label="Prazo" optional error={fieldError("dueDate")}>
              <DateInput {...bind("dueDate")} min={values.startDate || undefined} />
            </Field>
          </div>
          <Switch
            checked={values.includesEditables}
            onCheckedChange={(on) => {
              editablesTouched.current = true;
              set("includesEditables", on);
            }}
            label="Arquivos editáveis incluídos"
            description="Os arquivos-fonte (AI, PSD, Figma…) fazem parte das entregas deste projeto."
          />
        </fieldset>

        {!editing && (
          <fieldset className="crm-form__section">
            <legend className="crm-form__legend">
              <span className="crm-form__index">03</span> Equipe atribuída
            </legend>
            {!values.brandId ? (
              <p className="crm-form__note">Escolha a marca para ver quem pode trabalhar neste cliente.</p>
            ) : (
              <MemberPicker
                staff={opts.staff}
                value={values.members}
                onChange={(members) => set("members", members)}
                error={fieldError("members")}
              />
            )}
          </fieldset>
        )}

        <fieldset className="crm-form__section">
          <legend className="crm-form__legend crm-form__legend--aside">
            <span>
              <span className="crm-form__index">{editing ? "03" : "04"}</span> Notas internas
            </span>
            <InternalBadge />
          </legend>
          <Field label="Notas" optional error={fieldError("internalNotes")} hint="Visíveis somente para a equipe.">
            <Textarea {...bind("internalNotes")} rows={3} autoGrow />
          </Field>
        </fieldset>
      </form>
    </Drawer>
  );
}
