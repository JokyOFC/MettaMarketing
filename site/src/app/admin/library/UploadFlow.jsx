import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, CloudUpload, FolderOpen, Layers, Send, SquareStack } from "lucide-react";
import {
  Button,
  DateInput,
  Dropzone,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Panel,
  Segmented,
  Select,
  Skeleton,
  Switch,
  TagInput,
  Textarea,
  formatDate,
  labelOptions,
  statusLabel,
  useApi,
  useReducedMotion,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import ReleaseDialog from "./ReleaseDialog.jsx";
import { FileQueue, queueStats } from "./FileQueue.jsx";
import { Art, CheckDraw, MaterialBadges, VersionTag } from "./parts.jsx";
import { materialPath } from "./MaterialCard.jsx";
import {
  ACCEPT,
  brandClientId,
  materialsLabel,
  titleFromFilename,
  useBrands,
  useCategories,
  useClients,
  useOwners,
  useProjects,
  useUploadLimit,
} from "./data.js";
import { useUploadQueue } from "./useUploadQueue.js";
import "./library.css";

const DROP_HINT = "Imagens, vetores (SVG, EPS), vídeos, PDF, fontes e arquivos de design (AI, PSD, Figma…). Cada arquivo começa a subir na hora.";

// files payload for one material: positions follow the list order per role.
function filesPayload(items, { positions = true } = {}) {
  const counters = {};
  return items.map((item) => {
    counters[item.role] = (counters[item.role] ?? 0) + 1;
    return { uploadId: item.upload.id, role: item.role, ...(positions ? { position: counters[item.role] } : {}) };
  });
}

export default function UploadFlow() {
  const [params] = useSearchParams();
  const materialId = params.get("materialId");
  if (materialId) return <NewVersionFlow key={materialId} materialId={materialId} />;
  return (
    <NewMaterialsFlow
      prefill={{
        brandId: params.get("brandId") || "",
        projectId: params.get("projectId") || "",
        categoryId: params.get("categoryId") || "",
        category: params.get("category") || "",
        variant: params.get("variant") || "",
      }}
    />
  );
}

// ---------------------------------------------------------------- new materials

function NewMaterialsFlow({ prefill }) {
  usePageTitle("Enviar arquivos");
  const { user, can } = useAuth();
  const toast = useToast();
  const reducedMotion = useReducedMotion();
  const maxBytes = useUploadLimit();
  const queue = useUploadQueue({ maxBytes });
  const clients = useClients();
  const brands = useBrands();
  const categories = useCategories();
  const [form, setForm] = useState(() => ({
    clientId: "",
    brandId: prefill.brandId,
    projectId: prefill.projectId,
    categoryId: prefill.categoryId,
    variant: prefill.variant,
    ownerId: user?.id ?? "",
    title: "",
    description: "",
    tags: [],
    dueDate: "",
    editableIncluded: null,
    requiresApproval: true,
  }));
  const [titleTouched, setTitleTouched] = useState(false);
  // The brand's only active project is chosen for the team, until someone
  // picks another option (including "no project") by hand.
  const [projectTouched, setProjectTouched] = useState(Boolean(prefill.projectId));
  const [grouping, setGrouping] = useState("each");
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState([]);
  const [failures, setFailures] = useState([]);
  const [view, setView] = useState("form");
  const formRef = useRef(null);

  const projects = useProjects(form.brandId || null);
  const owners = useOwners(form.projectId || null);
  const brand = brands.items.find((b) => b.id === form.brandId) ?? null;
  const clientId = form.clientId || brandClientId(brand) || "";
  const category = categories.items.find((c) => c.id === form.categoryId) ?? null;
  const isLogoCategory = category?.slug === "logotipo";
  const project = projects.items.find((p) => p.id === form.projectId) ?? null;
  const editableIncluded = form.editableIncluded ?? Boolean(project?.includesEditables);
  const designer = user?.role === "designer";

  useEffect(() => {
    if (projectTouched || form.projectId || !form.brandId || projects.loading) return;
    if (projects.items.length === 1) setForm((f) => (f.brandId === form.brandId && !f.projectId ? { ...f, projectId: projects.items[0].id } : f));
  }, [projectTouched, form.projectId, form.brandId, projects.loading, projects.items]);

  // ?category=<slug> prefill once the categories arrive.
  useEffect(() => {
    if (prefill.category && !form.categoryId && categories.items.length) {
      const match = categories.items.find((c) => c.slug === prefill.category);
      if (match) setForm((f) => ({ ...f, categoryId: match.id }));
    }
  }, [prefill.category, categories.items, form.categoryId]);

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  };

  const readyItems = queue.items.filter((item) => item.status === "done" && !item.saved);
  const stats = queueStats(queue.items);
  const grouped = grouping === "group" && queue.items.length > 1;

  // Group title follows the first file until someone types one.
  const firstName = queue.items.find((item) => item.status !== "error")?.name;
  useEffect(() => {
    if (!titleTouched && firstName) setForm((f) => ({ ...f, title: titleFromFilename(firstName) }));
  }, [firstName, titleTouched]);

  const clientOptions = useMemo(() => {
    const list = clients.items.map((c) => ({ value: c.id, label: c.name }));
    if (list.length) return list;
    const seen = new Map();
    for (const b of brands.items) if (b.client?.id) seen.set(b.client.id, b.client.name);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [clients.items, brands.items]);
  const brandOptions = brands.items
    .filter((b) => !clientId || brandClientId(b) === clientId)
    .map((b) => ({ value: b.id, label: b.name }));

  const validate = () => {
    const e = {};
    if (!form.brandId) e.brandId = "Escolha a marca que recebe os arquivos.";
    if (!form.categoryId) e.categoryId = "Escolha a categoria.";
    if (designer && !form.projectId) e.projectId = "Selecione um dos seus projetos.";
    if (grouped && !form.title.trim()) e.title = "Dê um título ao material.";
    if (!readyItems.length) e.files = stats.uploading + stats.queued ? "Aguarde os envios terminarem." : "Envie pelo menos um arquivo.";
    else if (stats.uploading + stats.queued) e.files = "Aguarde os envios terminarem para salvar.";
    if (grouped && !readyItems.some((item) => item.role === "original" || item.role === "final"))
      e.files = "Inclua pelo menos um arquivo original ou final.";
    return e;
  };

  const focusFirstError = (e) => {
    const order = ["files", "clientId", "brandId", "projectId", "categoryId", "variant", "title"];
    const first = order.find((key) => e[key]);
    const el = formRef.current?.querySelector(`[data-field="${first}"] input, [data-field="${first}"] select, [data-field="${first}"] textarea, [data-field="${first}"]`);
    el?.focus?.({ preventScroll: true });
    el?.scrollIntoView?.({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
  };

  const applyServerFields = (error) => {
    if (error?.code !== "validation" || !error.fields) return false;
    const mapped = {};
    for (const [key, message] of Object.entries(error.fields)) {
      if (key.startsWith("files")) mapped.files = message;
      else mapped[key] = message;
    }
    setErrors(mapped);
    focusFirstError(mapped);
    return ["brandId", "projectId", "categoryId", "ownerId", "variant", "dueDate", "title"].some((key) => mapped[key]);
  };

  const save = async () => {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      focusFirstError(e);
      return;
    }
    setSaving(true);
    const base = {
      kind: "asset",
      brandId: form.brandId,
      projectId: form.projectId || undefined,
      categoryId: form.categoryId,
      description: form.description.trim() || undefined,
      tags: form.tags,
      ownerId: form.ownerId || undefined,
      variant: isLogoCategory && form.variant ? form.variant : undefined,
      dueDate: form.dueDate || undefined,
      editableIncluded,
      requiresApproval: form.requiresApproval,
    };
    const made = [];
    const failed = [];
    if (grouped) {
      try {
        const res = await api.post("/materials", { ...base, title: form.title.trim(), files: filesPayload(readyItems) });
        const material = res?.material ?? res;
        made.push(material);
        readyItems.forEach((item) => queue.update(item.key, { saved: material.id }));
      } catch (error) {
        if (!applyServerFields(error)) toast.error(error.message);
        failed.push({ name: form.title, message: error.message });
      }
    } else {
      for (const item of readyItems) {
        try {
          const role = item.role === "cover" ? "original" : item.role;
          const res = await api.post("/materials", {
            ...base,
            title: item.title.trim() || titleFromFilename(item.name),
            files: [{ uploadId: item.upload.id, role, position: 1 }],
          });
          const material = res?.material ?? res;
          made.push(material);
          queue.update(item.key, { saved: material.id });
        } catch (error) {
          failed.push({ name: item.name, message: error.message });
          if (applyServerFields(error)) break; // same form problem for every file
        }
      }
    }
    setSaving(false);
    if (made.length) {
      setCreated((prev) => [...prev, ...made]);
      setFailures(failed);
      setView("done");
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    } else if (failed.length && !grouped) {
      toast.error(failed[0].message);
    }
  };

  const again = () => {
    queue.reset();
    setCreated([]);
    setFailures([]);
    setTitleTouched(false);
    setView("form");
  };

  if (view === "done")
    return (
      <UploadDone
        materials={created}
        failures={failures}
        clientName={created[0]?.client?.name ?? brand?.client?.name}
        onBack={failures.length ? () => setView("form") : null}
        onAgain={again}
        libraryHref={`/admin/biblioteca?brandId=${form.brandId}${form.categoryId ? `&categoryId=${form.categoryId}` : ""}`}
        onChange={(id, patch) => setCreated((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)))}
      />
    );

  const canSave = readyItems.length > 0 && !stats.uploading && !stats.queued;
  return (
    <div className="lib-page">
      <PageHeader
        back={{ to: form.brandId ? `/admin/biblioteca?brandId=${form.brandId}` : "/admin/biblioteca", label: "Biblioteca" }}
        eyebrow="Biblioteca de arquivos"
        title="Enviar"
        accent="arquivos"
        description="Tudo começa como rascunho, visível só para a equipe, até ser liberado ao cliente."
      />
      <div className="lib-cq">
      <div className="lib-up" ref={formRef}>
        <div className="lib-up__main">
          <div data-field="files" tabIndex={-1} className="lib-up__drop">
            <Dropzone
              accept={ACCEPT}
              maxSizeBytes={maxBytes ?? undefined}
              multiple
              title={queue.items.length ? "Adicionar mais arquivos" : "Arraste os arquivos para cá"}
              description={DROP_HINT}
              buttonLabel="Escolher arquivos"
              compact={queue.items.length > 0}
              onFiles={(files) => {
                queue.add(files);
                setErrors((e) => ({ ...e, files: undefined }));
              }}
              onReject={(rejected) => queue.add(rejected.map((entry) => entry.file))}
            />
            {errors.files && (
              <p className="lib-up__error" role="alert">
                {errors.files}
              </p>
            )}
          </div>

          {queue.items.length > 1 && (
            <div className="lib-up__grouping ui-page-enter">
              <Segmented
                aria-label="Como organizar os arquivos"
                value={grouping}
                onChange={setGrouping}
                options={[
                  { value: "each", label: "Um material por arquivo", icon: SquareStack },
                  { value: "group", label: "Agrupar como um material", icon: Layers },
                ]}
              />
              <p className="lib-up__grouping-hint">
                {grouped
                  ? "Um único material com todos os arquivos, como um carrossel, apresentação ou logo em vários formatos. A ordem abaixo é a ordem dos slides e dos downloads."
                  : "Cada arquivo vira um material separado, com título próprio e a mesma atribuição."}
              </p>
            </div>
          )}

          <FileQueue
            queue={queue}
            roles={grouped ? ["original", "final", "editable", "cover"] : ["original", "final", "editable"]}
            sortable={grouped}
            titles={!grouped}
          />
        </div>

        <aside className="lib-up__side" aria-label="Atribuição">
          <Panel title="Atribuição" eyebrow="Para quem e onde" className="lib-up__panel">
            <div className="lib-form">
              <div data-field="clientId">
                <Field label="Cliente" error={errors.clientId}>
                  <Select
                    placeholder="Escolha o cliente"
                    value={clientId}
                    options={clientOptions}
                    onValueChange={(value) => {
                      const keep = brand && brandClientId(brand) === value;
                      if (!keep) setProjectTouched(false);
                      set({ clientId: value, ...(keep ? {} : { brandId: "", projectId: "" }) });
                    }}
                  />
                </Field>
              </div>
              <div data-field="brandId">
                <Field label="Marca" required error={errors.brandId}>
                  <Select
                    placeholder={brands.loading ? "Carregando marcas…" : "Escolha a marca"}
                    value={form.brandId}
                    options={brandOptions}
                    onValueChange={(value) => {
                      const next = brands.items.find((b) => b.id === value);
                      setProjectTouched(false);
                      set({ brandId: value, projectId: "", clientId: brandClientId(next) || form.clientId });
                    }}
                  />
                </Field>
              </div>
              <div data-field="projectId">
                <Field
                  label="Projeto ou serviço"
                  required={designer}
                  error={errors.projectId}
                  hint={
                    !form.brandId || projects.loading || form.projectId
                      ? undefined
                      : projects.items.length
                        ? "Vincule ao projeto ou serviço contratado: assim o material entra no pacote final do projeto."
                        : "Esta marca ainda não tem projetos ativos. Crie o projeto em Projetos e tarefas para vincular o material."
                  }
                >
                  <Select
                    placeholder={form.brandId ? "Sem projeto ou serviço" : "Escolha a marca primeiro"}
                    disabled={!form.brandId}
                    value={form.projectId}
                    options={projects.items.map((p) => ({ value: p.id, label: p.name }))}
                    onValueChange={(value) => {
                      setProjectTouched(true);
                      set({ projectId: value, editableIncluded: null });
                    }}
                  />
                </Field>
              </div>
              <div data-field="categoryId">
                <Field label="Categoria" required error={errors.categoryId}>
                  <Select
                    placeholder="Escolha a categoria"
                    value={form.categoryId}
                    options={categories.active.map((c) => ({ value: c.id, label: c.name }))}
                    onValueChange={(value) => set({ categoryId: value })}
                  />
                </Field>
                {category?.area === "content" && can("content.manage") && (
                  <p className="lib-up__catnote" role="note">
                    Enviados aqui, estes arquivos aparecem para o cliente em Arquivos. Para um post com legenda, rede e data, revisado
                    na Central de conteúdo, use <Link to="/admin/conteudo/novo">Novo post</Link>.
                  </p>
                )}
              </div>
              {isLogoCategory && (
                <div data-field="variant" className="ui-page-enter">
                  <Field label="Variante da logo" error={errors.variant} hint="Organiza a logo em Minha marca (principal, símbolo, versões…).">
                    <Select
                      placeholder="Sem variante"
                      value={form.variant}
                      options={labelOptions("variant")}
                      onValueChange={(value) => set({ variant: value })}
                    />
                  </Field>
                </div>
              )}
              <Field label="Responsável" error={errors.ownerId}>
                <Select value={form.ownerId} options={owners.items.map((p) => ({ value: p.id, label: p.name }))} onValueChange={(value) => set({ ownerId: value })} />
              </Field>
            </div>
          </Panel>

          <Panel title="Detalhes" eyebrow={grouped ? "Do material" : "Para todos os arquivos"} className="lib-up__panel">
            <div className="lib-form">
              {grouped && (
                <div data-field="title">
                  <Field label="Título" required error={errors.title}>
                    <Input
                      value={form.title}
                      maxLength={200}
                      onValueChange={(value) => {
                        setTitleTouched(true);
                        set({ title: value });
                      }}
                    />
                  </Field>
                </div>
              )}
              <Field label="Descrição" optional>
                <Textarea rows={3} autoGrow value={form.description} maxLength={4000} onValueChange={(value) => set({ description: value })} />
              </Field>
              <Field label="Etiquetas" optional hint="Enter ou vírgula para adicionar.">
                <TagInput value={form.tags} max={30} onChange={(tags) => set({ tags })} />
              </Field>
              <Field label="Prazo" optional error={errors.dueDate}>
                <DateInput value={form.dueDate} onValueChange={(value) => set({ dueDate: value })} />
              </Field>
              <div className="lib-form__switches">
                <Switch
                  label="Arquivo editável incluído"
                  description={project?.includesEditables ? "O projeto inclui editáveis." : "O cliente só vê editáveis quando incluídos no serviço."}
                  checked={editableIncluded}
                  onCheckedChange={(on) => set({ editableIncluded: on })}
                />
                <Switch
                  label="Exige aprovação do cliente"
                  description="Desligue para entregas finais que não precisam de aprovação."
                  checked={form.requiresApproval}
                  onCheckedChange={(on) => set({ requiresApproval: on })}
                />
              </div>
            </div>
          </Panel>

          <div className="lib-up__actions">
            <Button variant="primary" block icon={CloudUpload} loading={saving} onClick={save} disabled={!queue.items.length}>
              {grouped || readyItems.length <= 1 ? "Salvar como rascunho" : `Salvar ${materialsLabel(readyItems.length)} como rascunho`}
            </Button>
            <p className="lib-up__note">
              {!queue.items.length
                ? "Adicione arquivos para começar."
                : !canSave && (stats.uploading || stats.queued)
                  ? "Aguardando os envios terminarem…"
                  : stats.failed
                    ? `${stats.failed === 1 ? "1 arquivo com falha fica" : `${stats.failed} arquivos com falha ficam`} de fora.`
                    : "Nada fica visível ao cliente até a liberação."}
            </p>
          </div>
        </aside>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- success

function NextStep({ icon: Icon, title, description, onClick, to, disabled, done, loading }) {
  const content = (
    <>
      <span className="lib-next__icon" aria-hidden="true">
        {done ? <CheckDraw size={22} /> : <Icon size={18} strokeWidth={1.4} />}
      </span>
      <span className="lib-next__text">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <ArrowRight className="lib-next__go" size={16} strokeWidth={1.4} aria-hidden="true" />
    </>
  );
  if (to)
    return (
      <Link to={to} className="lib-next">
        {content}
      </Link>
    );
  return (
    <button type="button" className={`lib-next${done ? " is-done" : ""}`} onClick={onClick} disabled={disabled || done || loading} aria-busy={loading || undefined}>
      {content}
    </button>
  );
}

function UploadDone({ materials, failures, clientName, onBack, onAgain, libraryHref, onChange, version }) {
  const { can } = useAuth();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const count = materials.length;
  const drafts = materials.filter((m) => m.visibility === "draft");
  const unreleased = materials.filter((m) => m.visibility !== "released" || (m.currentVersionId && m.currentVersionId !== m.releasedVersionId));
  const released = materials.length > 0 && materials.every((m) => m.visibility === "released" && (!m.currentVersionId || m.currentVersionId === m.releasedVersionId));

  const submitAll = async () => {
    setSubmitting(true);
    let ok = 0;
    for (const material of drafts) {
      try {
        const res = await api.post(`/materials/${material.id}/submit`);
        onChange(material.id, res?.material ?? { visibility: "internal_review" });
        ok += 1;
      } catch (error) {
        toast.error(`${material.title}: ${error.message}`);
      }
    }
    setSubmitting(false);
    if (ok) toast.success(ok === 1 ? "Enviado para revisão interna. Os gestores foram avisados." : `${ok} materiais enviados para revisão interna.`);
  };

  return (
    <div className="lib-page lib-done ui-page-enter">
      <div className="lib-done__hero" role="status">
        <CheckDraw size={72} />
        <p className="ui-eyebrow">{version ? "Nova versão" : "Rascunho salvo"}</p>
        <h1 className="lib-done__title">
          {version ? `Versão ${version} salva` : count === 1 ? "Material salvo" : `${count} materiais salvos`} <em>como rascunho</em>
        </h1>
        <p className="lib-done__text">
          Visível só para a equipe.{" "}
          {can("materials.release")
            ? `Revise e libere${clientName ? ` para ${clientName}` : ""} quando estiver pronto.`
            : "Envie para revisão: um gestor confere e libera ao cliente."}
        </p>
      </div>

      <ul className="lib-done__list">
        {materials.map((material, index) => (
          <li key={material.id} className="lib-done__item ui-enter" style={{ "--i": Math.min(index, 8) }}>
            <Link to={materialPath(material)} className="lib-done__thumb" tabIndex={-1} aria-hidden="true">
              <Art material={material} stage={1} />
            </Link>
            <div className="lib-done__info">
              <Link to={materialPath(material)} className="lib-done__name">
                {material.title}
              </Link>
              <span className="lib-done__meta">
                <VersionTag number={material.version?.number} />
                <MaterialBadges material={material} />
              </span>
            </div>
          </li>
        ))}
      </ul>
      {failures.length > 0 && (
        <div className="lib-done__failed" role="alert">
          <p>
            {failures.length === 1 ? "1 arquivo não foi salvo" : `${failures.length} arquivos não foram salvos`}: {failures[0].message}
          </p>
          {onBack && (
            <Button size="sm" onClick={onBack}>
              Voltar e corrigir
            </Button>
          )}
        </div>
      )}

      <div className="lib-done__next">
        <NextStep
          icon={Send}
          title="Enviar para revisão"
          description={drafts.length ? "Avisa os gestores que está pronto para conferência." : "Já está em revisão interna."}
          onClick={submitAll}
          loading={submitting}
          done={!drafts.length}
        />
        {can("materials.release") && (
          <NextStep
            icon={Send}
            title={version ? "Liberar nova versão" : "Liberar para o cliente"}
            description={released ? "Liberado. O cliente já pode ver." : "Confira destino, arquivos e permissões antes."}
            onClick={() => setReleaseOpen(true)}
            done={released}
            disabled={!unreleased.length}
          />
        )}
        <NextStep icon={FolderOpen} title={version ? "Ver material" : "Ver na biblioteca"} description="Abrir e continuar organizando." to={libraryHref} />
      </div>
      <div className="lib-done__again">
        <Button variant="ghost" icon={CloudUpload} onClick={onAgain}>
          {version ? "Enviar outra versão" : "Enviar mais arquivos"}
        </Button>
      </div>

      <ReleaseDialog
        open={releaseOpen}
        materialIds={unreleased.map((m) => m.id)}
        onClose={() => setReleaseOpen(false)}
        onReleased={() => {
          for (const material of unreleased)
            onChange(material.id, {
              visibility: "released",
              releasedVersionId: material.currentVersionId ?? material.version?.id,
              approvalStatus: material.requiresApproval ? "pending" : "none",
            });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- new version

function NewVersionFlow({ materialId }) {
  const toast = useToast();
  const { data, error, loading, reload } = useApi(`/materials/${materialId}`);
  const material = data?.material ?? null;
  usePageTitle(material ? `Nova versão · ${material.title}` : "Nova versão");
  const maxBytes = useUploadLimit();
  const queue = useUploadQueue({ maxBytes });
  const [summary, setSummary] = useState("");
  const [copy, setCopy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileError, setFileError] = useState(null);
  const [result, setResult] = useState(null);

  if (loading)
    return (
      <div className="lib-page">
        <Skeleton width={180} height={12} />
        <Skeleton width="45%" height={34} style={{ marginTop: 14 }} />
        <Skeleton height={220} radius={6} style={{ marginTop: 28 }} />
      </div>
    );
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!material) return null;

  const versions = material.versions ?? [];
  const current = versions.find((v) => v.id === material.currentVersionId) ?? versions[0] ?? null;
  const openDraft = current && (current.status === "draft" || current.status === "internal_review");
  const allowed = material.permissions?.canUploadVersion ?? material.permissions?.canEdit;
  const ready = queue.items.filter((item) => item.status === "done" && !item.saved);
  const stats = queueStats(queue.items);
  const nextNumber = openDraft ? current.number : (versions[0]?.number ?? 0) + 1;

  if (!allowed)
    return (
      <div className="lib-page">
        <PageHeader back={{ to: materialPath(material), label: material.title }} eyebrow="Nova versão" title={material.title} />
        <EmptyState title="Você não pode enviar versões deste material" description="Peça ao responsável ou a um gestor para enviar a nova versão." />
      </div>
    );

  if (result)
    return (
      <UploadDone
        version={result.number}
        materials={[result.material]}
        failures={[]}
        clientName={material.client?.name}
        onAgain={() => {
          queue.reset();
          setResult(null);
          setSummary("");
          reload();
        }}
        libraryHref={materialPath(material)}
        onChange={(id, patch) => setResult((r) => ({ ...r, material: { ...r.material, ...patch } }))}
      />
    );

  const save = async () => {
    if (!ready.length) {
      setFileError(stats.uploading + stats.queued ? "Aguarde os envios terminarem." : "Envie pelo menos um arquivo.");
      return;
    }
    if (stats.uploading + stats.queued) {
      setFileError("Aguarde os envios terminarem para salvar.");
      return;
    }
    setSaving(true);
    setFileError(null);
    try {
      if (openDraft) {
        await api.post(`/versions/${current.id}/files`, { files: filesPayload(ready, { positions: false }) });
        if (summary.trim()) await api.patch(`/versions/${current.id}`, { changeSummary: summary.trim() });
      } else {
        await api.post(`/materials/${material.id}/versions`, {
          files: filesPayload(ready, { positions: !copy }),
          ...(copy ? { copyFrom: "current" } : {}),
          ...(summary.trim() ? { changeSummary: summary.trim() } : {}),
        });
      }
      ready.forEach((item) => queue.update(item.key, { saved: material.id }));
      const fresh = await api.get(`/materials/${material.id}`);
      setResult({ number: nextNumber, material: fresh?.material ?? material });
      toast.success(openDraft ? `Arquivos adicionados à versão ${current.number}.` : `Versão ${nextNumber} criada como rascunho.`);
    } catch (err) {
      if (err.code === "validation" && err.fields) setFileError(Object.values(err.fields)[0] ?? err.message);
      else toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lib-page">
      <PageHeader
        back={{ to: materialPath(material), label: material.title }}
        eyebrow={`${material.client?.name ?? ""}${material.brand?.name ? ` · ${material.brand.name}` : ""}`}
        title={openDraft ? "Adicionar arquivos à" : "Nova versão de"}
        accent={material.title}
        description={
          openDraft
            ? `A versão ${current.number} ainda não foi liberada: os arquivos entram nela. O histórico é preservado.`
            : "A versão atual continua no histórico. A nova começa como rascunho e exige nova aprovação quando for liberada."
        }
        meta={
          <>
            <span>
              Versão atual <VersionTag number={current?.number} />
            </span>
            {current && <span>{statusLabel("version", current.status)}</span>}
            {current?.createdAt && <span>desde {formatDate(current.createdAt)}</span>}
            <MaterialBadges material={material} />
          </>
        }
      />
      <div className="lib-cq">
      <div className="lib-up">
        <div className="lib-up__main">
          <div className="lib-up__drop">
            <Dropzone
              accept={ACCEPT}
              maxSizeBytes={maxBytes ?? undefined}
              multiple
              compact={queue.items.length > 0}
              title={queue.items.length ? "Adicionar mais arquivos" : `Arraste os arquivos da versão ${nextNumber}`}
              description={DROP_HINT}
              onFiles={(files) => {
                queue.add(files);
                setFileError(null);
              }}
              onReject={(rejected) => queue.add(rejected.map((entry) => entry.file))}
            />
            {fileError && (
              <p className="lib-up__error" role="alert">
                {fileError}
              </p>
            )}
          </div>
          <FileQueue queue={queue} roles={["original", "final", "editable", "cover"]} sortable={queue.items.length > 1 && !openDraft} />
        </div>
        <aside className="lib-up__side">
          <Panel title="Sobre esta versão" eyebrow={`Versão ${nextNumber}`} className="lib-up__panel">
            <div className="lib-form">
              <Field label="O que mudou" optional hint="Aparece para o cliente junto da versão.">
                <Textarea
                  rows={4}
                  autoGrow
                  maxLength={2000}
                  value={summary}
                  placeholder="Ex.: ajuste no espaçamento do símbolo e cores revisadas."
                  onValueChange={setSummary}
                />
              </Field>
              {!openDraft && (
                <Switch
                  label="Manter os arquivos da versão atual"
                  description="Copia todos os arquivos da versão anterior e acrescenta os novos (útil para manter editáveis)."
                  checked={copy}
                  onCheckedChange={setCopy}
                />
              )}
            </div>
          </Panel>
          <div className="lib-up__actions">
            <Button variant="primary" block icon={CloudUpload} loading={saving} disabled={!queue.items.length} onClick={save}>
              {openDraft ? `Adicionar à versão ${current.number}` : `Salvar versão ${nextNumber} como rascunho`}
            </Button>
            <p className="lib-up__note">
              {stats.uploading || stats.queued ? "Aguardando os envios terminarem…" : "O cliente continua vendo a versão liberada até você liberar a nova."}
            </p>
          </div>
        </aside>
      </div>
      </div>
    </div>
  );
}
