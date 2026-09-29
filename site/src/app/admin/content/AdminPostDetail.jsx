import { useState } from "react";
import { useParams } from "react-router-dom";
import { FilePlus2, Library, Lock, Pencil, Send, Unlock } from "lucide-react";
import {
  Button,
  ErrorState,
  Menu,
  PageHeader,
  Panel,
  Skeleton,
  Tabs,
  formatDate,
  formatDateTime,
  networkLabel,
  postFormatLabel,
  useApi,
  useReducedMotion,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle, useShell } from "../../shell/index.js";
import { ApprovalPanel } from "../../shared/review/ApprovalPanel.jsx";
import { ApprovalTimeline } from "../../shared/review/ApprovalTimeline.jsx";
import { CaptionBlock } from "../../shared/review/CaptionBlock.jsx";
import { CommentThread } from "../../shared/review/CommentThread.jsx";
import { MaterialViewer } from "../../shared/review/MaterialViewer.jsx";
import { PostAxes } from "../../shared/review/PostAxes.jsx";
import { VersionHistory } from "../../shared/review/VersionHistory.jsx";
import { groupFiles, versionOf } from "../../shared/review/util.js";
import ReleaseDialog from "../library/ReleaseDialog.jsx";
import { DeliveryPanel, DraftFilesPanel, EditPostDrawer, NewVersionDrawer, PublicationPanel, isEditableVersion } from "./panels.jsx";
import "../../shared/review/review.css";

function DetailSkeleton() {
  return (
    <div className="cnt-page" aria-busy="true">
      <Skeleton width={160} height={12} />
      <Skeleton width="50%" height={34} />
      <Skeleton height={84} radius={4} />
      <div className="cnt-detail">
        <div className="cnt-detail__main">
          <Skeleton height={460} radius={4} />
        </div>
        <div className="cnt-detail__side">
          <Skeleton height={200} radius={4} />
        </div>
      </div>
    </div>
  );
}

