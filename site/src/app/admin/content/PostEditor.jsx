import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ImagePlus, Lock, Save } from "lucide-react";
import {
  Button,
  DateInput,
  Dropzone,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  Textarea,
  plural,
  useApi,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useUploadLimits } from "../../api/upload.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import { BrandSelect, CampaignField, CaptionField, FORMAT_OPTIONS, NETWORK_OPTIONS } from "./fields.jsx";
import { SlideList, useUploadQueue } from "./media.jsx";
import { ownerOptions } from "./panels.jsx";
import "../../shared/review/review.css";

const MEDIA_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.svg,.mp4,.mov,.webm,.m4v,.pdf";
const COVER_ACCEPT = ".png,.jpg,.jpeg,.webp";

// Projects that are still being worked on (a post normally belongs to one).
const OPEN_PROJECT = new Set(["planning", "in_progress", "in_review"]);

// The brand's project to preselect: its only open project, or its only
// project; none when there is a real choice to make.
function defaultProject(projects, brandId) {
  const own = projects.filter((project) => project.brandId === brandId);
  const open = own.filter((project) => OPEN_PROJECT.has(project.status));
  if (open.length === 1) return open[0].id;
  if (own.length === 1) return own[0].id;
  return "";
}

const EMPTY = {
  brandId: "",
  projectId: "",
  campaignId: "",
  network: "instagram",
  format: "estatico",
  plannedDate: "",
  plannedTime: "",
  title: "",
  caption: "",
  hashtags: "",
  notes: "",
  internalNotes: "",
  ownerId: "",
};

