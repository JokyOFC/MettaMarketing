import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ArrowDown, Download, Lock } from "lucide-react";
import {
  Button,
  ErrorState,
  PageHeader,
  Panel,
  Skeleton,
  Tabs,
  formatDateTime,
  networkLabel,
  plural,
  postFormatLabel,
  useApi,
  useIsNarrow,
  useReducedMotion,
} from "../../ui/index.js";
import { useDownloads } from "../../api/downloads.js";
import { usePageTitle } from "../../shell/index.js";
import { ApprovalPanel } from "../../shared/review/ApprovalPanel.jsx";
import { ApprovalTimeline } from "../../shared/review/ApprovalTimeline.jsx";
import { CaptionBlock } from "../../shared/review/CaptionBlock.jsx";
import { CommentThread } from "../../shared/review/CommentThread.jsx";
import { MaterialViewer } from "../../shared/review/MaterialViewer.jsx";
import { VersionHistory } from "../../shared/review/VersionHistory.jsx";
import { PostAxes } from "../../shared/review/PostAxes.jsx";
import { ZipButton } from "../../shared/review/ZipButton.jsx";
import { groupFiles, versionOf } from "../../shared/review/util.js";
import "../../shared/review/review.css";

// Phones: the decision panel sits right below the preview (before the file
// lists); while it is off screen a slim bar offers a shortcut to it.
function DecisionBar({ targetRef, version }) {
  const [visible, setVisible] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    const node = targetRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(([entry]) => setVisible(!entry.isIntersecting), { threshold: 0.2 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [targetRef]);
  if (!visible) return null;
  return (
    <div className="cnt-decide ui-enter" role="region" aria-label="Decisão pendente">
      <span className="cnt-decide__text">
        Versão {version.number} aguarda <em>sua decisão</em>
      </span>
      <Button
        size="sm"
        variant="primary"
        icon={ArrowDown}
        onClick={() => {
          const node = targetRef.current;
          node?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
          node?.querySelector("button")?.focus({ preventScroll: true });
        }}
      >
        Aprovar ou pedir ajustes
      </Button>
    </div>
  );
}

// The released version's slides can be downloaded in order as one ZIP.
const offersSlidesZip = (material, version) =>
  Boolean(material.downloadEnabled) &&
  version?.id === material.releasedVersionId &&
  groupFiles(version?.files ?? []).originals.filter((file) => file.downloadable).length > 1;

function DownloadsPanel({ material, version }) {
  const { startZip, downloadFile, isDownloading } = useDownloads();
  const { originals } = groupFiles(version?.files ?? []);
  const downloadable = originals.filter((file) => file.downloadable);
  const isReleased = version?.id === material.releasedVersionId;
  return (
    <Panel eyebrow="Downloads" title="Baixar arquivos" padding="md">
      {!material.downloadEnabled ? (
        <p className="rv-file__lock">
          <Lock size={13} strokeWidth={1.4} aria-hidden="true" />
          Download ainda não liberado pela equipe Metta. Você pode revisar e aprovar normalmente.
        </p>
      ) : downloadable.length > 1 && isReleased ? (
        <div className="ui-stack" style={{ "--gap": "10px" }}>
          <ZipButton
            variant="primary"
            run={() => startZip({ type: "carousel", materialId: material.id }, { label: `${material.title} — slides em ordem` })}
          >
            Baixar slides em ordem (ZIP)
          </ZipButton>
          <p className="ui-meta">
            {plural(downloadable.length, "slide", "slides")} numerados na ordem do carrossel. Os arquivos individuais estão abaixo da prévia.
          </p>
        </div>
      ) : downloadable.length === 1 ? (
        <div className="ui-stack" style={{ "--gap": "10px" }}>
          <Button
            variant="primary"
            icon={Download}
            loading={isDownloading(downloadable[0].id)}
            onClick={() => downloadFile(downloadable[0].id, { name: downloadable[0].name })}
          >
            Baixar {downloadable[0].format}
          </Button>
          <p className="ui-meta">Arquivo original, na qualidade em que foi entregue.</p>
        </div>
      ) : (
        <p className="ui-meta">Os arquivos desta versão estão listados abaixo da prévia, separados por tipo.</p>
      )}
    </Panel>
  );
}

function DetailSkeleton() {
  return (
    <div className="cnt-page" aria-busy="true">
      <Skeleton width={120} height={12} />
      <Skeleton width="55%" height={34} />
      <div className="cnt-detail">
        <div className="cnt-detail__main">
          <Skeleton height={420} radius={4} />
        </div>
        <div className="cnt-detail__side">
          <Skeleton height={180} radius={4} />
          <Skeleton height={140} radius={4} />
        </div>
      </div>
    </div>
  );
}

export default function ContentDetail() {
  const { id } = useParams();
  const { data, error, loading, reload, setData } = useApi(`/content/${id}`);
  const material = data?.material;
  const [versionId, setVersionId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState("versions");
  const reduced = useReducedMotion();
  const narrow = useIsNarrow();
  const decisionRef = useRef(null);
  usePageTitle(material?.title ?? "Publicação", {
    crumbs: [{ label: "Conteúdo", to: "/painel/conteudo" }, { label: material?.title ?? "Publicação" }],
  });

  if (loading) return <DetailSkeleton />;
  if (error && !material)
    return (
      <div className="cnt-page">
        <PageHeader back={{ to: "/painel/conteudo", label: "Conteúdo" }} title="Publicação" />
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  if (!material) return null;

  const version = versionOf(material, versionId) ?? versionOf(material, material.releasedVersionId) ?? material.versions?.[0];
  const slides = groupFiles(version?.files ?? []).originals.length;
  const done = (next) => {
    if (next) setData({ material: { ...material, ...next } });
    setVersionId(null);
    setRefreshKey((key) => key + 1);
  };
  // Phones: the decision comes right after the preview, before the file lists.
  const decision = (
    <div ref={decisionRef} className="cnt-decision">
      <ApprovalPanel material={material} onDone={done} />
    </div>
  );

  return (
    <div className="cnt-page">
      <PageHeader
        back={{ to: "/painel/conteudo", label: "Conteúdo" }}
        eyebrow={`${networkLabel(material.post?.network)} · ${postFormatLabel(material.post?.format)}`}
        title={material.title}
        description={material.post?.campaign?.name ? `Campanha ${material.post.campaign.name}` : undefined}
      />
      <PostAxes material={material} />

      <div className="cnt-detail">
        <div className="cnt-detail__main">
          <MaterialViewer
            material={material}
            versionId={version?.id}
            onVersionChange={setVersionId}
            afterPreview={narrow ? decision : null}
            bulkDownload={narrow || !offersSlidesZip(material, version)}
          />
        </div>

        <aside className="cnt-detail__side" aria-label="Aprovação e informações">
          {!narrow && decision}
          <Panel padding="md">
            <CaptionBlock caption={version?.caption} hashtags={version?.hashtags} />
            {version?.notes && (
              <div className="ui-stack" style={{ "--gap": "10px", marginTop: 20 }}>
                <h3 className="rv-caption__title">Observações da equipe</h3>
                <p className="cnt-notes">{version.notes}</p>
              </div>
            )}
          </Panel>
          <Panel padding="md" eyebrow="Detalhes" title="Sobre a publicação">
            <dl className="cnt-facts">
              <div>
                <dt>Rede</dt>
                <dd>{networkLabel(material.post?.network)}</dd>
              </div>
              <div>
                <dt>Formato</dt>
                <dd>
                  {postFormatLabel(material.post?.format)}
                  {slides > 1 ? ` · ${plural(slides, "slide", "slides")}` : ""}
                </dd>
              </div>
              <div>
                <dt>Campanha</dt>
                <dd>{material.post?.campaign?.name ?? "Sem campanha"}</dd>
              </div>
              <div>
                <dt>Equipe responsável</dt>
                <dd>{material.owner?.name ?? "Equipe Metta"}</dd>
              </div>
              <div className="is-wide">
                <dt>Liberado em</dt>
                <dd>{material.releasedAt ? formatDateTime(material.releasedAt) : "—"}</dd>
              </div>
            </dl>
          </Panel>
          <DownloadsPanel material={material} version={version} />
        </aside>

        <div className="cnt-detail__rest">
          <Panel eyebrow="Conversa" title="Comentários" padding="md">
            <CommentThread
              materialId={material.id}
              versionId={version?.id}
              versionNumber={version?.number}
              slides={slides}
              refreshKey={refreshKey}
            />
          </Panel>
          <Panel padding="md">
            <Tabs
              aria-label="Histórico"
              value={tab}
              onChange={setTab}
              items={[
                { value: "versions", label: "Versões", count: material.versions?.length ?? 0 },
                { value: "timeline", label: "Histórico de aprovação" },
              ]}
            >
              {tab === "versions" ? (
                <VersionHistory
                  material={material}
                  selectedId={version?.id}
                  onSelect={(value) => {
                    setVersionId(value);
                    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
                  }}
                />
              ) : (
                <ApprovalTimeline materialId={material.id} refreshKey={refreshKey} />
              )}
            </Tabs>
          </Panel>
        </div>
      </div>
      {narrow && material.approvalStatus === "pending" && material.requiresApproval && versionOf(material, material.releasedVersionId) && (
        <DecisionBar targetRef={decisionRef} version={versionOf(material, material.releasedVersionId)} />
      )}
    </div>
  );
}
