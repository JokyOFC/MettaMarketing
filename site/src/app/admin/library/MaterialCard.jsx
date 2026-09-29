import { forwardRef } from "react";
import { Link } from "react-router-dom";
import { Layers, Star } from "lucide-react";
import { Checkbox, Menu, formatDate, variantLabel } from "../../ui/index.js";
import { Art, BulkJump, Formats, Handle, MaterialBadges, MoveButtons, VersionTag } from "./parts.jsx";
import { isLogo } from "./data.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");

export const materialPath = (material) =>
  material.kind === "post" ? `/admin/conteudo/${material.id}` : `/admin/biblioteca/${material.id}`;

// Library card: large artwork at its real proportion, separate visibility and
// approval badges, version and formats. Selection, primary star, menu and
// ordering controls are real buttons (keyboard and touch; nothing hover-only).
export const MaterialCard = forwardRef(function MaterialCard(
  {
    material,
    index = 0,
    selectable = false,
    selected = false,
    onToggle,
    jump = null,
    canStar = false,
    onStar,
    menuItems,
    showBrand = false,
    sort,
    stage = 4 / 3,
    className,
    ...rest
  },
  ref,
) {
  const to = materialPath(material);
  const logo = isLogo(material);
  // Stacked look only for multi-slide content, never for a logo in several formats.
  const slides =
    material.post?.format === "carrossel" || (material.category?.area === "content" && (material.fileCount ?? 0) > 1);
  const context = [
    showBrand && material.brand?.name,
    logo && material.variant ? variantLabel(material.variant) : material.category?.name,
  ].filter(Boolean);

  return (
    <article
      ref={ref}
      className={cx("lib-card ui-enter", selected && "is-selected", slides && "has-stack", className)}
      style={{ "--i": Math.min(index, 8) }}
      {...rest}
    >
      <div className="lib-card__media">
        <Link to={to} className="lib-card__art" tabIndex={-1} aria-hidden="true">
          <Art material={material} stage={stage} alt="" />
        </Link>
        {selectable && (
          <span className="lib-card__check">
            <Checkbox checked={selected} onCheckedChange={() => onToggle?.(material.id)} aria-label={`Selecionar ${material.title}`} />
          </span>
        )}
        {selectable && jump && <BulkJump count={jump.count} onJump={jump.onJump} className="lib-bulkjump--card" />}
        {logo && (canStar || material.isPrimary) && (
          <button
            type="button"
            className={cx("lib-card__star", material.isPrimary && "is-on")}
            aria-pressed={material.isPrimary}
            aria-label={
              material.isPrimary
                ? `${material.title} é a principal de ${variantLabel(material.variant) || "sua categoria"}`
                : `Definir ${material.title} como principal`
            }
            title={material.isPrimary ? "Arquivo principal" : "Definir como principal"}
            disabled={!canStar || material.isPrimary}
            onClick={() => onStar?.(material)}
          >
            <Star size={16} strokeWidth={1.4} aria-hidden="true" />
          </button>
        )}
        {slides && (
          <span className="lib-card__stack" aria-hidden="true">
            <Layers size={13} strokeWidth={1.5} />
            {material.post?.format === "carrossel" ? "Carrossel" : `${material.fileCount} slides`}
          </span>
        )}
      </div>
      <div className="lib-card__body">
        <div className="lib-card__row">
          <Link to={to} className="lib-card__title">
            {material.title}
          </Link>
          <VersionTag number={material.version?.number} />
        </div>
        {context.length > 0 && <p className="lib-card__meta">{context.join(" · ")}</p>}
        <div className="lib-card__foot">
          <MaterialBadges material={material} />
          <Formats formats={material.formats} max={3} />
        </div>
        {(material.dueDate || material.owner?.name) && (
          <p className="lib-card__small">
            {material.owner?.name}
            {material.owner?.name && material.dueDate ? " · " : ""}
            {material.dueDate ? `Prazo ${formatDate(material.dueDate, { year: false })}` : ""}
          </p>
        )}
        {menuItems?.length > 0 && (
          <div className="lib-card__menu">
            <Menu items={menuItems} label={`Ações de ${material.title}`} />
          </div>
        )}
      </div>
      {sort && (
        <div className="lib-card__sort">
          <Handle {...sort.handleProps} />
          <span className="lib-card__pos" aria-hidden="true">
            {sort.index + 1}
          </span>
          <MoveButtons axis="x" index={sort.index} count={sort.count} label={material.title} onMove={sort.onMove} />
        </div>
      )}
    </article>
  );
});
