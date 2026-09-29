// Material drawer for /painel/arquivos?material=:id — the shared viewer
// (preview, versions, files by role with their downloads), the approval entry
// point, the conversation with the team and the version / decision history.
// The footer holds the single "download everything" action of the drawer:
// posts get their slides in order, other materials the organised material
// package, an earlier version exactly its files.
// #comentarios (e.g. a "new comment" notification) opens on the conversation.
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  ChevronDown,
  Download,
  Lock,
  Package,
  PenLine,
} from "lucide-react";
import { useDownloads } from "../../api/downloads.js";
import { useShell } from "../../shell/index.js";
import {
  ApprovalPanel,
  ApprovalTimeline,
  CommentThread,
  MaterialViewer,
  VersionHistory,
} from "../../shared/review/index.js";
import {
  Button,
  Drawer,
  ErrorState,
  Skeleton,
  StatusBadge,
  Tabs,
  formatBytes,
  formatDate,
  formatDateTime,
  plural,
  useApi,
  useReducedMotion,
} from "../../ui/index.js";
import {
  cx,
  packageFiles,
  primeMaterialDetail,
  readyFiles,
  visibleVersion,
} from "../brand/lib.js";
import { ZipButton } from "../brand/parts.jsx";

const ICON = { strokeWidth: 1.4, "aria-hidden": true };
const COMMENTS_HASH = "#comentarios";

function DrawerSkeleton() {
  return (
    <div className="mb-drawer__skel" aria-busy="true">
      <span className="ui-sr-only" role="status">
        Carregando material
      </span>
      <span className="mb-skelblock" style={{ aspectRatio: "4 / 3" }} aria-hidden="true" />
      <Skeleton width="40%" height={14} />
      <Skeleton width="90%" height={12} />
      <Skeleton width="75%" height={12} />
    </div>
  );
}

// Posts are reviewed in the content hub (caption, comments, slides); the
// drawer points there and summarises the decision.
function PostApproval({ material }) {
  const status = material.approvalStatus;
  if (!material.requiresApproval || !status || status === "none") return null;
  const href = `/painel/conteudo/${encodeURIComponent(material.id)}`;
  const approvedVersion = (material.versions || []).find((v) => v.id === material.approvedVersionId);
  if (status === "pending")
    return (
      <section className="mb-approve is-pending" aria-label="Aprovação">
        <div className="mb-approve__text">
          <StatusBadge kind="approval" value="pending" />
          <p>
            A versão {material.version?.number} desta publicação aguarda sua aprovação. Baixar os
            arquivos não conta como aprovação.
          </p>
        </div>
        <div className="mb-approve__actions">
          <Button variant="primary" to={href} iconRight={ArrowRight}>
            Revisar e aprovar
          </Button>
        </div>
      </section>
    );
  return (
    <div className={`mb-approve ${status === "approved" ? "is-done" : "is-changes"}`}>
      {status === "approved" ? <BadgeCheck size={16} {...ICON} /> : <PenLine size={16} {...ICON} />}
      <span>
        {status === "approved"
          ? `Aprovado${approvedVersion ? ` na versão ${approvedVersion.number}` : ""}${
              approvedVersion?.decidedBy?.name ? ` por ${approvedVersion.decidedBy.name}` : ""
            }${approvedVersion?.decidedAt ? `, ${formatDateTime(approvedVersion.decidedAt)}` : ""}.`
          : "Ajustes solicitados. A equipe Metta está preparando uma nova versão."}{" "}
        <Link className="mb-inlinelink" to={href}>
          Ver na central de conteúdo
          <ArrowUpRight size={13} {...ICON} />
        </Link>
      </span>
    </div>
  );
}

