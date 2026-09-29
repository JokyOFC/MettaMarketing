import { useEffect, useMemo, useState } from "react";
import { CalendarCheck, CircleAlert, ExternalLink, Lock, Megaphone, PackageCheck, RotateCcw, Save, Upload } from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DateInput,
  Drawer,
  Dropzone,
  Field,
  FileMeta,
  Input,
  Modal,
  Panel,
  Segmented,
  Select,
  StatusBadge,
  Textarea,
  formatDate,
  formatDateTime,
  formatTime,
  isoDate,
  plural,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useUploadLimits } from "../../api/upload.js";
import { useAuth } from "../../auth/index.js";
import { groupFiles, versionOf } from "../../shared/review/util.js";
import { CampaignField, CaptionField, FORMAT_OPTIONS, NETWORK_OPTIONS } from "./fields.jsx";
import { SlideList, useUploadQueue } from "./media.jsx";

const MEDIA_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.svg,.mp4,.mov,.webm,.m4v,.pdf";
// Final exports: the same media plus a packaged set (.zip) when the team sends one.
const FINAL_ACCEPT = `${MEDIA_ACCEPT},.zip`;
const toIso = (date, time) => (date ? new Date(`${date}T${time || "12:00"}:00`).toISOString() : undefined);
export const isEditableVersion = (version) => version && (version.status === "draft" || version.status === "internal_review");

function InlineError({ error }) {
  if (!error) return null;
  const message = error.fields ? Object.values(error.fields)[0] : error.message;
  return (
    <p className="ui-inline-error" role="alert">
      <CircleAlert size={16} strokeWidth={1.4} aria-hidden="true" />
      <span>{message || "Não foi possível concluir. Tente de novo."}</span>
    </p>
  );
}

// ---------------------------------------------------------------- publication

