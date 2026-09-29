import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, FilePlus2 } from "lucide-react";
import { api } from "../../api/client.js";
import {
  Button,
  DateInput,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  isoDate,
  useApi,
  useToast,
} from "../../ui/index.js";
import { useInvalidFocus } from "../clients/crmShared.jsx";

const cx = (...parts) => parts.filter(Boolean).join(" ");
const BLANK = { id: "", name: "Em branco", description: "Comece sem perguntas e monte do seu jeito.", title: "" };

// "Novo briefing": brand, optional project, template (or blank), title and due date.
export default function NewBriefingModal({ open, onClose, defaultBrandId = "" }) {
  const navigate = useNavigate();
  const toast = useToast();
  const brandsApi = useApi(open ? "/brands" : null);
  const templatesApi = useApi(open ? "/briefing-templates" : null);
  const [brandId, setBrandId] = useState(defaultBrandId);
  const [projectId, setProjectId] = useState("");
  const [templateId, setTemplateId] = useState("identidade-visual");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [formRef, focusInvalid] = useInvalidFocus();
  const projectsApi = useApi(open && brandId ? "/projects" : null, { params: { brandId } });

  useEffect(() => {
    if (!open) return;
    setBrandId(defaultBrandId);
    setProjectId("");
    setTemplateId("identidade-visual");
    setTitle("");
    setTitleTouched(false);
    setDueDate("");
    setErrors({});
  }, [open, defaultBrandId]);

  const templates = useMemo(() => [BLANK, ...(templatesApi.data?.items ?? [])], [templatesApi.data]);
  const template = templates.find((item) => item.id === templateId) ?? BLANK;

  // The title follows the template until someone types their own.
  useEffect(() => {
    if (!titleTouched) setTitle(template.title || "");
  }, [template, titleTouched]);

  const brands = brandsApi.data?.items ?? [];
  const byClient = useMemo(() => {
    const groups = new Map();
    for (const brand of brands) {
      const client = brand.client?.name || "Cliente";
      if (!groups.has(client)) groups.set(client, []);
      groups.get(client).push(brand);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt-BR"));
  }, [brands]);
  const projects = (projectsApi.data?.items ?? []).filter((project) => project.status !== "archived");

  const submit = async (event) => {
    event.preventDefault();
    const local = {};
    if (!brandId) local.brandId = "Escolha a marca.";
    if (!title.trim()) local.title = "Dê um título ao briefing.";
    setErrors(local);
    if (Object.keys(local).length) return focusInvalid();
    setSaving(true);
    try {
      const res = await api.post("/briefings", {
        brandId,
        projectId: projectId || null,
        templateId: templateId || null,
        title: title.trim(),
        dueDate: dueDate || null,
      });
      toast.success("Briefing criado como rascunho. Revise as perguntas antes de enviar.");
      onClose();
      navigate(`/admin/briefings/${res.briefing.id}`);
    } catch (err) {
      setSaving(false);
      if (err.fields) {
        setErrors(err.fields);
        focusInvalid(err.message);
      } else toast.error(err);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      size="lg"
      eyebrow="Briefings"
      title="Novo briefing"
      description="O briefing começa como rascunho, visível só para a equipe, até ser enviado ao cliente."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="hub-new-briefing" loading={saving} icon={FilePlus2}>
            Criar rascunho
          </Button>
        </>
      }
    >
      <form ref={formRef} id="hub-new-briefing" className="hub-newform" onSubmit={submit} noValidate>
        <div className="hub-newform__row">
          <Field label="Marca" required error={errors.brandId}>
            {brandsApi.loading ? (
              <Skeleton height={40} radius={4} />
            ) : (
              <Select
                value={brandId}
                placeholder={brandsApi.error ? "Não foi possível carregar as marcas" : "Escolha a marca"}
                disabled={Boolean(brandsApi.error)}
                data-autofocus
                onValueChange={(value) => {
                  setBrandId(value);
                  setProjectId("");
                }}
              >
                {byClient.map(([client, list]) => (
                  <optgroup key={client} label={client}>
                    {list.map((brand) => (
                      <option key={brand.id} value={brand.id}>
                        {brand.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Projeto"
            optional
            error={errors.projectId}
            hint={brandId && !projectsApi.loading && !projects.length ? "Esta marca ainda não tem projetos." : undefined}
          >
            <Select
              value={projectId}
              placeholder={brandId ? "Sem projeto" : "Escolha a marca primeiro"}
              disabled={!brandId || projectsApi.loading || !projects.length}
              options={projects.map((project) => ({ value: project.id, label: project.name }))}
              onValueChange={setProjectId}
            />
          </Field>
        </div>

        <fieldset className="hub-templates">
          <legend className="hub-templates__legend">Modelo</legend>
          <div className="hub-templates__grid">
            {templatesApi.loading
              ? [0, 1, 2, 3].map((i) => <Skeleton key={i} height={112} radius={4} />)
              : templates.map((item) => {
                  const checked = item.id === templateId;
                  return (
                    <label key={item.id || "blank"} className={cx("hub-template", checked && "is-checked")}>
                      <input
                        type="radio"
                        name="hub-template"
                        value={item.id}
                        checked={checked}
                        onChange={() => setTemplateId(item.id)}
                      />
                      <span className="hub-template__head">
                        <span className="hub-template__name">{item.name}</span>
                        <span className="hub-template__tick" aria-hidden="true">
                          <Check size={13} strokeWidth={2} />
                        </span>
                      </span>
                      <span className="hub-template__desc">{item.description}</span>
                      <span className="hub-template__count">
                        {item.id
                          ? `${item.questionCount} perguntas · ${item.requiredCount} obrigatórias`
                          : "Sem perguntas"}
                      </span>
                    </label>
                  );
                })}
          </div>
          {templatesApi.error && <p className="ui-meta">Os modelos não carregaram; você ainda pode começar em branco.</p>}
        </fieldset>

        <div className="hub-newform__row">
          <Field label="Título" required error={errors.title}>
            <Input
              value={title}
              maxLength={160}
              placeholder="Ex.: Briefing de identidade visual"
              onValueChange={(value) => {
                setTitleTouched(true);
                setTitle(value);
              }}
            />
          </Field>
          <Field label="Prazo para o cliente" optional error={errors.dueDate}>
            <DateInput value={dueDate} min={isoDate()} onValueChange={setDueDate} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