// "SVG, PNG, editável EPS · 3 arquivos · 1,2 MB": what the footer download
// delivers, so the package is predictable before it is requested.
function packageNote(files, { slides = false } = {}) {
  const unique = (list) => [...new Set(list.map((f) => f.format || (f.ext || "").toUpperCase()).filter(Boolean))];
  const ready = files.filter((f) => f.role !== "editable");
  const editable = files.filter((f) => f.role === "editable");
  const formats = [
    ...unique(ready),
    ...(editable.length ? [`${editable.length > 1 ? "editáveis" : "editável"} ${unique(editable).join(", ")}`] : []),
  ];
  const bytes = files.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);
  return [
    formats.join(", "),
    slides ? `${plural(ready.length, "slide", "slides")} em ordem` : plural(files.length, "arquivo", "arquivos"),
    bytes > 0 ? formatBytes(bytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// Collapsible block with the versions and the decision log.
function HistoryBlock({ material, selectedId, onSelect, refreshKey }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState("versions");
  const panelId = useId();
  const count = material.versions?.length ?? 0;
  const toggle = () => {
    setMounted(true);
    setOpen((value) => !value);
  };
  return (
    <section className={cx("mb-drawer__sec mb-history", open && "is-open")} aria-label="Versões e histórico">
      <button
        type="button"
        className="mb-disclose"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <span className="mb-disclose__text">
          <span className="mb-disclose__title">Versões e histórico</span>
          <span className="mb-disclose__meta">
            {plural(count, "versão", "versões")} · liberações e decisões
          </span>
        </span>
        <ChevronDown size={18} {...ICON} className="mb-disclose__chev" />
      </button>
      <div id={panelId} className="mb-collapse" inert={!open} aria-hidden={!open}>
        <div className="mb-collapse__inner">
          {mounted && (
            <Tabs
              aria-label="Histórico do material"
              value={tab}
              onChange={setTab}
              size="sm"
              items={[
                { value: "versions", label: "Versões", count },
                { value: "timeline", label: "Liberações e decisões" },
              ]}
            >
              {tab === "versions" ? (
                <VersionHistory material={material} selectedId={selectedId} onSelect={onSelect} />
              ) : (
                <ApprovalTimeline
                  materialId={material.id}
                  refreshKey={refreshKey}
                  empty="Nenhuma liberação ou decisão registrada ainda."
                />
              )}
            </Tabs>
          )}
        </div>
      </div>
    </section>
  );
}

export default function MaterialDrawer({ id, summary, onClose, onChanged }) {
  // Deep links (?material=) open one tick after mount: a dialog mounted
  // already open is closed and reopened by StrictMode's effect replay, and
  // that close event would drop the parameter.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [shownId, setShownId] = useState(id);
  if (id && id !== shownId) setShownId(id);
  const activeId = id || shownId;
  const { data, error, loading, reload, setData } = useApi(
    activeId ? `/materials/${encodeURIComponent(activeId)}` : null,
  );
  const [versionState, setVersionState] = useState({ id: null, versionId: null });
  const versionId = versionState.id === activeId ? versionState.versionId : null;
  const [refreshKey, setRefreshKey] = useState(0);
  const { downloadFile, isDownloading, startZip } = useDownloads();
  const { refreshCounts } = useShell();
  const location = useLocation();
  const reduced = useReducedMotion();
  const viewerRef = useRef(null);
  const commentsRef = useRef(null);
  const commentsTitleId = useId();

  const material = data?.material?.id === activeId ? data.material : null;
  const base = material || (summary?.id === activeId ? summary : null);
  const version = material ? visibleVersion(material, versionId) : null;
  const files = version?.files || [];
  const pack = packageFiles(files);
  const canDownload = material?.permissions?.canDownload ?? base?.downloadEnabled ?? false;
  const releasedId = material?.releasedVersionId ?? material?.version?.id;
  const isReleased = Boolean(version) && version.id === releasedId;
  const post = material?.kind === "post";
  const slides = post && readyFiles(files).filter((f) => f.downloadable).length > 1;

  // A notification about a new comment opens the drawer on the conversation.
  // Every such navigation (also one to the material already open) reloads
  // the thread and moves there again.
  const wantsComments = location.hash === COMMENTS_HASH;
  const commentsVisit = wantsComments ? `${activeId}|${location.key}` : null;
  const jumpedFor = useRef(null);
  useEffect(() => {
    if (!ready || !material || post || !commentsVisit || jumpedFor.current === commentsVisit) return undefined;
    jumpedFor.current = commentsVisit;
    const frame = requestAnimationFrame(() => {
      const node = commentsRef.current;
      if (!node) return;
      node.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      document.getElementById(commentsTitleId)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, material, post, commentsVisit, reduced, commentsTitleId]);

  const onDone = (next) => {
    if (next) {
      setData({ material: next });
      primeMaterialDetail(next);
      onChanged?.(next);
    } else reload();
    setRefreshKey((key) => key + 1);
    refreshCounts();
  };

  const selectVersion = (next) => {
    setVersionState({ id: activeId, versionId: next });
    viewerRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  const label = base?.title || "Material";
  // Released version: the same packages as the rest of the portal (the
  // carousel ZIP of the content hub, the material ZIP of the file cards).
  // An earlier version: exactly its files.
  const zipScope = !material
    ? null
    : !isReleased
      ? { type: "selection", fileIds: pack.map((f) => f.id) }
      : post
        ? { type: "carousel", materialId: material.id }
        : { type: "selection", materialIds: [material.id] };
  const zipLabel = !isReleased
    ? `${label} (v${version?.number})`
    : post && slides
      ? `${label} — slides em ordem`
      : label;
  const startPackage = () => startZip(zipScope, { label: zipLabel });

  const meta = base
    ? [
        base.project?.name,
        base.version?.number ? `Versão ${base.version.number}` : null,
        base.releasedAt || base.version?.releasedAt
          ? `Liberado em ${formatDate(base.version?.releasedAt || base.releasedAt)}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  let footer = null;
  if (material && !canDownload)
    footer = (
      <p className="mb-drawer__locked">
        <Lock size={15} {...ICON} />
        <span>O download deste material ainda não foi liberado pela equipe Metta.</span>
      </p>
    );
  else if (material && pack.length > 1)
    footer = (
      <div className="mb-drawer__foot">
        <p className="mb-drawer__pack">{packageNote(pack, { slides: post && slides && isReleased })}</p>
        <ZipButton key={`${activeId}|${version?.id}`} variant="primary" icon={Package} start={startPackage}>
          {!isReleased
            ? `Baixar arquivos da versão ${version?.number} (ZIP)`
            : post && slides
              ? "Baixar slides em ordem (ZIP)"
              : "Baixar todos os arquivos (ZIP)"}
        </ZipButton>
      </div>
    );
  else if (material && pack.length === 1)
    footer = (
      <div className="mb-drawer__foot">
        <p className="mb-drawer__pack">{packageNote(pack)}</p>
        <Button
          variant="primary"
          icon={Download}
          loading={isDownloading(pack[0].id)}
          onClick={() => downloadFile(pack[0].id, { name: pack[0].name })}
          aria-label={`Baixar ${pack[0].name}`}
        >
          Baixar arquivo
        </Button>
      </div>
    );

  return (
    <Drawer
      open={ready && Boolean(id)}
      onClose={onClose}
      size="lg"
      className="mb-drawer"
      eyebrow={base?.category?.name || "Arquivo"}
      title={base ? label : loading ? "Carregando…" : "Material"}
      description={meta}
      footer={footer}
    >
      {error && !material ? (
        <ErrorState
          error={error}
          onRetry={reload}
          title={error.status === 404 ? "Este material não está disponível" : undefined}
        />
      ) : !material ? (
        <DrawerSkeleton />
      ) : (
        <div className="mb-drawer__body mb-fade">
          {base?.description && <p className="mb-drawer__desc">{base.description}</p>}
          {post ? <PostApproval material={material} /> : <ApprovalPanel material={material} onDone={onDone} />}
          <div ref={viewerRef} className="mb-drawer__viewer">
            <MaterialViewer
              material={material}
              versionId={version?.id}
              onVersionChange={(next) => setVersionState({ id: activeId, versionId: next })}
              bulkDownload={false}
            />
          </div>
          {post ? (
            <p className="mb-drawer__hub">
              <span>
                Legenda, comentários e versões desta publicação ficam na central de conteúdo.
              </span>
              <Link className="mb-inlinelink" to={`/painel/conteudo/${encodeURIComponent(material.id)}`}>
                Abrir publicação
                <ArrowUpRight size={13} {...ICON} />
              </Link>
            </p>
          ) : (
            <>
              <div ref={commentsRef} id="comentarios" className="mb-drawer__sec mb-drawer__comments">
                <div className="mb-drawer__sechead">
                  <p className="ui-eyebrow">Conversa</p>
                  <h3 id={commentsTitleId} className="mb-drawer__sectitle" tabIndex={-1}>
                    Comentários
                  </h3>
                  <p className="mb-drawer__sechint">
                    Tire dúvidas ou peça ajustes neste material. A equipe Metta responde por aqui.
                  </p>
                </div>
                <CommentThread
                  materialId={material.id}
                  versionId={version?.id}
                  versionNumber={version?.number}
                  subject="este material"
                  refreshKey={`${refreshKey}|${commentsVisit ?? ""}`}
                  disabled={material.permissions?.canComment === false}
                  title="Comentários"
                />
              </div>
              <HistoryBlock
                material={material}
                selectedId={version?.id}
                onSelect={selectVersion}
                refreshKey={refreshKey}
              />
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
