import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  BadgeCheck,
  CloudUpload,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  History,
  Lock,
  MessageSquare,
  PackageCheck,
  Palette,
  Pencil,
  Send,
  Star,
  Upload,
} from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  DateInput,
  Dropzone,
  EmptyState,
  ErrorState,
  Field,
  FileMeta,
  Input,
  Menu,
  PageHeader,
  Panel,
  Segmented,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
  Tabs,
  TagInput,
  Textarea,
  Thumb,
  formatDate,
  formatDateTime,
  formatRelative,
  labelOptions,
  useApi,
  useReducedMotion,
  useToast,
  variantLabel,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useDownloads } from "../../api/downloads.js";
import { usePageTitle } from "../../shell/index.js";
import ReleaseDialog, { DeliverDialog } from "./ReleaseDialog.jsx";
import { CommentThread, MaterialViewer, VersionHistory } from "./review.jsx";
import { FileQueue, queueStats } from "./FileQueue.jsx";
import { CheckDraw, Handle, Live, MaterialBadges, MoveButtons, VersionTag } from "./parts.jsx";
import {
  ACCEPT,
  artBackground,
  historyEvents,
  isLogo,
  sequenceLength,
  useCategories,
  useOwners,
  useProjects,
  useUploadLimit,
} from "./data.js";
import { useDragSort } from "./useDragSort.js";
import { useUploadQueue } from "./useUploadQueue.js";
import "./library.css";

const PREVIEW_BG = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Claro" },
  { value: "dark", label: "Escuro" },
  { value: "checker", label: "Transparência" },
];

function formFrom(material) {
  return {
    title: material.title ?? "",
    description: material.description ?? "",
    tags: material.tags ?? [],
    categoryId: material.category?.id ?? "",
    projectId: material.project?.id ?? "",
    ownerId: material.owner?.id ?? "",
    variant: material.variant ?? "",
    previewBg: material.previewBg ?? "auto",
    dueDate: material.dueDate ?? "",
    internalNotes: material.internalNotes ?? "",
  };
}

