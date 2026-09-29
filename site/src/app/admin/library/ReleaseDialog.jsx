import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, CircleAlert, Mail, OctagonAlert, Package, PackageCheck, Send, TriangleAlert, UsersRound } from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  ErrorState,
  Field,
  FileMeta,
  Modal,
  Skeleton,
  Switch,
  Textarea,
  Thumb,
  formatBytes,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { CheckDraw, Formats, VersionTag } from "./parts.jsx";
import { artBackground, materialsLabel } from "./data.js";
import "./library.css";

const uniq = (list) => [...new Set(list.filter(Boolean))];
const people = (n) => (n === 1 ? "1 pessoa" : `${n} pessoas`);
const filesLabel = (n) => (n === 1 ? "1 arquivo" : `${n} arquivos`);

/**
 * What the client was actually told, from the server's answer to a release,
 * kit release or delivery ({emailConfigured, emailRecipients, appRecipients}).
 * Never claims an e-mail that was not sent (docs/PLATFORM.md §4 and §6); when
 * the answer has no e-mail fields, e-mail is simply not mentioned.
 */
export function noticeOutcome({
  recipients = [],
  notifyApp,
  notifyEmail,
  result,
  visibleText = "os materiais já aparecem na área dele",
  emptyText = "O cliente ainda não tem usuários ativos: os materiais aparecem para quem for convidado.",
}) {
  if (!recipients.length) return emptyText;
  if (!notifyApp && !notifyEmail) return `Sem aviso ao cliente: ${visibleText}.`;
  const appCount = typeof result?.appRecipients === "number" ? result.appRecipients : recipients.length;
  const known = typeof result?.emailConfigured === "boolean";
  const emailCount = typeof result?.emailRecipients === "number" ? result.emailRecipients : null;
  const app = notifyApp && appCount > 0 ? `Avisamos ${people(appCount)} na plataforma` : null;
  if (!notifyEmail || !known) return app ? `${app}.` : `Sem aviso na plataforma: ${visibleText}.`;
  if (!result.emailConfigured) {
    const noEmail = "O e-mail não está configurado, então não houve envio por e-mail.";
    return app ? `${app}. ${noEmail}` : `${noEmail} ${visibleText.charAt(0).toUpperCase()}${visibleText.slice(1)}.`;
  }
  if (emailCount === 0) {
    const none = "Ninguém recebeu por e-mail: os destinatários desativaram os avisos por e-mail.";
    return app ? `${app}. ${none}` : none;
  }
  if (emailCount === null) return app ? `${app} e por e-mail.` : "Enviamos o aviso por e-mail.";
  return app ? `${app} e ${emailCount} por e-mail.` : `Enviamos o aviso por e-mail a ${people(emailCount)}.`;
}

function itemFacts(item) {
  const files = (item.files ?? []).filter((file) => file.role !== "cover");
  const deliverable = files.filter((file) => file.role !== "editable");
  const editables = files.filter((file) => file.role === "editable");
  const formats = item.formats?.length ? item.formats : uniq(deliverable.map((file) => file.format ?? String(file.ext ?? "").toUpperCase()));
  const bytes = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  return { files, deliverable, editables, formats, bytes };
}

/**
 * Release summary + confirmation (docs/API.md, POST /api/releases/preview and
 * /api/releases). Shows who receives the materials before anything leaves the
 * team; used by the library, the material page, kits and slice D.
 *   <ReleaseDialog open materialIds={[...]} kitId? onClose onReleased(result) />
 */
