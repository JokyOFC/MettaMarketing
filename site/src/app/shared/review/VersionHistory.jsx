import { useMemo } from "react";
import { MessageSquareWarning } from "lucide-react";
import { StatusBadge, formatDate, formatDateTime, plural, useApi } from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { CheckMark } from "./ApprovalPanel.jsx";
import { cx } from "./util.js";
import "./review.css";

// Every version, newest first: number, dates, author, change summary, status
// and the decisions taken on it. Selecting a version shows it in the viewer.
export function VersionHistory({ material, onSelect, selectedId, className }) {
  const { user } = useAuth();
  const client = user?.role === "client";
  const { data } = useApi(material?.id ? `/materials/${material.id}/approvals` : null, {
    deps: [material?.approvalStatus, material?.releasedVersionId, material?.updatedAt],
  });
  const decisions = useMemo(() => {
    const map = new Map();
    for (const item of data?.items ?? []) {
      if (!map.has(item.versionId)) map.set(item.versionId, []);
      map.get(item.versionId).push(item);
    }
    return map;
  }, [data]);

  const versions = material?.versions ?? [];
  const Tag = onSelect ? "button" : "div";
  if (!versions.length)
    return <p className={cx("rv-empty-line", className)}>Nenhuma versão disponível ainda.</p>;

  return (
    <ol className={cx("rv-history", className)} aria-label="Versões">
      {versions.map((version, index) => {
        const selected = version.id === selectedId;
        const tags = [];
        // Clients: say whether this version still needs their decision; a
        // decided (approved / changes requested) version is just the current one.
        if (version.id === material.releasedVersionId)
          tags.push(
            client
              ? material.requiresApproval && material.approvalStatus === "pending"
                ? "Aguardando sua aprovação"
                : "Versão atual"
              : "Com o cliente",
          );
        if (!client && version.id === material.currentVersionId && version.id !== material.releasedVersionId) tags.push("Atual");
        const list = decisions.get(version.id) ?? [];
        return (
          <li key={version.id} className={cx("rv-history__item", "ui-enter", selected && "is-selected")} style={{ "--i": Math.min(index, 8) }}>
            <Tag
              {...(onSelect
                ? { type: "button", "aria-pressed": selected, onClick: () => onSelect(version.id) }
                : {})}
              className="rv-history__btn"
            >
              <span className="rv-history__num" aria-hidden="true">
                v{version.number}
              </span>
              <span className="rv-history__main">
                <span className="rv-history__top">
                  <span className="ui-sr-only">Versão {version.number}</span>
                  <StatusBadge kind="version" value={version.status} size="sm" />
                  {tags.map((tag) => (
                    <span key={tag} className="rv-chip rv-chip--quiet">
                      {tag}
                    </span>
                  ))}
                </span>
                <span className="rv-history__meta">
                  {version.releasedAt ? `Liberada em ${formatDate(version.releasedAt)}` : `Criada em ${formatDate(version.createdAt)}`}
                  {version.createdBy?.name ? ` · por ${version.createdBy.name}` : ""}
                  {` · ${plural(version.files?.filter((f) => f.role === "original").length ?? 0, "arquivo", "arquivos")}`}
                </span>
                {version.changeSummary && <span className="rv-history__summary">“{version.changeSummary}”</span>}
                {list.map((decision) => (
                  <span
                    key={decision.id}
                    className={cx("rv-history__decision", decision.decision === "approved" ? "is-approved" : "is-changes")}
                  >
                    {decision.decision === "approved" ? (
                      <CheckMark size={16} />
                    ) : (
                      <MessageSquareWarning size={14} strokeWidth={1.4} aria-hidden="true" />
                    )}
                    <span>
                      {decision.decision === "approved" ? "Aprovada" : "Ajustes pedidos"} por {decision.user?.name} ·{" "}
                      <time dateTime={decision.createdAt}>{formatDateTime(decision.createdAt)}</time>
                      {decision.comment && <span className="rv-history__quote">“{decision.comment}”</span>}
                    </span>
                  </span>
                ))}
              </span>
            </Tag>
          </li>
        );
      })}
    </ol>
  );
}

export default VersionHistory;
