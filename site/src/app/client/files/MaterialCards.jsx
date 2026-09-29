// Grid cards and list rows for released materials, both multi-selectable.
import { useState } from "react";
import { Download, Lock } from "lucide-react";
import {
  BulkJump,
  Checkbox,
  DataTable,
  IconButton,
  StatusBadge,
  Thumb,
  formatBytes,
  formatDate,
} from "../../ui/index.js";
import { cx, thumbBg } from "../brand/lib.js";
import { FormatList } from "../brand/parts.jsx";

const ICON = { strokeWidth: 1.4, "aria-hidden": true };

const releasedOf = (m) => m.version?.releasedAt || m.releasedAt || m.createdAt;
const THIS_YEAR = new Date().getFullYear();
const shortDate = (value) => {
  const text = formatDate(value, { year: false });
  return value && new Date(value).getFullYear() !== THIS_YEAR ? formatDate(value) : text;
};

const ratioOf = (m) => {
  const w = m.thumb?.width;
  const h = m.thumb?.height;
  return w > 0 && h > 0 ? Math.min(2.4, Math.max(0.56, w / h)) : 1;
};

export const approvalOf = (m) =>
  m.requiresApproval && m.approvalStatus && m.approvalStatus !== "none" ? m.approvalStatus : null;

const carouselBadge = (m) => (m.post?.format === "carrossel" ? "Carrossel" : null);

const INTERACTIVE = "button, a, input, label, [role='button']";

function DownloadButton({ material, busy, onDownload, size = "md" }) {
  const many = material.fileCount > 1;
  if (!material.downloadEnabled)
    return (
      <span className="mb-lockicon" title="Download ainda não liberado">
        <Lock size={15} {...ICON} />
        <span className="ui-sr-only">Download ainda não liberado</span>
      </span>
    );
  return (
    <IconButton
      label={many ? `Baixar os ${material.fileCount} arquivos de ${material.title} (ZIP)` : `Baixar ${material.title}`}
      tooltip={many ? "Baixar todos (ZIP)" : "Baixar arquivo"}
      icon={Download}
      size={size}
      variant="ghost"
      loading={busy}
      onClick={() => onDownload(material)}
    />
  );
}

// Artwork at its real proportion, centred in a calm square frame.
function Frame({ material, className }) {
  const ratio = ratioOf(material);
  const sizing = ratio >= 1 ? { width: "100%", height: "auto" } : { width: "auto", height: "100%" };
  return (
    <span className={cx("mb-frame", className)}>
      <span className="mb-frame__inner">
        <Thumb
          thumb={material.thumb}
          aspect={ratio}
          bg={thumbBg(material)}
          alt=""
          format={material.formats?.[0]}
          badge={carouselBadge(material)}
          style={sizing}
        />
      </span>
    </span>
  );
}

export function MaterialGrid({ items, selection, onOpen, onDownload, busyIds }) {
  // The card whose checkbox was toggled last offers "Ir para as ações em
  // lote (N)" to keyboard users (visible only when focused).
  const [lastToggled, setLastToggled] = useState(null);
  return (
    <ul className="mb-grid" aria-label="Arquivos">
      {items.map((material, index) => {
        const selectable = material.downloadEnabled;
        const selected = selection.has(material.id);
        const approval = approvalOf(material);
        return (
          <li
            key={material.id}
            className={cx("mb-card ui-enter ui-thumb-hover", selected && "is-selected")}
            style={{ "--i": Math.min(index, 8) }}
            onClick={(event) => {
              if (event.target.closest(INTERACTIVE)) return;
              onOpen(material);
            }}
          >
            <div className="mb-card__media">
              <Frame material={material} />
              <span className="mb-card__check">
                <Checkbox
                  size="lg"
                  checked={selected}
                  disabled={!selectable}
                  onCheckedChange={(on) => {
                    selection.toggle(material.id, on);
                    setLastToggled(material.id);
                  }}
                  aria-label={
                    selectable
                      ? `Selecionar ${material.title}`
                      : `${material.title}: download ainda não liberado`
                  }
                />
                {selected && lastToggled === material.id && <BulkJump count={selection.count} />}
              </span>
            </div>
            <div className="mb-card__body">
              <h3 className="mb-card__title">
                <button type="button" onClick={() => onOpen(material)}>
                  {material.title}
                </button>
              </h3>
              <p className="mb-card__meta">
                <span className="mb-card__metarow">
                  <span>{material.category?.name}</span>
                  {material.version?.number ? <span>v{material.version.number}</span> : null}
                  <time dateTime={releasedOf(material)}>{shortDate(releasedOf(material))}</time>
                </span>
              </p>
              {approval && <StatusBadge kind="approval" value={approval} size="sm" className="mb-card__status" />}
              <div className="mb-card__foot">
                <FormatList formats={material.formats || []} max={3} />
                <DownloadButton material={material} busy={busyIds.has(material.id)} onDownload={onDownload} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function MaterialTable({ items, selection, onOpen, onDownload, busyIds }) {
  const columns = [
    {
      key: "title",
      header: "Nome",
      primary: true,
      sortable: true,
      sortValue: (m) => m.title,
      render: (m) => {
        const approval = approvalOf(m);
        return (
          <span className="mb-rowname">
            <span className="mb-rowname__thumb">
              <Thumb thumb={m.thumb} aspect={1} bg={thumbBg(m)} alt="" format={m.formats?.[0]} showPlay={false} />
            </span>
            <span className="mb-rowname__text">
              <button type="button" className="mb-rowname__btn" onClick={() => onOpen(m)}>
                {m.title}
              </button>
              {approval && <StatusBadge kind="approval" value={approval} size="sm" />}
            </span>
          </span>
        );
      },
    },
    {
      key: "category",
      header: "Categoria",
      sortable: true,
      sortValue: (m) => m.category?.name,
      render: (m) => m.category?.name,
    },
    {
      key: "formats",
      header: "Formatos",
      // The column header already names the cell; the chips are read as a list.
      render: (m) => <FormatList formats={m.formats || []} max={2} prefix={null} />,
    },
    {
      key: "size",
      header: "Tamanho",
      align: "end",
      nowrap: true,
      sortable: true,
      sortValue: (m) => m.totalBytes || 0,
      render: (m) => (m.totalBytes ? formatBytes(m.totalBytes) : "—"),
    },
    {
      key: "version",
      header: "Versão",
      nowrap: true,
      sortable: true,
      sortValue: (m) => m.version?.number || 0,
      render: (m) => (m.version?.number ? `v${m.version.number}` : "—"),
    },
    {
      key: "date",
      header: "Data",
      nowrap: true,
      sortable: true,
      sortValue: (m) => releasedOf(m) || "",
      render: (m) => <time dateTime={releasedOf(m)}>{shortDate(releasedOf(m))}</time>,
    },
    {
      key: "actions",
      header: "Baixar",
      actions: true,
      align: "end",
      render: (m) => <DownloadButton material={m} busy={busyIds.has(m.id)} onDownload={onDownload} />,
    },
  ];
  return (
    <DataTable
      className="mb-table"
      columns={columns}
      rows={items}
      selectable
      selected={selection.selected}
      onSelectedChange={selection.set}
      isRowSelectable={(m) => m.downloadEnabled}
      rowLabel={(m) => m.title}
      onRowClick={(m) => onOpen(m)}
      dense
      aria-label="Arquivos"
    />
  );
}