export default function ReleaseDialog({ open, materialIds = [], kitId = null, onClose, onReleased }) {
  const toast = useToast();
  const [phase, setPhase] = useState("loading"); // loading | ready | error | sending | done
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [downloads, setDownloads] = useState({});
  const [notifyApp, setNotifyApp] = useState(true);
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);
  const request = useRef(0);
  // Inputs are captured when the dialog opens: parents often update their
  // lists after a release, and that must not re-run the summary.
  const input = useRef({ ids: [], kitId: null });

  const load = useCallback(async () => {
    const seq = ++request.current;
    const { ids, kitId: kid } = input.current;
    setPhase("loading");
    setLoadError(null);
    setSendError(null);
    try {
      const data = await api.post("/releases/preview", { materialIds: ids, ...(kid ? { kitId: kid } : {}) });
      if (seq !== request.current) return;
      setPreview(data);
      setDownloads(Object.fromEntries((data?.items ?? []).map((item) => [item.material?.id, item.downloadEnabled !== false])));
      setPhase("ready");
    } catch (error) {
      if (seq !== request.current) return;
      setLoadError(error);
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current = { ids: uniq(materialIds ?? []), kitId: kitId ?? null };
    setResult(null);
    setMessage("");
    setNotifyApp(true);
    setNotifyEmail(true);
    load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = preview?.items ?? [];
  const blockers = preview?.blockers ?? [];
  const warnings = preview?.warnings ?? [];
  const recipients = preview?.recipients ?? [];
  const clientName = preview?.client?.name ?? "Cliente";
  const brandName = preview?.brand?.name ?? "";
  const totals = useMemo(() => {
    let files = 0;
    let bytes = 0;
    for (const item of items) {
      const facts = itemFacts(item);
      files += facts.files.length;
      bytes += facts.bytes;
    }
    return { files, bytes };
  }, [items]);

  const confirm = async () => {
    setPhase("sending");
    setSendError(null);
    const ids = uniq(items.map((item) => item.material?.id));
    const body = {
      materialIds: ids,
      downloadEnabled: Object.fromEntries(ids.map((id) => [id, downloads[id] !== false])),
      notifyEmail: notifyEmail && recipients.length > 0,
      notifyApp: notifyApp && recipients.length > 0,
      ...(message.trim() ? { message: message.trim() } : {}),
    };
    const kitId = input.current.kitId;
    try {
      let data;
      if (kitId) {
        try {
          data = await api.post(`/kits/${kitId}/release`, body);
        } catch (error) {
          if (error.status !== 404 || error.data?.error?.message !== "Endereço não encontrado.") throw error;
          data = await api.post("/releases", { ...body, kitId });
        }
      } else {
        data = await api.post("/releases", body);
      }
      setResult({ ...data, count: ids.length });
      setPhase("done");
      toast.success(
        kitId
          ? `Kit liberado para ${clientName}.`
          : `${ids.length === 1 ? "Material liberado" : `${ids.length} materiais liberados`} para ${clientName}.`,
      );
      onReleased?.(data);
    } catch (error) {
      setSendError(error);
      setPhase("ready");
    }
  };

  const busy = phase === "sending";
  const canConfirm = phase === "ready" && items.length > 0 && blockers.length === 0;
  const count = items.length;
  const toRelease = preview?.counts?.toRelease ?? items.filter((item) => !item.alreadyReleased).length;

  const footer =
    phase === "done" ? (
      <Button variant="primary" onClick={onClose} data-autofocus>
        Concluir
      </Button>
    ) : (
      <>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button variant="primary" icon={Send} onClick={confirm} loading={busy} disabled={!canConfirm}>
          {kitId ? "Liberar kit" : toRelease ? `Liberar ${materialsLabel(toRelease)}` : "Liberar"}
        </Button>
      </>
    );

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      dismissible={!busy}
      size="lg"
      eyebrow={kitId ? "Liberar kit para o cliente" : "Liberar para o cliente"}
      title={phase === "done" ? "Liberado" : "Revise antes de liberar"}
      description={
        phase === "done"
          ? null
          : "Nada fica visível ao cliente antes da sua confirmação. Confira o destino, os arquivos e as permissões."
      }
      footer={footer}
      className="lib-release"
    >
      {phase === "loading" && <ReleaseSkeleton />}
      {phase === "error" && <ErrorState error={loadError} onRetry={load} compact title="Não foi possível montar o resumo" />}

      {phase === "done" && (
        <div className="lib-release__done" role="status">
          <CheckDraw size={64} />
          <p className="lib-release__done-title">
            {kitId ? "Kit disponível" : result?.count === 1 ? "Material disponível" : `${materialsLabel(result?.count ?? count)} disponíveis`} para{" "}
            <em>{clientName}</em>
          </p>
          <p className="lib-release__done-text">{noticeOutcome({ recipients, notifyApp, notifyEmail, result })}</p>
        </div>
      )}

      {(phase === "ready" || phase === "sending") && preview && (
        <div className="lib-release__body">
          <Destination clientName={clientName} brandName={brandName} recipients={recipients} />

          {blockers.length > 0 && (
            <ul className="lib-release__notes is-blocker" role="alert">
              {blockers.map((text) => (
                <li key={text}>
                  <OctagonAlert size={16} strokeWidth={1.4} aria-hidden="true" />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          )}
          {warnings.length > 0 && (
            <ul className="lib-release__notes is-warning">
              {warnings.map((text) => (
                <li key={text}>
                  <TriangleAlert size={16} strokeWidth={1.4} aria-hidden="true" />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          )}

          <section aria-labelledby="lib-release-items">
            <div className="lib-release__listhead">
              <h3 id="lib-release-items" className="lib-mini-title">
                {kitId && <Package size={14} strokeWidth={1.4} aria-hidden="true" />}
                {materialsLabel(count)}
              </h3>
              <span className="ui-meta">
                {filesLabel(totals.files)} · {formatBytes(totals.bytes)}
              </span>
            </div>
            {count === 0 ? (
              <p className="lib-release__empty">Nenhum material para liberar nesta seleção.</p>
            ) : (
              <ul className="lib-release__items">
                {items.map((item, index) => {
                  const material = item.material ?? {};
                  const facts = itemFacts(item);
                  const cover = facts.files.find((file) => file.role === "original") ?? facts.files[0];
                  const versionNumber = item.version?.number ?? material.version?.number;
                  return (
                    <li key={material.id ?? index} className="lib-release__item ui-enter" style={{ "--i": Math.min(index, 8) }}>
                      <div className="lib-release__thumb">
                        <Thumb
                          file={material.thumb ? undefined : cover}
                          thumb={material.thumb}
                          aspect="1"
                          bg={artBackground(material)}
                          fit="contain"
                          alt=""
                        />
                      </div>
                      <div className="lib-release__info">
                        <p className="lib-release__title">
                          <span>{material.title}</span>
                          <VersionTag number={versionNumber} />
                        </p>
                        <p className="lib-release__facts">
                          <span>{filesLabel(facts.deliverable.length)}</span>
                          <Formats formats={facts.formats} max={5} />
                        </p>
                        <p className="lib-release__tags">
                          {item.alreadyReleased && <Badge size="sm">Já liberado nesta versão</Badge>}
                          {item.isNewVersion && <Badge tone="amber" size="sm">Nova versão</Badge>}
                          {material.id && material.project === null && (
                            <Badge tone="amber" size="sm" title="Sem projeto ou serviço vinculado">
                              Sem projeto
                            </Badge>
                          )}
                          {item.requiresApproval ? (
                            <Badge tone="slate" size="sm">Exige aprovação</Badge>
                          ) : (
                            <Badge size="sm">Sem aprovação</Badge>
                          )}
                          {facts.editables.length > 0 &&
                            (item.editableIncluded ? (
                              <Badge tone="teal" size="sm">
                                {facts.editables.length === 1 ? "1 editável incluído" : `${facts.editables.length} editáveis incluídos`}
                              </Badge>
                            ) : (
                              <Badge size="sm" title="O serviço não inclui editáveis: o cliente não verá estes arquivos">
                                Editáveis ficam com a equipe
                              </Badge>
                            ))}
                        </p>
                      </div>
                      <div className="lib-release__dl">
                        <Switch
                          checked={downloads[material.id] !== false}
                          onCheckedChange={(on) => setDownloads((prev) => ({ ...prev, [material.id]: on }))}
                          aria-label={`Permitir download de ${material.title}`}
                          disabled={busy}
                        />
                        <span aria-hidden="true">{downloads[material.id] !== false ? "Download" : "Só visualizar"}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <NotifyFields
            recipients={recipients}
            notifyApp={notifyApp}
            notifyEmail={notifyEmail}
            onNotifyApp={setNotifyApp}
            onNotifyEmail={setNotifyEmail}
            message={message}
            onMessage={setMessage}
            disabled={busy}
            placeholder="Ex.: Seguem as versões finais da identidade. Qualquer ajuste, é só comentar."
          />

          {sendError && (
            <div className="lib-release__error" role="alert">
              <CircleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
              <div>
                <p>{sendError.message}</p>
                {sendError.status === 409 && (
                  <Button size="sm" variant="link" onClick={load}>
                    Atualizar o resumo
                  </Button>
                )}
              </div>
            </div>
          )}
          {notifyEmail && recipients.length > 0 && <EmailFootNote />}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- shared parts

function Destination({ clientName, brandName, recipients }) {
  return (
    <section className="lib-release__dest" aria-label="Destino">
      <span className="lib-release__dest-icon" aria-hidden="true">
        <Building2 size={20} strokeWidth={1.4} />
      </span>
      <div className="lib-release__dest-main">
        <p className="lib-release__dest-eyebrow">Destino</p>
        <p className="lib-release__dest-name">
          {clientName}
          {brandName && (
            <>
              <span className="lib-release__dest-sep" aria-hidden="true">
                /
              </span>
              <em>{brandName}</em>
            </>
          )}
        </p>
        <div className="lib-release__people">
          <UsersRound size={15} strokeWidth={1.4} aria-hidden="true" />
          {recipients.length ? (
            <ul aria-label="Quem recebe">
              {recipients.map((person) => (
                <li key={person.id} title={person.email}>
                  <Avatar name={person.name} size={22} decorative />
                  <span>{person.name}</span>
                  {person.notifyEmail === false && <small>(sem e-mail)</small>}
                </li>
              ))}
            </ul>
          ) : (
            <span>Nenhum usuário ativo neste cliente ainda.</span>
          )}
        </div>
      </div>
    </section>
  );
}

function NotifyFields({ recipients, notifyApp, notifyEmail, onNotifyApp, onNotifyEmail, message, onMessage, disabled, placeholder }) {
  const emailable = recipients.filter((person) => person.notifyEmail !== false);
  const none = recipients.length === 0;
  return (
    <section className="lib-release__notify" aria-label="Aviso ao cliente">
      <div className="lib-release__checks">
        <Checkbox
          label="Avisar na plataforma"
          description="Notificação no sino da área do cliente."
          checked={notifyApp && !none}
          disabled={disabled || none}
          onCheckedChange={onNotifyApp}
        />
        <Checkbox
          label="Enviar e-mail"
          description={
            none
              ? "Sem destinatários ativos."
              : emailable.length
                ? `${emailable.length === 1 ? "1 pessoa recebe" : `${emailable.length} pessoas recebem`} por e-mail.`
                : "Ninguém deste cliente recebe avisos por e-mail."
          }
          checked={notifyEmail && !none}
          disabled={disabled || none}
          onCheckedChange={onNotifyEmail}
        />
      </div>
      <Field label="Mensagem para o cliente" optional hint="Aparece no aviso e no e-mail.">
        <Textarea rows={3} autoGrow maxLength={1000} value={message} disabled={disabled} placeholder={placeholder} onValueChange={onMessage} />
      </Field>
    </section>
  );
}

function EmailFootNote() {
  return (
    <p className="lib-release__foot-note">
      <Mail size={14} strokeWidth={1.4} aria-hidden="true" />
      Se o envio de e-mail ainda não estiver configurado, nada é enviado por e-mail: o aviso fica registrado em Configurações para
      reenvio.
    </p>
  );
}

// ---------------------------------------------------------------- delivery

/**
 * Delivery summary + confirmation (POST /api/materials/:id/deliver). Like a
 * release, a delivery changes what the client sees, so it shows the client,
 * brand and recipients, the files that appear, the download permission and
 * the in-app / e-mail notice before anything is sent.
 *   mode "finals": final files attached to the released version.
 *   mode "originals": the material was delivered as its original files; the
 *   delivery is only recorded (nothing new becomes visible).
 *   <DeliverDialog open material mode onClose onDelivered(result) />
 */
export function DeliverDialog({ open, material, mode = "finals", onClose, onDelivered }) {
  const toast = useToast();
  const [phase, setPhase] = useState("loading"); // loading | ready | error | sending | done
  const [audience, setAudience] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [notifyApp, setNotifyApp] = useState(true);
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [download, setDownload] = useState(true);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);
  const request = useRef(0);
  const materialId = material?.id ?? null;

  // Client, brand and recipients come from the release summary, the same
  // source the release dialog uses (read-only: nothing is released here).
  const load = useCallback(async () => {
    if (!materialId) return;
    const seq = ++request.current;
    setPhase("loading");
    setLoadError(null);
    setSendError(null);
    try {
      const data = await api.post("/releases/preview", { materialIds: [materialId] });
      if (seq !== request.current) return;
      setAudience({ client: data?.client ?? null, brand: data?.brand ?? null, recipients: data?.recipients ?? [] });
      setPhase("ready");
    } catch (error) {
      if (seq !== request.current) return;
      setLoadError(error);
      setPhase("error");
    }
  }, [materialId]);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setMessage("");
    setNotifyApp(true);
    setNotifyEmail(true);
    setDownload(material?.downloadEnabled !== false);
    load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const released = (material?.versions ?? []).find((v) => v.id === material?.releasedVersionId) ?? null;
  const releasedFiles = released?.files ?? [];
  const finals = releasedFiles.filter((file) => file.role === "final");
  const waiting = finals.filter((file) => file.published === false);
  const shownFiles = mode === "originals" ? releasedFiles.filter((file) => file.role === "original") : waiting.length ? waiting : finals;
  const recipients = audience?.recipients ?? [];
  const clientName = audience?.client?.name ?? material?.client?.name ?? "Cliente";
  const brandName = audience?.brand?.name ?? material?.brand?.name ?? "";
  const bytes = shownFiles.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  const busy = phase === "sending";
  const originals = mode === "originals";

  const confirm = async () => {
    setPhase("sending");
    setSendError(null);
    const body = {
      notifyApp: notifyApp && recipients.length > 0,
      notifyEmail: notifyEmail && recipients.length > 0,
      downloadEnabled: download,
      ...(message.trim() ? { message: message.trim() } : {}),
    };
    try {
      const data = await api.post(`/materials/${materialId}/deliver`, body);
      setResult(data ?? {});
      setPhase("done");
      toast.success(originals ? "Entrega registrada." : "Arquivos finais entregues ao cliente.");
      onDelivered?.(data);
    } catch (error) {
      setSendError(error);
      setPhase("ready");
    }
  };

  const confirmLabel = originals
    ? "Marcar como entregue"
    : waiting.length && material?.deliveredAt
      ? `Entregar ${waiting.length === 1 ? "o novo arquivo" : `${waiting.length} novos arquivos`}`
      : `Entregar ${filesLabel(shownFiles.length)}`;

  const footer =
    phase === "done" ? (
      <Button variant="primary" onClick={onClose} data-autofocus>
        Concluir
      </Button>
    ) : (
      <>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button variant="primary" icon={PackageCheck} onClick={confirm} loading={busy} disabled={phase !== "ready" || !shownFiles.length}>
          {confirmLabel}
        </Button>
      </>
    );

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      dismissible={!busy}
      size="md"
      eyebrow={originals ? "Registrar entrega" : "Entregar ao cliente"}
      title={phase === "done" ? (originals ? "Entrega registrada" : "Entregue") : "Revise antes de entregar"}
      description={
        phase === "done"
          ? null
          : originals
            ? "Os arquivos originais desta versão já estão com o cliente. Confirme para registrar a entrega e, se quiser, avisar."
            : "Os arquivos finais só aparecem para o cliente depois da sua confirmação."
      }
      footer={footer}
      className="lib-release lib-deliver"
    >
      {phase === "loading" && <ReleaseSkeleton />}
      {phase === "error" && <ErrorState error={loadError} onRetry={load} compact title="Não foi possível montar o resumo" />}

      {phase === "done" && (
        <div className="lib-release__done" role="status">
          <CheckDraw size={64} />
          <p className="lib-release__done-title">
            {originals ? "Entrega registrada" : result?.published === 1 || shownFiles.length === 1 ? "Arquivo final entregue" : "Arquivos finais entregues"}{" "}
            para <em>{clientName}</em>
          </p>
          <p className="lib-release__done-text">
            {noticeOutcome({
              recipients,
              notifyApp,
              notifyEmail,
              result,
              visibleText: originals ? "a entrega fica registrada no histórico" : "os arquivos já aparecem na área dele",
              emptyText: originals
                ? "O cliente ainda não tem usuários ativos: a entrega fica registrada no histórico."
                : "O cliente ainda não tem usuários ativos: os arquivos aparecem para quem for convidado.",
            })}
          </p>
        </div>
      )}

      {(phase === "ready" || phase === "sending") && (
        <div className="lib-release__body">
          <Destination clientName={clientName} brandName={brandName} recipients={recipients} />

          <section aria-labelledby="lib-deliver-files">
            <div className="lib-release__listhead">
              <h3 id="lib-deliver-files" className="lib-mini-title">
                {originals ? "Entregue como arquivos originais" : "Arquivos que passam a aparecer"}
              </h3>
              <span className="ui-meta">
                {released ? `v${released.number} · ` : ""}
                {filesLabel(shownFiles.length)} · {formatBytes(bytes)}
              </span>
            </div>
            {shownFiles.length ? (
              <ul className="lib-deliver__files">
                {shownFiles.map((file) => (
                  <li key={file.id}>
                    <FileMeta file={file} version={released?.number} layout="inline" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="lib-release__empty">
                {originals ? "A versão liberada não tem arquivos originais." : "Adicione ao menos um arquivo final antes de entregar."}
              </p>
            )}
          </section>

          <div className="lib-deliver__dl">
            <Switch
              label="Download disponível"
              description={
                download
                  ? originals
                    ? "O cliente pode baixar os arquivos entregues."
                    : "O cliente pode baixar os arquivos finais."
                  : "O cliente só visualiza a prévia."
              }
              checked={download}
              disabled={busy}
              onCheckedChange={setDownload}
            />
          </div>

          <NotifyFields
            recipients={recipients}
            notifyApp={notifyApp}
            notifyEmail={notifyEmail}
            onNotifyApp={setNotifyApp}
            onNotifyEmail={setNotifyEmail}
            message={message}
            onMessage={setMessage}
            disabled={busy}
            placeholder={originals ? "Ex.: Entrega concluída. Os arquivos estão na sua área." : "Ex.: Seguem os arquivos finais em alta qualidade."}
          />

          {sendError && (
            <div className="lib-release__error" role="alert">
              <CircleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
              <p>{sendError.message}</p>
            </div>
          )}
          {notifyEmail && recipients.length > 0 && <EmailFootNote />}
        </div>
      )}
    </Modal>
  );
}

function ReleaseSkeleton() {
  return (
    <div className="lib-release__body" aria-busy="true">
      <span className="ui-sr-only" role="status">
        Montando o resumo
      </span>
      <Skeleton height={96} radius={4} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="lib-release__item is-skeleton">
          <Skeleton width={56} height={56} radius={4} />
          <div className="lib-release__info">
            <Skeleton width="55%" height={13} />
            <Skeleton width="35%" height={11} />
          </div>
        </div>
      ))}
    </div>
  );
}