export default function AdminPostDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { can } = useAuth();
  const { refreshCounts } = useShell();
  const reduced = useReducedMotion();
  const { data, error, loading, reload, setData } = useApi(`/content/${id}`);
  const options = useApi(can("content.manage") ? "/content/options" : null);
  const material = data?.material;
  const [versionId, setVersionId] = useState(null);
  const [tab, setTab] = useState("comments");
  const [drawer, setDrawer] = useState(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  usePageTitle(material?.title ?? "Post", {
    crumbs: [{ label: "Conteúdo e calendário", to: "/admin/conteudo" }, { label: material?.title ?? "Post" }],
  });

  if (loading) return <DetailSkeleton />;
  if (error && !material)
    return (
      <div className="cnt-page">
        <PageHeader back={{ to: "/admin/conteudo", label: "Conteúdo e calendário" }} title="Post" />
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  if (!material) return null;

  const perms = material.permissions ?? {};
  const current = versionOf(material, material.currentVersionId);
  const editable = isEditableVersion(current);
  const version = versionOf(material, versionId) ?? current ?? material.versions?.[0];
  const slides = groupFiles(version?.files ?? []).originals.length;
  // Messages go to the version the client can see; a draft only when nothing was released yet.
  const commentVersion = version?.releasedAt ? version : versionOf(material, material.releasedVersionId) ?? version;
  const refresh = async () => {
    setVersionId(null);
    setRefreshKey((key) => key + 1);
    await reload().catch(() => {});
  };
  const replace = (next) => {
    if (next) setData({ material: next });
    setRefreshKey((key) => key + 1);
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post(`/materials/${material.id}/submit`);
      toast.success({ title: "Enviado para revisão interna", message: "A gestão foi avisada para conferir antes de liberar." });
      await refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const canEditPost = perms.canEdit && can("content.manage");
  const actions = (
    <>
      {current?.status === "draft" && perms.canEdit && (
        <Button icon={Send} loading={submitting} onClick={submit}>
          Enviar para revisão
        </Button>
      )}
      {editable && perms.canRelease && (
        <Button variant="primary" icon={Unlock} onClick={() => setReleaseOpen(true)}>
          Liberar ao cliente
        </Button>
      )}
      {!editable && perms.canUploadVersion && (
        <Button variant="primary" icon={FilePlus2} onClick={() => setDrawer("version")}>
          Nova versão
        </Button>
      )}
      <Menu
        label="Mais ações do post"
        items={[
          canEditPost && { label: "Editar dados do post", icon: Pencil, onSelect: () => setDrawer("edit") },
          editable && perms.canUploadVersion && { label: "Nova versão", icon: FilePlus2, disabled: true, description: "Libere ou descarte a versão atual antes." },
          { label: "Abrir na biblioteca", icon: Library, to: `/admin/biblioteca/${material.id}` },
        ]}
      />
    </>
  );

  return (
    <div className="cnt-page">
      <PageHeader
        back={{ to: "/admin/conteudo", label: "Conteúdo e calendário" }}
        eyebrow={`${material.client?.name}${material.brand?.name && material.brand.name !== material.client?.name ? ` · ${material.brand.name}` : ""}`}
        title={material.title}
        description={`${networkLabel(material.post?.network)} · ${postFormatLabel(material.post?.format)}${material.post?.campaign?.name ? ` · ${material.post.campaign.name}` : ""}`}
        actions={actions}
      />
      <PostAxes material={material} admin />

      <div className="cnt-detail">
        <div className="cnt-detail__main">
          <MaterialViewer material={material} versionId={version?.id} onVersionChange={setVersionId} />
          {editable && perms.canEdit && <DraftFilesPanel material={material} onChange={refresh} />}
        </div>

        <aside className="cnt-detail__side" aria-label="Estado e dados do post">
          <ApprovalPanel material={material} />
          <PublicationPanel material={material} onChange={replace} />
          <DeliveryPanel material={material} onChange={() => refresh()} />
          <Panel
            padding="md"
            actions={
              canEditPost ? (
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setDrawer("edit")}>
                  Editar
                </Button>
              ) : null
            }
            eyebrow={`Texto da versão ${version?.number ?? ""}`}
          >
            <CaptionBlock caption={version?.caption} hashtags={version?.hashtags} />
            {version?.notes && (
              <div className="ui-stack" style={{ "--gap": "10px", marginTop: 20 }}>
                <h3 className="rv-caption__title">Observações para o cliente</h3>
                <p className="cnt-notes">{version.notes}</p>
              </div>
            )}
          </Panel>
          <Panel padding="md" eyebrow="Atribuição" title="Dados do post">
            <dl className="cnt-facts">
              <div>
                <dt>Cliente</dt>
                <dd>{material.client?.name}</dd>
              </div>
              <div>
                <dt>Marca</dt>
                <dd>{material.brand?.name}</dd>
              </div>
              <div>
                <dt>Projeto</dt>
                <dd>{material.project?.name ?? "Sem projeto"}</dd>
              </div>
              <div>
                <dt>Categoria</dt>
                <dd>{material.category?.name}</dd>
              </div>
              <div>
                <dt>Responsável</dt>
                <dd>{material.owner?.name ?? "—"}</dd>
              </div>
              <div>
                <dt>Versão atual</dt>
                <dd>v{current?.number ?? "—"}</dd>
              </div>
              <div>
                <dt>Criado em</dt>
                <dd>{formatDate(material.createdAt)}</dd>
              </div>
              <div>
                <dt>Atualizado</dt>
                <dd>{formatDateTime(material.updatedAt)}</dd>
              </div>
            </dl>
            <div className="cnt-internal" style={{ marginTop: 20 }}>
              <p className="cnt-internal__flag">
                <Lock size={14} strokeWidth={1.5} aria-hidden="true" />
                Somente equipe
              </p>
              <p className="cnt-internal__label">Notas internas</p>
              <p className={material.internalNotes ? "cnt-internal__text" : "cnt-internal__text is-empty"}>
                {material.internalNotes || "Nenhuma nota interna."}
              </p>
              <p className="cnt-internal__hint">Nunca aparecem para o cliente.</p>
            </div>
          </Panel>
        </aside>

        <div className="cnt-detail__rest">
          <Panel padding="md">
            <Tabs
              aria-label="Conversa e histórico"
              value={tab}
              onChange={setTab}
              items={[
                { value: "comments", label: "Comentários" },
                { value: "versions", label: "Versões", count: material.versions?.length ?? 0 },
                { value: "approvals", label: "Aprovações" },
              ]}
            >
              {tab === "comments" ? (
                <CommentThread
                  materialId={material.id}
                  versionId={commentVersion?.id}
                  versionNumber={commentVersion?.number}
                  versionReleased={commentVersion ? Boolean(commentVersion.releasedAt) : undefined}
                  internalVersionId={version?.id}
                  internalVersionNumber={version?.number}
                  canInternal={can("comments.internal")}
                  slides={slides}
                  refreshKey={refreshKey}
                />
              ) : tab === "versions" ? (
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

      {canEditPost && (
        <EditPostDrawer
          open={drawer === "edit"}
          material={material}
          options={options.data}
          onClose={() => setDrawer(null)}
          onSaved={(next) => {
            replace(next);
            setDrawer(null);
          }}
        />
      )}
      {perms.canUploadVersion && (
        <NewVersionDrawer
          open={drawer === "version"}
          material={material}
          onClose={() => setDrawer(null)}
          onCreated={() => {
            setDrawer(null);
            refresh();
          }}
        />
      )}
      <ReleaseDialog
        open={releaseOpen}
        materialIds={[material.id]}
        onClose={() => setReleaseOpen(false)}
        onReleased={() => {
          // Keep the dialog on its "Liberado" confirmation (as in the library);
          // the page behind refreshes and "Concluir" closes it.
          refresh();
          refreshCounts?.();
        }}
      />
    </div>
  );
}
