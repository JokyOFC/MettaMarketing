import { StatusBadge, formatDate, formatDateTime } from "../../ui/index.js";
import { cx, versionOf } from "./util.js";
import "./review.css";

// Independent axes of a post side by side: visibility (team only), approval,
// publication, delivery of final files and planned date. They are never
// merged into one status (approved ≠ delivered ≠ scheduled ≠ published).
export function PostAxes({ material, admin = false }) {
  const post = material.post ?? {};
  const released = versionOf(material, material.releasedVersionId);
  const approved = versionOf(material, material.approvedVersionId);
  let approvalNote = "";
  if (material.approvalStatus === "approved") approvalNote = `Versão ${approved?.number ?? released?.number} aprovada`;
  else if (material.approvalStatus === "none")
    approvalNote = admin && material.visibility !== "released" ? "Começa quando for liberado" : "Não precisa de aprovação";
  else if (released)
    approvalNote = `Versão ${released.number} ${material.approvalStatus === "changes_requested" ? "com ajustes pedidos" : "em revisão"}`;

  const by = (person) => (admin && person?.name ? ` · ${person.name}` : "");
  let publicationNote;
  if (post.publicationStatus === "published")
    publicationNote = post.publishedAt ? `Em ${formatDateTime(post.publishedAt)}${by(post.publishedBy)}` : "";
  else if (post.publicationStatus === "scheduled")
    publicationNote = post.scheduledAt ? `Para ${formatDateTime(post.scheduledAt)}${by(post.scheduledBy)}` : "";
  else publicationNote = admin ? "Marcado à mão pela equipe" : "A equipe marca quando agendar";

  // Delivery = final files made available (materials.deliveredAt).
  const delivered = Boolean(material.deliveredAt);
  const pendingDelivery = admin && delivered && material.pendingDeliveryCount > 0;

  return (
    <div className={cx("cnt-axes", admin ? "cnt-axes--5" : "cnt-axes--4")}>
      {admin && (
        <div className="cnt-axis">
          <span className="cnt-axis__label">Visibilidade</span>
          <StatusBadge kind="visibility" value={material.visibility} />
          <span className="cnt-axis__note">
            {material.visibility === "released" && material.releasedAt
              ? `Liberado em ${formatDate(material.releasedAt)}`
              : "Privado para a equipe"}
          </span>
        </div>
      )}
      <div className="cnt-axis">
        <span className="cnt-axis__label">Aprovação</span>
        <StatusBadge kind="approval" value={material.approvalStatus} />
        {approvalNote && <span className="cnt-axis__note">{approvalNote}</span>}
      </div>
      <div className="cnt-axis">
        <span className="cnt-axis__label">Publicação</span>
        <StatusBadge kind="publication" value={post.publicationStatus ?? "not_scheduled"} />
        <span className="cnt-axis__note">{publicationNote}</span>
      </div>
      <div className="cnt-axis">
        <span className="cnt-axis__label">Entrega</span>
        {delivered ? (
          <StatusBadge kind="delivered" value={material.deliveredAt} />
        ) : (
          <span className="cnt-axis__quiet">{admin ? "Arquivos finais não entregues" : "Sem entrega de arquivos finais"}</span>
        )}
        {(delivered || admin) && (
          <span className="cnt-axis__note">
            {delivered
              ? `Em ${formatDate(material.deliveredAt)}${pendingDelivery ? " · novos arquivos aguardando entrega" : ""}`
              : "Separada da aprovação e da publicação"}
          </span>
        )}
      </div>
      <div className="cnt-axis">
        <span className="cnt-axis__label">Data prevista</span>
        <span className="ui-num">
          {post.plannedDate ? `${formatDate(post.plannedDate)}${post.plannedTime ? `, ${post.plannedTime}` : ""}` : "A definir"}
        </span>
        {post.publishedUrl && (
          <a className="ui-link cnt-axis__note" href={post.publishedUrl} target="_blank" rel="noopener noreferrer">
            Ver publicação na rede
          </a>
        )}
      </div>
    </div>
  );
}

export default PostAxes;
