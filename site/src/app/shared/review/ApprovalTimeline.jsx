import { MessageSquareWarning, Send } from "lucide-react";
import { ErrorState, SkeletonRows, formatDateTime, formatRelative, useApi } from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { CheckMark } from "./ApprovalPanel.jsx";
import { browserLabel, cx } from "./util.js";
import "./review.css";

// Decision log of a material, newest first: releases to the client, approvals
// and change requests, with who, when and which version. The team also sees
// the IP and browser recorded with each decision.
export function ApprovalTimeline({ materialId, refreshKey, className, empty }) {
  const { user } = useAuth();
  const staff = Boolean(user) && user.role !== "client";
  const { data, error, loading, reload } = useApi(materialId ? `/materials/${materialId}/approvals` : null, {
    deps: [refreshKey],
  });

  if (loading) return <SkeletonRows rows={3} columns={2} label="Carregando histórico de aprovação" />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} compact />;

  const events = [
    ...(data?.items ?? []).map((item) => ({ type: item.decision, at: item.createdAt, item })),
    ...(data?.releases ?? []).map((release) => ({ type: "released", at: release.releasedAt, item: release })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)) || (a.type === "released" ? 1 : -1));

  if (!events.length)
    return (
      <p className={cx("rv-empty-line", className)}>
        {empty ?? "Nenhuma versão foi liberada ao cliente ainda. As decisões aparecem aqui."}
      </p>
    );

  return (
    <ol className={cx("rv-timeline", className)} aria-label="Histórico de aprovação">
      {events.map(({ type, at, item }, index) => (
        <li key={`${type}-${item.id ?? item.versionId}-${index}`} className={cx("rv-timeline__item", `is-${type}`)}>
          <span className="rv-timeline__dot" aria-hidden="true">
            {type === "approved" ? (
              <CheckMark size={22} />
            ) : type === "changes_requested" ? (
              <MessageSquareWarning size={14} strokeWidth={1.4} />
            ) : (
              <Send size={13} strokeWidth={1.4} />
            )}
          </span>
          <div className="rv-timeline__body">
            <p className="rv-timeline__title">
              {type === "released" ? (
                <>
                  Versão {item.versionNumber} liberada para revisão
                  {staff && item.releasedBy?.name ? <span className="rv-timeline__by"> por {item.releasedBy.name}</span> : null}
                </>
              ) : (
                <>
                  <strong>{item.user?.name}</strong> {type === "approved" ? "aprovou a" : "pediu ajustes na"} versão {item.versionNumber}
                  {item.slidePosition ? ` · slide ${item.slidePosition}` : ""}
                </>
              )}
            </p>
            <p className="rv-timeline__time">
              <time dateTime={at} title={formatDateTime(at)}>
                {formatDateTime(at)}
              </time>
              <span aria-hidden="true"> · </span>
              <span>{formatRelative(at)}</span>
            </p>
            {item.comment && <p className="rv-timeline__quote">“{item.comment}”</p>}
            {staff && type !== "released" && (item.ip || item.userAgent) && (
              <p className="rv-timeline__audit">
                Registrado de {[item.ip && `IP ${item.ip}`, browserLabel(item.userAgent)].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default ApprovalTimeline;