// Manual publication controls. Nothing here is automatic: scheduling and
// publishing are recorded with who and when, and "published" needs an
// explicit confirmation.
export function PublicationPanel({ material, onChange }) {
  const toast = useToast();
  const { can } = useAuth();
  const post = material.post ?? {};
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const allowed = can("content.publication");
  const released = material.visibility === "released";
  const status = post.publicationStatus ?? "not_scheduled";

  const open = (kind) => {
    setError(null);
    const now = new Date();
    if (kind === "schedule") setForm({ date: post.plannedDate || isoDate(now), time: post.plannedTime || "" });
    if (kind === "publish") setForm({ confirm: false, url: post.publishedUrl || "", date: isoDate(now), time: formatTime(now) });
    setDialog(kind);
  };
  const submit = async (body, message) => {
    setBusy(true);
    setError(null);
    try {
      const { material: next } = await api.patch(`/content/${material.id}/publication`, body);
      onChange(next);
      toast.success(message);
      setDialog(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel eyebrow="Publicação" title="Agendamento e publicação" padding="md">
      <div className="cnt-pub">
        <div className="cnt-pub__state">
          <StatusBadge kind="publication" value={status} />
          {status === "scheduled" && (
            <span>
              Agendado para {formatDateTime(post.scheduledAt)}
              {post.scheduledBy?.name ? `, marcado por ${post.scheduledBy.name}` : ""}.
            </span>
          )}
          {status === "published" && (
            <span>
              Publicado em {formatDateTime(post.publishedAt)}
              {post.publishedBy?.name ? `, registrado por ${post.publishedBy.name}` : ""}.
            </span>
          )}
          {status === "published" && post.publishedUrl && (
            <a className="ui-link" href={post.publishedUrl} target="_blank" rel="noopener noreferrer">
              Abrir publicação <ExternalLink size={12} strokeWidth={1.4} aria-hidden="true" />
            </a>
          )}
          {status === "not_scheduled" && <span>Sem integração com as redes: a equipe registra aqui o agendamento e a publicação.</span>}
        </div>
        {!released ? (
          <p className="cnt-pub__warn">
            <Lock size={14} strokeWidth={1.4} aria-hidden="true" />
            Libere o post ao cliente para registrar agendamento ou publicação.
          </p>
        ) : material.approvalStatus !== "approved" && material.approvalStatus !== "none" ? (
          <p className="cnt-pub__warn">
            <CircleAlert size={14} strokeWidth={1.4} aria-hidden="true" />
            O cliente ainda não aprovou a versão em revisão. Agendar ou publicar não muda a aprovação.
          </p>
        ) : null}
        {allowed ? (
          <div className="cnt-pub__actions">
            {status !== "published" && (
              <Button size="sm" icon={CalendarCheck} disabled={!released} onClick={() => open("schedule")}>
                {status === "scheduled" ? "Alterar agendamento" : "Marcar como agendado"}
              </Button>
            )}
            <Button size="sm" variant={status === "scheduled" ? "primary" : "secondary"} icon={Megaphone} disabled={!released} onClick={() => open("publish")}>
              {status === "published" ? "Corrigir registro" : "Marcar como publicado manualmente"}
            </Button>
            {status !== "not_scheduled" && (
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => open("reset")}>
                Voltar para não agendado
              </Button>
            )}
          </div>
        ) : (
          <p className="ui-meta">Somente a gestão registra agendamento e publicação.</p>
        )}
      </div>

      <Modal
        open={dialog === "schedule"}
        onClose={() => !busy && setDialog(null)}
        size="sm"
        title="Marcar como agendado"
        description="Registre quando o post vai ao ar. A aprovação do cliente continua separada."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                submit({ status: "scheduled", scheduledAt: toIso(form.date, form.time) }, "Post marcado como agendado.")
              }
            >
              Marcar como agendado
            </Button>
          </>
        }
      >
        <div className="cnt-fields">
          <Field label="Data" required>
            <DateInput value={form.date ?? ""} onValueChange={(date) => setForm((f) => ({ ...f, date }))} />
          </Field>
          <Field label="Horário" optional>
            <DateInput type="time" value={form.time ?? ""} onValueChange={(time) => setForm((f) => ({ ...f, time }))} />
          </Field>
        </div>
        <InlineError error={error} />
      </Modal>

      <Modal
        open={dialog === "publish"}
        onClose={() => !busy && setDialog(null)}
        size="sm"
        title="Marcar como publicado"
        description="Use depois de publicar na rede social. A plataforma não publica nem confirma sozinha."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!form.confirm}
              onClick={() =>
                submit(
                  {
                    status: "published",
                    confirm: true,
                    publishedUrl: form.url?.trim() || null,
                    publishedAt: toIso(form.date, form.time),
                  },
                  "Publicação registrada.",
                )
              }
            >
              Registrar publicação
            </Button>
          </>
        }
      >
        <div className="ui-stack">
          <div className="cnt-fields">
            <Field label="Publicado em" required>
              <DateInput value={form.date ?? ""} max={isoDate(new Date())} onValueChange={(date) => setForm((f) => ({ ...f, date }))} />
            </Field>
            <Field label="Horário" optional>
              <DateInput type="time" value={form.time ?? ""} onValueChange={(time) => setForm((f) => ({ ...f, time }))} />
            </Field>
          </div>
          <Field label="Link da publicação" optional error={error?.fields?.publishedUrl}>
            <Input type="url" inputMode="url" placeholder="https://" value={form.url ?? ""} onValueChange={(url) => setForm((f) => ({ ...f, url }))} />
          </Field>
          <Checkbox
            checked={Boolean(form.confirm)}
            onCheckedChange={(confirm) => setForm((f) => ({ ...f, confirm }))}
            label="Confirmo que este post foi publicado manualmente na rede social."
          />
          {!error?.fields?.publishedUrl && <InlineError error={error} />}
        </div>
      </Modal>

      <ConfirmDialog
        open={dialog === "reset"}
        onClose={() => setDialog(null)}
        title="Voltar para não agendado?"
        description="O registro de agendamento e publicação deste post será limpo. O histórico continua guardado."
        confirmLabel="Voltar para não agendado"
        onConfirm={async () => {
          const { material: next } = await api.patch(`/content/${material.id}/publication`, { status: "not_scheduled" });
          onChange(next);
          toast.success("Post voltou para não agendado.");
        }}
      />
    </Panel>
  );
}