export default function MaterialAdmin() {
  const { id } = useParams();
  const toast = useToast();
  const { startZip } = useDownloads();
  const { data, error, loading, reload, setData } = useApi(`/materials/${id}`);
  const material = data?.material ?? null;
  usePageTitle(material?.title ?? "Material", {
    crumbs: [{ label: "Biblioteca", to: "/admin/biblioteca" }, { label: material?.title ?? "Material" }],
  });
  const [versionId, setVersionId] = useState(null);
  const [tab, setTab] = useState("comments");
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(null);
  const viewerRef = useRef(null);
  const reducedMotion = useReducedMotion();

  if (loading) return <MaterialSkeleton />;
  if (error && !material) return <ErrorState error={error} onRetry={reload} />;
  if (!material) return null;

  const perms = material.permissions ?? {};
  const versions = material.versions ?? [];
  const current = versions.find((v) => v.id === material.currentVersionId) ?? versions[0] ?? null;
  const released = material.visibility === "released";
  const pendingVersion = released && current && material.releasedVersionId && current.id !== material.releasedVersionId;
  const archived = Boolean(material.archivedAt);
  const deliverable =
    !archived && released && (material.approvalStatus === "approved" || (!material.requiresApproval && Boolean(material.releasedVersionId)));

  const patch = (next) => setData((d) => ({ ...d, material: { ...d.material, ...next } }));
  const act = async (key, fn, success) => {
    setBusy(key);
    try {
      const result = await fn();
      if (success) toast.success(success);
      await reload().catch(() => {});
      return result;
    } catch (err) {
      toast.error(err.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const submit = () => act("submit", () => api.post(`/materials/${material.id}/submit`), "Enviado para revisão interna. Os gestores foram avisados.");
  const makePrimary = () =>
    act("primary", () => api.post(`/materials/${material.id}/primary`), `Agora é o arquivo principal${material.variant ? ` de ${variantLabel(material.variant)}` : ""}.`);
  const archive = (on) =>
    act(on ? "archive" : "unarchive", () => api.post(`/materials/${material.id}/${on ? "archive" : "unarchive"}`), on ? "Material arquivado." : "Material restaurado.");
  const zip = () =>
    startZip(
      material.post?.format === "carrossel" ? { type: "carousel", materialId: material.id } : { type: "selection", materialIds: [material.id] },
      { label: material.title },
    );

  const selectVersion = (next) => {
    setVersionId(next);
    viewerRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  };

  // Comments "Com o cliente" belong to the version the client can see: the
  // released one, unless the team explicitly picked another version. The
  // thread uses one version for both tabs, so internal notes follow it.
  const releasedVersion = versions.find((v) => v.id === material.releasedVersionId) ?? null;
  const pickedVersion = versionId ? versions.find((v) => v.id === versionId) ?? null : null;
  const commentVersion = pickedVersion ?? releasedVersion ?? current;
  const commentUnreleased = Boolean(commentVersion) && !commentVersion.releasedAt;
  const commentNote = !commentVersion
    ? null
    : commentUnreleased
      ? released
        ? `Você está na versão ${commentVersion.number}, ainda não liberada: comentários “Com o cliente” feitos nela só ficam visíveis para o cliente quando ela for liberada.`
        : "Este material ainda não foi liberado: o cliente verá os comentários “Com o cliente” quando ele for liberado."
      : current && commentVersion.id !== current.id && !pickedVersion
        ? `Os comentários vão para a versão ${commentVersion.number}, a que o cliente vê. A versão ${current.number} ainda não foi liberada.`
        : null;

  // Main action follows the state of the material.
  const actions = [];
  if (archived) {
    if (perms.canArchive)
      actions.push(
        <Button key="restore" variant="primary" icon={ArchiveRestore} loading={busy === "unarchive"} onClick={() => archive(false)}>
          Restaurar
        </Button>,
      );
  } else {
    if (perms.canUploadVersion && material.kind !== "post")
      actions.push(
        <Button key="version" icon={CloudUpload} to={`/admin/biblioteca/enviar?materialId=${material.id}`}>
          {current && (current.status === "draft" || current.status === "internal_review") ? "Adicionar arquivos" : "Nova versão"}
        </Button>,
      );
    if (material.visibility === "draft" && perms.canEdit)
      actions.push(
        <Button key="submit" variant={perms.canRelease ? "secondary" : "primary"} icon={Send} loading={busy === "submit"} onClick={submit}>
          Enviar para revisão
        </Button>,
      );
    if (perms.canRelease && (!released || pendingVersion))
      actions.push(
        <Button key="release" variant="primary" icon={Send} onClick={() => setReleaseOpen(true)}>
          {pendingVersion ? `Liberar versão ${current.number}` : "Liberar para o cliente"}
        </Button>,
      );
  }

  const menu = [
    isLogo(material) && !material.isPrimary && perms.canEdit && !archived && { label: "Definir como principal", icon: Star, onSelect: makePrimary },
    { label: material.post?.format === "carrossel" ? "Baixar slides em ZIP" : "Baixar ZIP", icon: Download, onSelect: zip },
    { divider: true },
    { label: "Ver na biblioteca", icon: FolderOpen, to: `/admin/biblioteca?brandId=${material.brand?.id}&categoryId=${material.category?.id}` },
    { label: "Identidade da marca", icon: Palette, to: `/admin/marcas/${material.brand?.id}` },
    perms.canArchive && !archived && { divider: true },
    perms.canArchive && !archived && { label: "Arquivar", icon: Archive, danger: true, onSelect: () => setConfirm("archive") },
  ].filter(Boolean);

  return (
    <div className="lib-page lib-mat">
      <PageHeader
        back={{ to: `/admin/biblioteca?brandId=${material.brand?.id ?? ""}`, label: "Biblioteca" }}
        eyebrow={[material.client?.name, material.brand?.name].filter(Boolean).join(" · ")}
        title={material.title}
        meta={
          <>
            <span className="lib-mat__cat">
              {material.category?.name}
              {isLogo(material) && material.variant ? ` · ${variantLabel(material.variant)}` : ""}
            </span>
            <VersionTag number={material.version?.number ?? current?.number} />
            <MaterialBadges material={material} />
            {material.isPrimary && (
              <Badge tone="amber" icon={Star}>
                Principal
              </Badge>
            )}
          </>
        }
        actions={
          <>
            {actions}
            <Menu items={menu} label="Mais ações do material" />
          </>
        }
      />

      <div className="lib-cq">
      <div className="lib-mat__grid">
        <div className="lib-mat__main">
          <section className="lib-mat__viewer" ref={viewerRef} aria-label="Prévia">
            <MaterialViewer material={material} versionId={versionId ?? undefined} onVersionChange={setVersionId} />
          </section>

          {current && perms.canEdit && (current.status === "draft" || current.status === "internal_review") && (
            <SlideOrder version={current} material={material} onSaved={() => reload().catch(() => {})} />
          )}

          <Tabs
            aria-label="Conversa, versões e histórico"
            value={tab}
            onChange={setTab}
            className="lib-mat__tabs"
            items={[
              { value: "comments", label: "Comentários", icon: MessageSquare },
              { value: "versions", label: "Versões", icon: BadgeCheck, count: versions.length },
              { value: "history", label: "Histórico", icon: History },
            ]}
          >
            {tab === "comments" && (
              <>
                {commentNote && (
                  <p className="lib-mat__cnote" role="note">
                    <VersionTag number={commentVersion.number} />
                    <span>{commentNote}</span>
                  </p>
                )}
                <CommentThread
                  materialId={material.id}
                  versionId={commentVersion?.id}
                  versionNumber={commentVersion?.number}
                  internalVersionId={(pickedVersion ?? current)?.id}
                  internalVersionNumber={(pickedVersion ?? current)?.number}
                  subject="este material"
                  slides={sequenceLength(material, commentVersion)}
                  canInternal={Boolean(perms.canCommentInternal)}
                />
              </>
            )}
            {tab === "versions" && <VersionHistory material={material} onSelect={selectVersion} selectedId={versionId ?? current?.id} />}
            {tab === "history" && <HistoryTimeline materialId={material.id} />}
          </Tabs>
        </div>

        <aside className="lib-mat__side">
          <StatePanel material={material} current={current} />
          {deliverable && (perms.canEdit || perms.canRelease) && (
            <FinalFiles material={material} canDeliver={Boolean(perms.canRelease)} onChanged={() => reload().catch(() => {})} />
          )}
          <Toggles material={material} canEdit={perms.canEdit} onPatched={patch} />
          <DetailsForm material={material} canEdit={perms.canEdit && !archived} onSaved={() => reload().catch(() => {})} />
        </aside>
      </div>
      </div>

      <ReleaseDialog
        open={releaseOpen}
        materialIds={[material.id]}
        onClose={() => setReleaseOpen(false)}
        onReleased={() => reload().catch(() => {})}
      />
      <ConfirmDialog
        open={confirm === "archive"}
        tone="danger"
        title="Arquivar este material?"
        description="Ele sai da biblioteca e da área do cliente. Versões, comentários e histórico ficam guardados e você pode restaurar depois."
        confirmLabel="Arquivar"
        icon={Archive}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api.post(`/materials/${material.id}/archive`);
          toast.success("Material arquivado.");
          await reload().catch(() => {});
        }}
      />
    </div>
  );
}

function MaterialSkeleton() {
  return (
    <div className="lib-page" aria-busy="true">
      <span className="ui-sr-only" role="status">
        Carregando material
      </span>
      <Skeleton width={120} height={12} />
      <Skeleton width="42%" height={36} style={{ marginTop: 14 }} />
      <div className="lib-cq" style={{ marginTop: 28 }}>
        <div className="lib-mat__grid">
          <Skeleton height={440} radius={4} />
          <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
            <Skeleton height={150} radius={4} />
            <Skeleton height={320} radius={4} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- state

function StateRow({ label, children }) {
  return (
    <div className="lib-state__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function StatePanel({ material, current }) {
  const releasedVersion = (material.versions ?? []).find((v) => v.id === material.releasedVersionId);
  const approvedVersion = (material.versions ?? []).find((v) => v.id === material.approvedVersionId);
  return (
    <Panel title="Situação" className="lib-state" padding="md">
      <dl className="lib-state__list">
        <StateRow label="Visibilidade">
          {material.archivedAt ? <StatusBadge kind="archived" value /> : <StatusBadge kind="visibility" value={material.visibility} />}
          {material.releasedAt && <small>Liberado em {formatDate(material.releasedAt)}{releasedVersion ? ` · v${releasedVersion.number}` : ""}</small>}
        </StateRow>
        <StateRow label="Aprovação">
          {material.requiresApproval && material.approvalStatus !== "none" ? (
            <StatusBadge kind="approval" value={material.approvalStatus} />
          ) : material.requiresApproval ? (
            <span className="lib-state__muted">Pedida ao cliente quando for liberado</span>
          ) : (
            <span className="lib-state__muted">Não exige aprovação</span>
          )}
          {approvedVersion && (
            <small>
              v{approvedVersion.number} aprovada{approvedVersion.decidedBy?.name ? ` por ${approvedVersion.decidedBy.name}` : ""}
              {approvedVersion.decidedAt ? ` em ${formatDate(approvedVersion.decidedAt)}` : ""}
            </small>
          )}
        </StateRow>
        <StateRow label="Entrega">
          {material.deliveredAt ? <StatusBadge kind="delivered" value /> : <span className="lib-state__muted">Ainda não entregue</span>}
          {material.deliveredAt && <small>Em {formatDate(material.deliveredAt)}</small>}
        </StateRow>
        <StateRow label="Versão em trabalho">
          {current ? (
            <>
              <span className="lib-state__inline">
                <VersionTag number={current.number} /> <StatusBadge kind="version" value={current.status} size="sm" />
              </span>
              <small>
                {(current.files?.length ?? 0) === 1 ? "1 arquivo" : `${current.files?.length ?? 0} arquivos`} · {formatDate(current.createdAt)}
              </small>
            </>
          ) : (
            <span className="lib-state__muted">Sem versões</span>
          )}
        </StateRow>
      </dl>
    </Panel>
  );
}

// ---------------------------------------------------------------- toggles

function Toggles({ material, canEdit, onPatched }) {
  const toast = useToast();
  const [pending, setPending] = useState(null);
  const flip = async (key, value, message) => {
    setPending(key);
    const before = material[key];
    onPatched({ [key]: value });
    try {
      await api.patch(`/materials/${material.id}`, { [key]: value });
      toast.success(message);
    } catch (err) {
      onPatched({ [key]: before });
      toast.error(err.message);
    } finally {
      setPending(null);
    }
  };
  return (
    <Panel eyebrow="Permissões do cliente" className="lib-toggles" padding="md">
      <div className="lib-form__switches">
        <Switch
          label="Download disponível"
          description={material.downloadEnabled ? "O cliente pode baixar os arquivos liberados." : "O cliente só visualiza a prévia."}
          checked={Boolean(material.downloadEnabled)}
          disabled={!canEdit || pending === "downloadEnabled"}
          onCheckedChange={(on) => flip("downloadEnabled", on, on ? "Download ativado para o cliente." : "Download desativado para o cliente.")}
        />
        <Switch
          label="Editável incluído no serviço"
          description="Sem isso, arquivos editáveis ficam só com a equipe."
          checked={Boolean(material.editableIncluded)}
          disabled={!canEdit || pending === "editableIncluded"}
          onCheckedChange={(on) => flip("editableIncluded", on, on ? "Editáveis passam a aparecer para o cliente." : "Editáveis ficam só com a equipe.")}
        />
        <Switch
          label="Exige aprovação"
          description="Cada nova versão liberada volta a aguardar aprovação."
          checked={Boolean(material.requiresApproval)}
          disabled={!canEdit || pending === "requiresApproval"}
          onCheckedChange={(on) => flip("requiresApproval", on, on ? "Este material passa a exigir aprovação." : "Este material não exige mais aprovação.")}
        />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- details

function DetailsForm({ material, canEdit, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(() => formFrom(material));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const baseline = useMemo(() => JSON.stringify(formFrom(material)), [material]);
  const categories = useCategories();
  const projects = useProjects(material.brand?.id ?? null);
  const owners = useOwners(form.projectId || material.project?.id || null);

  // Follow server updates while the form is untouched.
  const lastBaseline = useRef(baseline);
  useEffect(() => {
    if (baseline !== lastBaseline.current) {
      setForm((current) => (JSON.stringify(current) === lastBaseline.current ? formFrom(material) : current));
      lastBaseline.current = baseline;
    }
  }, [baseline, material]);

  const dirty = JSON.stringify(form) !== baseline;
  const category = categories.items.find((c) => c.id === form.categoryId) ?? material.category;
  const logo = category?.slug === "logotipo";
  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  };

  const save = async (event) => {
    event.preventDefault();
    if (!form.title.trim()) {
      setErrors({ title: "Dê um título ao material." });
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/materials/${material.id}`, {
        title: form.title.trim(),
        description: form.description.trim() || null,
        tags: form.tags,
        categoryId: form.categoryId,
        projectId: form.projectId || null,
        ownerId: form.ownerId || null,
        variant: logo ? form.variant || null : null,
        previewBg: form.previewBg,
        dueDate: form.dueDate || null,
        internalNotes: form.internalNotes.trim() || null,
      });
      setSaved(true);
      toast.success("Alterações salvas.");
      onSaved?.();
      setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      if (err.code === "validation" && err.fields) setErrors(err.fields);
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel eyebrow="Detalhes" title="Informações do material" className="lib-details" padding="md">
      <form className="lib-form" onSubmit={save} noValidate>
        <fieldset disabled={!canEdit} className="lib-form__set">
          <Field label="Título" required error={errors.title}>
            <Input value={form.title} maxLength={200} onValueChange={(title) => set({ title })} />
          </Field>
          <Field label="Descrição" optional>
            <Textarea rows={3} autoGrow value={form.description} maxLength={4000} onValueChange={(description) => set({ description })} />
          </Field>
          <Field label="Etiquetas" optional>
            <TagInput value={form.tags} max={30} onChange={(tags) => set({ tags })} disabled={!canEdit} />
          </Field>
          <div className="lib-form__two">
            <Field label="Categoria" error={errors.categoryId}>
              <Select value={form.categoryId} options={categories.items.filter((c) => !c.archivedAt || c.id === form.categoryId).map((c) => ({ value: c.id, label: c.name }))} onValueChange={(categoryId) => set({ categoryId })} />
            </Field>
            <Field label="Projeto" error={errors.projectId}>
              <Select
                placeholder="Sem projeto"
                value={form.projectId}
                options={[
                  ...projects.items.map((p) => ({ value: p.id, label: p.name })),
                  ...(material.project && !projects.items.some((p) => p.id === material.project.id)
                    ? [{ value: material.project.id, label: material.project.name ?? "Projeto atual" }]
                    : []),
                ]}
                onValueChange={(projectId) => set({ projectId })}
              />
            </Field>
          </div>
          <div className="lib-form__two">
            <Field label="Responsável" error={errors.ownerId}>
              <Select
                placeholder="Sem responsável"
                value={form.ownerId}
                options={[
                  ...owners.items.map((p) => ({ value: p.id, label: p.name })),
                  ...(material.owner?.id && !owners.items.some((p) => p.id === material.owner.id)
                    ? [{ value: material.owner.id, label: material.owner.name }]
                    : []),
                ]}
                onValueChange={(ownerId) => set({ ownerId })}
              />
            </Field>
            <Field label="Prazo" optional error={errors.dueDate}>
              <DateInput value={form.dueDate} onValueChange={(dueDate) => set({ dueDate })} />
            </Field>
          </div>
          {logo && (
            <Field label="Variante da logo" error={errors.variant}>
              <Select placeholder="Sem variante" value={form.variant} options={labelOptions("variant")} onValueChange={(variant) => set({ variant })} />
            </Field>
          )}
          {category?.area === "identity" && (
            <Field label="Fundo da prévia" hint="Como a logo aparece em Minha marca.">
              <Segmented aria-label="Fundo da prévia" size="sm" value={form.previewBg} onChange={(previewBg) => set({ previewBg })} options={PREVIEW_BG} />
            </Field>
          )}
          <div className="lib-internal">
            <p className="lib-internal__label">
              <Lock size={14} strokeWidth={1.5} aria-hidden="true" />
              Somente equipe
            </p>
            <Field label="Notas internas" optional hint="Nunca aparecem para o cliente.">
              <Textarea rows={3} autoGrow value={form.internalNotes} maxLength={8000} onValueChange={(internalNotes) => set({ internalNotes })} />
            </Field>
          </div>
        </fieldset>
        {canEdit && (
          <div className="lib-form__foot">
            {saved && !dirty ? (
              <span className="lib-saved" role="status">
                <CheckDraw size={20} /> Salvo
              </span>
            ) : (
              <span className="lib-form__dirty">{dirty ? "Alterações não salvas" : ""}</span>
            )}
            <div className="lib-form__buttons">
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => setForm(formFrom(material))} disabled={saving}>
                  Descartar
                </Button>
              )}
              <Button type="submit" variant="primary" size="sm" icon={Pencil} loading={saving} disabled={!dirty}>
                Salvar
              </Button>
            </div>
          </div>
        )}
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------- slide order

function SlideOrder({ version, material, onSaved }) {
  const toast = useToast();
  const originals = useMemo(() => (version.files ?? []).filter((f) => f.role === "original").sort((a, b) => a.position - b.position), [version.files]);
  const [order, setOrder] = useState(() => originals.map((f) => f.id));
  const [state, setState] = useState("idle");
  const seq = useRef(0);
  const key = originals.map((f) => f.id).join(",");
  useEffect(() => setOrder(key ? key.split(",") : []), [key]);
  const byId = useMemo(() => new Map(originals.map((f) => [f.id, f])), [originals]);

  const commit = async (next) => {
    const previous = order;
    setOrder(next);
    const mine = ++seq.current;
    setState("saving");
    try {
      await api.patch(`/versions/${version.id}`, { files: next.map((fileId, index) => ({ id: fileId, position: index + 1, role: "original" })) });
      if (mine === seq.current) {
        setState("saved");
        onSaved?.();
      }
    } catch (err) {
      if (mine === seq.current) {
        setOrder(previous);
        setState("idle");
        toast.error(err.message || "Não foi possível salvar a ordem.");
      }
    }
  };
  const sort = useDragSort({ ids: order, labelOf: (fid) => `Slide ${order.indexOf(fid) + 1}`, onReorder: commit });
  if (originals.length < 2) return null;

  return (
    <section className="lib-slides" aria-labelledby="lib-slides-title">
      <div className="lib-slides__head">
        <h2 id="lib-slides-title" className="lib-mini-title">
          Ordem dos slides · versão {version.number}
        </h2>
        <span className="lib-slides__state" role="status">
          {state === "saving" ? "Salvando…" : state === "saved" ? "Ordem salva" : "Vale para a prévia e para o ZIP"}
        </span>
      </div>
      <ol className="lib-slides__list">
        {sort.order.map((fileId, index) => {
          const file = byId.get(fileId);
          if (!file) return null;
          return (
            <li key={fileId} className="lib-slides__item" {...sort.itemProps(fileId)}>
              <div className="lib-slides__thumb">
                <Thumb file={file} aspect={file.width && file.height ? undefined : "4/5"} bg={artBackground(material)} alt="" />
                <span className="lib-slides__n">{index + 1}</span>
              </div>
              <div className="lib-slides__ctrl">
                <Handle {...sort.handleProps(fileId)} />
                <MoveButtons axis="x" index={index} count={sort.order.length} label={`o slide ${index + 1}`} onMove={(delta) => sort.move(fileId, delta)} />
              </div>
            </li>
          );
        })}
      </ol>
      <Live text={sort.announcement} />
    </section>
  );
}

// ---------------------------------------------------------------- final files

function FinalFiles({ material, canDeliver, onChanged }) {
  const toast = useToast();
  const maxBytes = useUploadLimit();
  const queue = useUploadQueue({ defaultRole: "final", maxBytes });
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState(null); // "finals" | "originals"
  // Finals belong to the released version; new ones wait for "Entregar".
  const targetId = material.releasedVersionId;
  const target = (material.versions ?? []).find((v) => v.id === targetId);
  const finals = (target?.files ?? []).filter((f) => f.role === "final");
  const originals = (target?.files ?? []).filter((f) => f.role === "original");
  const waiting = finals.filter((f) => f.published === false);
  const canSend = finals.length > 0 && (waiting.length > 0 || !material.deliveredAt);
  // Materials delivered as their original files (no separate finals) can be
  // recorded as delivered; the server flag wins when it is present.
  const originalsDeliverable =
    typeof material.deliverableWithoutFinals === "boolean" ? material.deliverableWithoutFinals : originals.length > 0;
  const canMarkDelivered = !material.deliveredAt && finals.length === 0 && originalsDeliverable;
  const ready = queue.items.filter((item) => item.status === "done" && !item.saved);
  const stats = queueStats(queue.items);

  const attach = async () => {
    setSaving(true);
    try {
      await api.post(`/versions/${targetId}/files`, { files: ready.map((item) => ({ uploadId: item.upload.id, role: "final" })) });
      queue.forget(ready.map((item) => item.key));
      toast.success(ready.length === 1 ? "Arquivo final adicionado." : `${ready.length} arquivos finais adicionados.`);
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      eyebrow={material.approvalStatus === "approved" ? `Versão ${target?.number ?? ""} aprovada` : "Entrega"}
      title="Arquivos finais"
      className="lib-finals"
      padding="md"
    >
      <p className="lib-finals__lead">
        {material.deliveredAt
          ? `Entregue em ${formatDate(material.deliveredAt)}. Você ainda pode acrescentar arquivos.`
          : "Exportações finais em alta qualidade, separadas da prévia e do original apresentado."}
      </p>
      {finals.length > 0 ? (
        <ul className="lib-finals__list">
          {finals.map((file) => (
            <li key={file.id}>
              <FileMeta
                file={file}
                version={target?.number}
                layout="inline"
                extra={file.published === false ? <Badge size="sm" tone="amber">Aguardando entrega</Badge> : null}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="lib-state__muted">Nenhum arquivo final ainda.</p>
      )}
      {targetId && (
        <>
          <Dropzone
            compact
            accept={ACCEPT}
            maxSizeBytes={maxBytes ?? undefined}
            title="Adicionar arquivos finais"
            description="PNG, SVG, PDF, MP4… no tamanho de entrega."
            buttonLabel="Escolher"
            icon={<Upload size={20} strokeWidth={1.3} />}
            onFiles={(files) => queue.add(files, { role: "final" })}
            onReject={(rejected) => queue.add(rejected.map((entry) => entry.file), { role: "final" })}
          />
          <FileQueue queue={queue} label="Arquivos finais em envio" />
          {ready.length > 0 && (
            <Button size="sm" icon={Upload} loading={saving} disabled={stats.uploading + stats.queued > 0} onClick={attach}>
              Salvar {ready.length === 1 ? "arquivo final" : `${ready.length} arquivos finais`}
            </Button>
          )}
        </>
      )}
      {canDeliver ? (
        <div className="lib-finals__deliver">
          <Button variant="primary" icon={PackageCheck} disabled={!canSend || ready.length > 0} onClick={() => setDialog("finals")} block>
            {material.deliveredAt && waiting.length
              ? `Entregar ${waiting.length === 1 ? "o novo arquivo" : `${waiting.length} novos arquivos`}`
              : "Entregar arquivos finais"}
          </Button>
          <small>
            {!finals.length
              ? canMarkDelivered
                ? "Sem arquivos finais separados? Registre a entrega dos originais abaixo."
                : "Adicione ao menos um arquivo final para entregar."
              : canSend
                ? "Você revisa o destino e o aviso ao cliente antes de entregar."
                : "Tudo entregue. Novos arquivos finais aparecem aqui até a próxima entrega."}
          </small>
          {canMarkDelivered && (
            <div className="lib-finals__originals">
              <p>
                Entregue como os arquivos originais da versão {target?.number ?? ""}? O cliente já vê esses arquivos; a entrega fica
                registrada e o material sai da lista de entregas pendentes.
              </p>
              <Button size="sm" icon={PackageCheck} disabled={ready.length > 0} onClick={() => setDialog("originals")}>
                Marcar como entregue
              </Button>
            </div>
          )}
        </div>
      ) : (
        (finals.length > 0 || canMarkDelivered) && (
          <small className="lib-state__muted">Um gestor registra a entrega ao cliente.</small>
        )
      )}
      <DeliverDialog
        open={Boolean(dialog)}
        material={material}
        mode={dialog ?? "finals"}
        onClose={() => setDialog(null)}
        onDelivered={() => onChanged?.()}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------- history

const KIND_ICONS = {
  release: Send,
  approval: BadgeCheck,
  version: CloudUpload,
  download: Download,
  comment: MessageSquare,
  archive: Archive,
  delivery: PackageCheck,
  edit: Pencil,
};

function HistoryTimeline({ materialId }) {
  const { data, error, loading, reload } = useApi(`/materials/${materialId}/history`);
  const [limit, setLimit] = useState(30);
  const events = useMemo(() => historyEvents(data), [data]);
  if (loading) return <Skeleton height={160} radius={4} />;
  if (error) return <ErrorState error={error} onRetry={reload} compact />;
  if (!events.length)
    return <EmptyState compact icon={History} title="Sem eventos ainda" description="Envios, liberações, aprovações e downloads aparecem aqui." />;
  return (
    <div className="lib-timeline">
      <ol>
        {events.slice(0, limit).map((event, index) => {
          const Icon = KIND_ICONS[event.kind] ?? Eye;
          return (
            <li key={event.id} className={`lib-timeline__item is-${event.kind} ui-enter`} style={{ "--i": Math.min(index, 8) }}>
              <span className="lib-timeline__dot" aria-hidden="true">
                <Icon size={14} strokeWidth={1.5} />
              </span>
              <div className="lib-timeline__body">
                <p className="lib-timeline__text">{event.summary}</p>
                <p className="lib-timeline__meta">
                  <time dateTime={event.at} title={formatDateTime(event.at)}>
                    {formatRelative(event.at)}
                  </time>
                  {event.kind === "download" && <Badge size="sm">Download — não equivale a aprovação</Badge>}
                  {event.visibility === "client" && (
                    <Badge size="sm" tone="teal" icon={Eye}>
                      Visível ao cliente
                    </Badge>
                  )}
                  {event.visibility === "internal" && event.kind !== "download" && (
                    <Badge size="sm" icon={EyeOff}>
                      Interno
                    </Badge>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {events.length > limit && (
        <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + 30)}>
          Mostrar mais ({events.length - limit})
        </Button>
      )}
      <p className="lib-timeline__foot">
        Registro completo em <Link to={`/admin/historico?materialId=${materialId}`}>Histórico</Link>.
      </p>
    </div>
  );
}