export default function PostEditor() {
  usePageTitle("Novo post", { crumbs: [{ label: "Conteúdo e calendário", to: "/admin/conteudo" }, { label: "Novo post" }] });
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const toast = useToast();
  const { user } = useAuth();
  const options = useApi("/content/options");
  const [form, setForm] = useState(() => ({
    ...EMPTY,
    brandId: search.get("brandId") ?? "",
    projectId: search.get("projectId") ?? "",
    plannedDate: search.get("date") ?? "",
  }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [campaigns, setCampaigns] = useState([]);
  const media = useUploadQueue();
  const cover = useUploadQueue();
  const limits = useUploadLimits();
  // Opened with ?projectId: that project wins over the preselection.
  const projectTouched = useRef(Boolean(search.get("projectId")));

  useEffect(() => {
    if (options.data?.campaigns) setCampaigns(options.data.campaigns);
  }, [options.data]);
  useEffect(() => {
    if (!form.ownerId && user?.id && !form.brandId) setForm((f) => ({ ...f, ownerId: user.id }));
  }, [user, form.ownerId, form.brandId]);

  const allProjects = options.data?.projects ?? [];
  const owners = options.data?.owners ?? [];
  const set = (key) => (value) => {
    if (key === "projectId") projectTouched.current = true;
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "brandId") {
        // a new brand starts from its own project (the old pick belongs to the old brand)
        next.projectId = defaultProject(allProjects, value);
        next.campaignId = "";
        // the responsible person must work on the new brand too
        const owner = owners.find((o) => o.id === current.ownerId);
        if (owner && owner.brandIds != null && !owner.brandIds.includes(value)) next.ownerId = "";
      }
      return next;
    });
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  // Opened with ?brandId (no project): preselect once the options arrive.
  useEffect(() => {
    if (!options.data || projectTouched.current) return;
    setForm((current) =>
      current.brandId && !current.projectId ? { ...current, projectId: defaultProject(options.data.projects ?? [], current.brandId) } : current,
    );
  }, [options.data]);

  const brands = options.data?.brands ?? [];
  const projects = useMemo(
    () => (options.data?.projects ?? []).filter((project) => project.brandId === form.brandId),
    [options.data, form.brandId],
  );
  const hasVideo = media.items.some((item) => item.kind === "video") || ["reels", "video"].includes(form.format);
  const designer = user?.role === "designer";

  const save = async () => {
    const local = {};
    if (!form.brandId) local.brandId = "Escolha a marca.";
    if (!form.title.trim()) local.title = "Dê um título interno ao post.";
    if (designer && !form.projectId) local.projectId = "Selecione um dos seus projetos.";
    if (Object.keys(local).length) {
      setErrors(local);
      toast.error("Revise os campos destacados.");
      return;
    }
    if (media.busy || cover.busy) {
      toast.info("Aguarde o fim dos envios para salvar.");
      return;
    }
    setSaving(true);
    try {
      const files = [
        ...media.ready.map((item, index) => ({ uploadId: item.upload.id, role: "original", position: index + 1 })),
        ...(hasVideo ? cover.ready.slice(0, 1).map((item) => ({ uploadId: item.upload.id, role: "cover", position: 1 })) : []),
      ];
      const { material } = await api.post("/content", {
        brandId: form.brandId,
        projectId: form.projectId || undefined,
        campaignId: form.campaignId || undefined,
        title: form.title.trim(),
        network: form.network,
        format: form.format,
        plannedDate: form.plannedDate || undefined,
        plannedTime: form.plannedTime || undefined,
        caption: form.caption,
        hashtags: form.hashtags,
        notes: form.notes,
        internalNotes: form.internalNotes,
        ownerId: form.ownerId || undefined,
        files,
      });
      media.clear();
      cover.clear();
      toast.success({ title: "Rascunho salvo", message: "O post começa privado para a equipe até ser liberado ao cliente." });
      navigate(`/admin/conteudo/${material.id}`, { replace: true });
    } catch (err) {
      setSaving(false);
      if (err.fields) {
        const mapped = {};
        for (const [key, message] of Object.entries(err.fields)) mapped[key.startsWith("files") ? "files" : key] = message;
        setErrors(mapped);
      }
      toast.error(err);
    }
  };

  if (options.loading)
    return (
      <div className="cnt-page" aria-busy="true">
        <Skeleton width={140} height={12} />
        <Skeleton width="40%" height={34} />
        <Skeleton height={320} radius={4} />
      </div>
    );
  if (options.error && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />;

  const pendingNote = media.busy || cover.busy
    ? "Aguardando o fim dos envios…"
    : media.failed || cover.failed
      ? `${plural(media.failed + cover.failed, "arquivo falhou", "arquivos falharam")}: tente de novo ou remova antes de salvar.`
      : media.ready.length
        ? `${plural(media.ready.length, "arquivo pronto", "arquivos prontos")} para o rascunho.`
        : "Você pode salvar sem arquivos e enviar as artes depois.";

  return (
    <div className="cnt-page">
      <PageHeader
        back={{ to: "/admin/conteudo", label: "Conteúdo e calendário" }}
        eyebrow="Conteúdo"
        title="Novo"
        accent="post"
        description="Monte a publicação como rascunho. Ela fica visível só para a equipe até ser liberada ao cliente."
      />

      <div className="cnt-editor">
        <div className="cnt-editor__col">
          <Panel eyebrow="Destino" title="Cliente, marca e projeto" padding="md">
            <div className="cnt-fields">
              <Field label="Marca" required error={errors.brandId} className="is-wide">
                <BrandSelect brands={brands} value={form.brandId} onValueChange={set("brandId")} />
              </Field>
              <Field
                label="Projeto ou serviço"
                required={designer}
                optional={!designer}
                error={errors.projectId}
                hint={
                  designer
                    ? "Designers salvam posts dentro de um dos seus projetos."
                    : form.brandId && !form.projectId
                      ? projects.length
                        ? "Sem projeto, o post não fica ligado a um serviço contratado. Escolha o projeto sempre que houver."
                        : "Esta marca ainda não tem projeto: o post fica sem serviço vinculado até ser atribuído a um."
                      : undefined
                }
              >
                <Select
                  value={form.projectId}
                  onValueChange={set("projectId")}
                  disabled={!form.brandId}
                  options={[
                    { value: "", label: form.brandId ? "Sem projeto vinculado" : "Escolha a marca primeiro" },
                    ...projects.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
              </Field>
              <CampaignField
                brandId={form.brandId}
                projectId={form.projectId}
                value={form.campaignId}
                onChange={set("campaignId")}
                campaigns={campaigns}
                onCreated={(campaign) => setCampaigns((list) => [...list, campaign])}
                error={errors.campaignId}
              />
              <Field
                label="Responsável"
                optional
                error={errors.ownerId}
                className="is-wide"
                hint="Quem já trabalha com este cliente. Sem escolha, fica com você."
              >
                <Select
                  value={form.ownerId}
                  onValueChange={set("ownerId")}
                  placeholder={form.brandId ? "Você" : "Escolha a marca primeiro"}
                  disabled={!form.brandId}
                  options={ownerOptions(owners, form.brandId)}
                />
              </Field>
            </div>
          </Panel>

          <Panel eyebrow="Publicação" title="Rede, formato e data" padding="md">
            <div className="cnt-fields">
              <Field label="Título interno" required error={errors.title} className="is-wide" hint="Ajuda a equipe e o cliente a encontrar o post. Não é publicado.">
                <Input value={form.title} onValueChange={set("title")} maxLength={200} placeholder="Ex.: Carrossel lançamento do cartão" />
              </Field>
              <Field label="Rede social" required error={errors.network}>
                <Select value={form.network} onValueChange={set("network")} options={NETWORK_OPTIONS} />
              </Field>
              <Field label="Formato" required error={errors.format}>
                <Select value={form.format} onValueChange={set("format")} options={FORMAT_OPTIONS} />
              </Field>
              <Field label="Data prevista" optional error={errors.plannedDate}>
                <DateInput value={form.plannedDate} onValueChange={set("plannedDate")} />
              </Field>
              <Field label="Horário" optional error={errors.plannedTime}>
                <DateInput type="time" value={form.plannedTime} onValueChange={set("plannedTime")} />
              </Field>
            </div>
          </Panel>

          <Panel
            eyebrow="Mídia"
            title={form.format === "carrossel" ? "Slides do carrossel" : "Artes ou vídeo"}
            description="Cada arquivo é enviado com o progresso real. Arraste pela alça ou use as setas para ordenar."
            padding="md"
          >
            <div className="ui-stack">
              <Dropzone
                accept={MEDIA_ACCEPT}
                maxSizeBytes={limits?.maxUploadBytes}
                onFiles={(files) => media.add(files)}
                onReject={(list) => toast.error(`${list[0].file.name}: ${list[0].reason}`)}
                title="Arraste as artes para cá"
                description={`Imagens (PNG, JPG, WEBP, SVG), vídeos (MP4, MOV, WEBM) ou PDF${limits?.maxUploadLabel ? `, até ${limits.maxUploadLabel} cada` : ""}. A ordem abaixo é a ordem dos slides.`}
                compact={media.items.length > 0}
              />
              {errors.files && (
                <p className="ui-inline-error" role="alert">
                  {errors.files}
                </p>
              )}
              <SlideList items={media.items} onMove={media.move} onRemove={media.remove} onRetry={media.retry} />
              {hasVideo && (
                <div className="ui-stack" style={{ "--gap": "10px" }}>
                  <h3 className="rv-section-title">Capa do vídeo</h3>
                  <p className="ui-meta">Imagem mostrada antes do play e na grade do cliente. Sem capa, usamos um quadro do vídeo quando disponível.</p>
                  {cover.items.length === 0 ? (
                    <Dropzone
                      accept={COVER_ACCEPT}
                      maxSizeBytes={limits?.maxUploadBytes}
                      multiple={false}
                      compact
                      icon={<ImagePlus size={20} strokeWidth={1.3} />}
                      onFiles={(files) => cover.add(files.slice(0, 1), { replace: true })}
                      onReject={(list) => toast.error(`${list[0].file.name}: ${list[0].reason}`)}
                      title="Enviar capa"
                      description="PNG, JPG ou WEBP."
                      buttonLabel="Escolher imagem"
                    />
                  ) : (
                    <SlideList items={cover.items} onMove={cover.move} onRemove={cover.remove} onRetry={cover.retry} numbered={false} noun="capa" />
                  )}
                </div>
              )}
            </div>
          </Panel>
        </div>

        <div className="cnt-editor__col">
          <Panel eyebrow="Texto" title="Legenda e observações" padding="md">
            <div className="ui-stack">
              <CaptionField value={form.caption} onChange={set("caption")} network={form.network} error={errors.caption} />
              <Field label="Hashtags" optional error={errors.hashtags} hint="Separe por espaço. O # é adicionado se faltar.">
                <Textarea value={form.hashtags} onValueChange={set("hashtags")} rows={2} autoGrow maxLength={2000} placeholder="#fintech #marca" />
              </Field>
              <Field label="Observações para o cliente" optional error={errors.notes} hint="Aparecem para o cliente junto com a prévia.">
                <Textarea value={form.notes} onValueChange={set("notes")} rows={3} autoGrow maxLength={4000} />
              </Field>
            </div>
          </Panel>

          <div className="cnt-internal">
            <p className="cnt-internal__flag">
              <Lock size={14} strokeWidth={1.5} aria-hidden="true" />
              Somente equipe
            </p>
            <Field label="Notas internas" optional error={errors.internalNotes} hint="Nunca aparecem para o cliente.">
              <Textarea value={form.internalNotes} onValueChange={set("internalNotes")} rows={4} autoGrow maxLength={4000} placeholder="Referências, pendências, combinados com a equipe…" />
            </Field>
          </div>
        </div>
      </div>

      <div className="cnt-savebar">
        <p className="cnt-savebar__note" aria-live="polite">
          {pendingNote}
        </p>
        <div className="cnt-savebar__actions">
          <Button variant="ghost" to="/admin/conteudo">
            Cancelar
          </Button>
          <Button variant="primary" icon={Save} loading={saving} disabled={media.busy || cover.busy} onClick={save}>
            Salvar como rascunho
          </Button>
        </div>
      </div>
    </div>
  );
}