// Owners who may be made responsible for a post of this brand (the server
// checks the same rule): admins, the client's managers, designers of the
// brand's projects. The current owner stays listed so the form never loses it.
export function ownerOptions(owners = [], brandId, current) {
  const list = (owners ?? []).filter((owner) => !brandId || owner.brandIds == null || owner.brandIds.includes(brandId));
  if (current?.id && !list.some((owner) => owner.id === current.id)) list.push({ id: current.id, name: current.name });
  return list.map((owner) => ({ value: owner.id, label: owner.name }));
}

// ---------------------------------------------------------------- delivery

// Final files of the released version and their delivery to the client: the
// "Entregue" axis (materials.deliveredAt), separate from approval and
// publication. Mirrors the library: finals attached after the release wait
// (published: false) until "Entregar"; the confirmation offers the notices
// (in the platform, by e-mail, optional message) before anything is sent.
export function DeliveryPanel({ material, onChange }) {
  const toast = useToast();
  const limits = useUploadLimits();
  const perms = material.permissions ?? {};
  const queue = useUploadQueue();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState({ notifyApp: true, notifyEmail: true, message: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const target = versionOf(material, material.releasedVersionId);
  const finals = groupFiles(target?.files ?? []).finals;
  const waiting = finals.filter((file) => file.published === false);
  const canSend = finals.length > 0 && (waiting.length > 0 || !material.deliveredAt);
  const approvedOrFree =
    material.approvalStatus === "approved" || (!material.requiresApproval && Boolean(material.releasedVersionId));
  const show =
    !material.archivedAt &&
    material.visibility === "released" &&
    Boolean(target) &&
    (approvedOrFree || Boolean(material.deliveredAt)) &&
    (perms.canEdit || perms.canRelease);
  if (!show) return null;

  const attach = async () => {
    setSaving(true);
    try {
      await api.post(`/versions/${target.id}/files`, {
        files: queue.ready.map((item, index) => ({ uploadId: item.upload.id, role: "final", position: finals.length + index + 1 })),
      });
      toast.success(plural(queue.ready.length, "arquivo final salvo", "arquivos finais salvos"));
      queue.clear();
      onChange?.();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const deliver = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post(`/materials/${material.id}/deliver`, {
        notifyApp: notice.notifyApp,
        notifyEmail: notice.notifyEmail,
        message: notice.message.trim() || undefined,
      });
      toast.success({
        title: "Arquivos finais entregues",
        message: notice.notifyApp || notice.notifyEmail ? "O cliente foi avisado e já vê os arquivos." : "O cliente já vê os arquivos.",
      });
      setConfirming(false);
      setNotice({ notifyApp: true, notifyEmail: true, message: "" });
      onChange?.(result?.material);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const sendCount = waiting.length || finals.length;
  return (
    <Panel
      eyebrow={material.approvalStatus === "approved" ? `Versão ${target.number} aprovada` : "Entrega"}
      title="Arquivos finais"
      padding="md"
      className="cnt-delivery"
    >
      <div className="ui-stack" style={{ "--gap": "14px" }}>
        <div className="cnt-delivery__state">
          {material.deliveredAt ? (
            <StatusBadge kind="delivered" value={material.deliveredAt} />
          ) : (
            <span className="cnt-axis__quiet">Arquivos finais não entregues</span>
          )}
          <span className="ui-meta">
            {material.deliveredAt
              ? `Entregue em ${formatDate(material.deliveredAt)}. Novos arquivos finais esperam a próxima entrega.`
              : "Exportações finais separadas da prévia e do original apresentado. Se o original aprovado já é o arquivo de uso, não é preciso entregar nada aqui."}
          </span>
        </div>
        {finals.length > 0 && (
          <ul className="cnt-delivery__list">
            {finals.map((file) => (
              <li key={file.id}>
                <FileMeta
                  file={file}
                  version={target.number}
                  layout="inline"
                  extra={
                    file.published === false ? (
                      <Badge size="sm" tone="amber">
                        Aguardando entrega
                      </Badge>
                    ) : null
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {perms.canEdit && (
          <>
            <Dropzone
              compact
              accept={FINAL_ACCEPT}
              maxSizeBytes={limits?.maxUploadBytes}
              onFiles={(files) => queue.add(files)}
              onReject={(list) => toast.error(`${list[0].file.name}: ${list[0].reason}`)}
              title="Adicionar arquivos finais"
              description="Ficam guardados até a entrega."
              icon={<Upload size={20} strokeWidth={1.3} />}
            />
            <SlideList
              items={queue.items}
              onMove={queue.move}
              onRemove={queue.remove}
              onRetry={queue.retry}
              numbered={false}
              noun="arquivo final"
            />
            {queue.items.length > 0 && (
              <div>
                <Button size="sm" icon={Upload} loading={saving} disabled={queue.busy || !queue.ready.length} onClick={attach}>
                  Salvar {plural(queue.ready.length, "arquivo final", "arquivos finais")}
                </Button>
              </div>
            )}
          </>
        )}
        {perms.canDeliver ? (
          <div className="cnt-delivery__send">
            <Button
              variant="primary"
              icon={PackageCheck}
              disabled={!canSend || queue.ready.length > 0}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              {material.deliveredAt && waiting.length
                ? `Entregar ${waiting.length === 1 ? "o novo arquivo" : `${waiting.length} novos arquivos`}`
                : "Entregar arquivos finais"}
            </Button>
            <span className="ui-meta">
              {!finals.length
                ? "Adicione ao menos um arquivo final para entregar."
                : queue.ready.length > 0
                  ? "Salve os arquivos enviados antes de entregar."
                  : canSend
                    ? "Antes de enviar, você confirma os avisos ao cliente."
                    : "Tudo entregue."}
            </span>
          </div>
        ) : (
          finals.length > 0 && <p className="ui-meta">Um gestor entrega os arquivos finais ao cliente.</p>
        )}
      </div>

      <Modal
        open={confirming}
        onClose={() => !busy && setConfirming(false)}
        size="sm"
        eyebrow="Entrega"
        title="Entregar arquivos finais?"
        description={`${material.client?.name ?? "Cliente"}${material.brand?.name && material.brand.name !== material.client?.name ? ` · ${material.brand.name}` : ""} — “${material.title}”, versão ${target.number}.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button variant="primary" icon={PackageCheck} loading={busy} onClick={deliver}>
              Entregar
            </Button>
          </>
        }
      >
        <div className="ui-stack" style={{ "--gap": "14px" }}>
          <p className="ui-meta">
            {sendCount === 1 ? "1 arquivo final passa" : `${sendCount} arquivos finais passam`} a aparecer para o cliente
            {material.downloadEnabled ? ", com download liberado." : ". O download deste post está desativado: o cliente só visualiza."}
          </p>
          <Checkbox
            checked={notice.notifyApp}
            onCheckedChange={(notifyApp) => setNotice((n) => ({ ...n, notifyApp }))}
            label="Avisar o cliente na plataforma"
          />
          <Checkbox
            checked={notice.notifyEmail}
            onCheckedChange={(notifyEmail) => setNotice((n) => ({ ...n, notifyEmail }))}
            label="Avisar o cliente por e-mail"
          />
          <Field label="Mensagem para o cliente" optional>
            <Textarea
              value={notice.message}
              onValueChange={(message) => setNotice((n) => ({ ...n, message }))}
              rows={3}
              autoGrow
              maxLength={2000}
              placeholder="Ex.: Seguem as versões finais em alta, prontas para publicar."
            />
          </Field>
          <InlineError error={error} />
        </div>
      </Modal>
    </Panel>
  );
}

// ---------------------------------------------------------------- edit post

export function EditPostDrawer({ open, material, options, onClose, onSaved }) {
  const toast = useToast();
  const current = versionOf(material, material.currentVersionId);
  const captionEditable = isEditableVersion(current);
  const initial = useMemo(
    () => ({
      title: material.title ?? "",
      network: material.post?.network ?? "instagram",
      format: material.post?.format ?? "estatico",
      plannedDate: material.post?.plannedDate ?? "",
      plannedTime: material.post?.plannedTime ?? "",
      campaignId: material.post?.campaign?.id ?? "",
      ownerId: material.owner?.id ?? "",
      internalNotes: material.internalNotes ?? "",
      caption: current?.caption ?? "",
      hashtags: current?.hashtags ?? "",
      notes: current?.notes ?? "",
    }),
    [material, current],
  );
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [campaigns, setCampaigns] = useState(options?.campaigns ?? []);
  useEffect(() => {
    if (open) {
      setForm(initial);
      setErrors({});
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setCampaigns(options?.campaigns ?? []), [options]);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    const body = {};
    for (const key of Object.keys(initial)) {
      if (!captionEditable && ["caption", "hashtags", "notes"].includes(key)) continue;
      if ((form[key] ?? "") !== (initial[key] ?? "")) body[key] = form[key] === "" ? null : form[key];
    }
    if (body.title === null) {
      setErrors({ title: "Dê um título ao post." });
      return;
    }
    if (!Object.keys(body).length) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const { material: next } = await api.patch(`/content/${material.id}`, body);
      toast.success("Dados do post salvos.");
      onSaved(next);
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={() => !busy && onClose()}
      title="Editar post"
      eyebrow={material.brand?.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" icon={Save} loading={busy} onClick={save}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="ui-stack" style={{ "--gap": "18px" }}>
        <Field label="Título interno" required error={errors.title}>
          <Input value={form.title} onValueChange={set("title")} maxLength={200} />
        </Field>
        <div className="cnt-fields">
          <Field label="Rede social" error={errors.network}>
            <Select value={form.network} onValueChange={set("network")} options={NETWORK_OPTIONS} />
          </Field>
          <Field label="Formato" error={errors.format}>
            <Select value={form.format} onValueChange={set("format")} options={FORMAT_OPTIONS} />
          </Field>
          <Field label="Data prevista" optional error={errors.plannedDate}>
            <DateInput value={form.plannedDate} onValueChange={set("plannedDate")} />
          </Field>
          <Field label="Horário" optional error={errors.plannedTime}>
            <DateInput type="time" value={form.plannedTime} onValueChange={set("plannedTime")} />
          </Field>
        </div>
        <CampaignField
          brandId={material.brand?.id}
          projectId={material.project?.id}
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
          hint="Só aparece quem já trabalha com este cliente (a pessoa passa a poder editar o post)."
        >
          <Select
            value={form.ownerId}
            onValueChange={set("ownerId")}
            placeholder="Sem responsável"
            options={ownerOptions(options?.owners, material.brand?.id, material.owner)}
          />
        </Field>
        <CaptionField
          value={form.caption}
          onChange={set("caption")}
          network={form.network}
          error={errors.caption}
          disabled={!captionEditable}
          hint={captionEditable ? undefined : "A versão atual já foi liberada. Para mudar a legenda, crie uma nova versão."}
        />
        <Field label="Hashtags" optional error={errors.hashtags}>
          <Textarea value={form.hashtags} onValueChange={set("hashtags")} rows={2} autoGrow disabled={!captionEditable} />
        </Field>
        <Field label="Observações para o cliente" optional error={errors.notes}>
          <Textarea value={form.notes} onValueChange={set("notes")} rows={3} autoGrow disabled={!captionEditable} />
        </Field>
        <div className="cnt-internal">
          <p className="cnt-internal__flag">
            <Lock size={14} strokeWidth={1.5} aria-hidden="true" />
            Somente equipe
          </p>
          <Field label="Notas internas" optional error={errors.internalNotes} hint="Nunca aparecem para o cliente.">
            <Textarea value={form.internalNotes} onValueChange={set("internalNotes")} rows={4} autoGrow maxLength={4000} />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------- new version

export function NewVersionDrawer({ open, material, onClose, onCreated }) {
  const toast = useToast();
  const limits = useUploadLimits();
  const current = versionOf(material, material.currentVersionId);
  const queue = useUploadQueue();
  const [mode, setMode] = useState("upload");
  const [form, setForm] = useState({ changeSummary: "", caption: "", hashtags: "", notes: "" });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm({ changeSummary: "", caption: current?.caption ?? "", hashtags: current?.hashtags ?? "", notes: "" });
    setErrors({});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const nextNumber = Math.max(0, ...(material.versions ?? []).map((v) => v.number)) + 1;

  const create = async () => {
    if (!form.changeSummary.trim()) {
      setErrors({ changeSummary: "Conte ao cliente o que mudou nesta versão." });
      return;
    }
    if (mode === "upload" && !queue.ready.length) {
      setErrors({ files: "Envie ao menos um arquivo, ou comece pelos arquivos da versão atual." });
      return;
    }
    setBusy(true);
    try {
      await api.post(`/materials/${material.id}/versions`, {
        copyFrom: mode === "copy" ? "current" : undefined,
        files:
          mode === "upload" ? queue.ready.map((item, index) => ({ uploadId: item.upload.id, role: "original", position: index + 1 })) : [],
        changeSummary: form.changeSummary.trim(),
        caption: form.caption,
        hashtags: form.hashtags,
        notes: form.notes,
      });
      queue.clear();
      toast.success({ title: `Versão ${nextNumber} criada`, message: "Ela fica em rascunho até ser liberada ao cliente." });
      onCreated();
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={() => !busy && onClose()}
      size="lg"
      eyebrow={material.title}
      title={`Nova versão · v${nextNumber}`}
      description="O histórico continua: as versões anteriores e as decisões do cliente ficam guardadas."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" icon={Upload} loading={busy} disabled={queue.busy} onClick={create}>
            Criar versão {nextNumber}
          </Button>
        </>
      }
    >
      <div className="ui-stack" style={{ "--gap": "20px" }}>
        <Field label="O que mudou" required error={errors.changeSummary} hint="Aparece para o cliente no histórico de versões.">
          <Textarea value={form.changeSummary} onValueChange={set("changeSummary")} rows={3} autoGrow maxLength={2000} placeholder="Ex.: Foto do slide 2 trocada e título mais curto, como pedido." />
        </Field>
        <Segmented
          aria-label="Arquivos da nova versão"
          value={mode}
          onChange={setMode}
          options={[
            { value: "upload", label: "Enviar arquivos novos" },
            { value: "copy", label: `Partir da v${current?.number ?? nextNumber - 1}` },
          ]}
        />
        {mode === "upload" ? (
          <div className="ui-stack" style={{ "--gap": "10px" }}>
            <Dropzone
              accept={MEDIA_ACCEPT}
              maxSizeBytes={limits?.maxUploadBytes}
              onFiles={(files) => queue.add(files)}
              onReject={(list) => toast.error(`${list[0].file.name}: ${list[0].reason}`)}
              title="Arraste os arquivos da nova versão"
              description="A ordem abaixo é a ordem dos slides."
              compact={queue.items.length > 0}
            />
            {errors.files && (
              <p className="ui-inline-error" role="alert">
                {errors.files}
              </p>
            )}
            <SlideList items={queue.items} onMove={queue.move} onRemove={queue.remove} onRetry={queue.retry} />
          </div>
        ) : (
          <p className="ui-meta">
            Os arquivos da v{current?.number} são copiados para a nova versão (sem reenviar). Depois você troca, remove ou reordena só o que
            mudou, antes de liberar.
          </p>
        )}
        <CaptionField value={form.caption} onChange={set("caption")} network={material.post?.network} error={errors.caption} />
        <Field label="Hashtags" optional error={errors.hashtags}>
          <Textarea value={form.hashtags} onValueChange={set("hashtags")} rows={2} autoGrow />
        </Field>
        <Field label="Observações para o cliente" optional error={errors.notes}>
          <Textarea value={form.notes} onValueChange={set("notes")} rows={3} autoGrow />
        </Field>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------- draft files

// Files of the current (unreleased) version: reorder slides, remove and add.
export function DraftFilesPanel({ material, onChange }) {
  const toast = useToast();
  const limits = useUploadLimits();
  const version = versionOf(material, material.currentVersionId);
  const originals = useMemo(() => groupFiles(version?.files ?? []).originals, [version]);
  const [order, setOrder] = useState(originals);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null);
  const queue = useUploadQueue();
  const [adding, setAdding] = useState(false);
  useEffect(() => setOrder(originals), [originals]);
  const dirty = order.map((f) => f.id).join() !== originals.map((f) => f.id).join();

  const items = order.map((file) => ({
    key: file.id,
    name: file.name,
    size: file.sizeBytes,
    kind: file.mediaKind,
    format: file.format,
    thumbUrl: file.previews?.thumb || file.previews?.poster || null,
    status: "done",
  }));

  const saveOrder = async () => {
    setSaving(true);
    try {
      await api.patch(`/versions/${version.id}`, { files: order.map((file, index) => ({ id: file.id, position: index + 1, role: "original" })) });
      toast.success("Ordem dos slides salva.");
      onChange();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const addFiles = async () => {
    setAdding(true);
    try {
      await api.post(`/versions/${version.id}/files`, {
        files: queue.ready.map((item, index) => ({ uploadId: item.upload.id, role: "original", position: order.length + index + 1 })),
      });
      queue.clear();
      toast.success(plural(queue.ready.length, "arquivo adicionado", "arquivos adicionados"));
      onChange();
    } catch (err) {
      toast.error(err);
    } finally {
      setAdding(false);
    }
  };

  if (!version) return null;
  return (
    <Panel
      eyebrow={`Versão ${version.number} · ${version.status === "draft" ? "rascunho" : "revisão interna"}`}
      title="Arquivos da versão atual"
      description="Ainda não liberada: ajuste a ordem dos slides, remova ou acrescente arquivos."
      padding="md"
      actions={
        dirty ? (
          <Button size="sm" variant="primary" icon={Save} loading={saving} onClick={saveOrder}>
            Salvar ordem
          </Button>
        ) : null
      }
    >
      <div className="ui-stack">
        {items.length ? (
          <SlideList
            items={items}
            onMove={(from, to) =>
              setOrder((list) => {
                const next = [...list];
                const [file] = next.splice(from, 1);
                next.splice(to, 0, file);
                return next;
              })
            }
            onRemove={(key) => setRemoving(order.find((file) => file.id === key))}
            disabled={saving}
          />
        ) : (
          <p className="ui-meta">Esta versão ainda não tem arquivos.</p>
        )}
        <Dropzone
          accept={MEDIA_ACCEPT}
          maxSizeBytes={limits?.maxUploadBytes}
          compact
          onFiles={(files) => queue.add(files)}
          onReject={(list) => toast.error(`${list[0].file.name}: ${list[0].reason}`)}
          title="Adicionar arquivos a esta versão"
          description="Entram no fim da lista; reordene depois."
        />
        <SlideList items={queue.items} onMove={queue.move} onRemove={queue.remove} onRetry={queue.retry} numbered={false} />
        {queue.items.length > 0 && (
          <div>
            <Button size="sm" variant="primary" icon={Upload} loading={adding} disabled={queue.busy || !queue.ready.length} onClick={addFiles}>
              Adicionar {plural(queue.ready.length, "arquivo", "arquivos")}
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        tone="danger"
        title="Remover este arquivo da versão?"
        description={removing ? `“${removing.name}” sai da versão ${version.number}. Versões anteriores não mudam.` : ""}
        confirmLabel="Remover"
        onConfirm={async () => {
          await api.del(`/files/${removing.id}`);
          toast.success("Arquivo removido da versão.");
          onChange();
        }}
      />
    </Panel>
  );
}
