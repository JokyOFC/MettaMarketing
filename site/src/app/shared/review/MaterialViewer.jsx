import { useId, useRef, useState } from "react";
import { Download, ExternalLink, FileText, Grid2x2, Lock, Maximize2, Moon, Sun } from "lucide-react";
import {
  Button,
  FileGlyph,
  FileMeta,
  Modal,
  Segmented,
  Thumb,
  Tooltip,
  formatBytes,
  formatDate,
  plural,
  statusLabel,
  statusTone,
} from "../../ui/index.js";
import { useDownloads } from "../../api/downloads.js";
import { useAuth } from "../../auth/index.js";
import { CarouselViewer } from "./CarouselViewer.jsx";
import { VideoPlayer } from "./VideoPlayer.jsx";
import { ZipButton } from "./ZipButton.jsx";
import { cx, groupFiles, initialBackground, isArtwork, lockReason, ratioOf, stageUrl } from "./util.js";
import "./review.css";

const BACKGROUNDS = [
  { value: "light", label: "Fundo claro", icon: Sun },
  { value: "dark", label: "Fundo escuro", icon: Moon },
  { value: "checker", label: "Transparência", icon: Grid2x2 },
];

// ---------------------------------------------------------------- versions

// Chips "v3 · 12 out. · Aprovada" as a radiogroup (arrows move the choice).
export function VersionPicker({ versions, value, onChange, markers = {} }) {
  const ref = useRef(null);
  if (!versions?.length || versions.length < 2) return null;
  const move = (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(event.key in keys) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = versions.findIndex((v) => v.id === value);
    let next = index + (keys[event.key] ?? 0);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = versions.length - 1;
    next = (next + versions.length) % versions.length;
    onChange(versions[next].id);
    requestAnimationFrame(() => ref.current?.querySelector(`[data-id="${versions[next].id}"]`)?.focus());
  };
  return (
    <div ref={ref} className="rv-vpicker" role="radiogroup" aria-label="Versão exibida" onKeyDown={move}>
      {versions.map((version) => {
        const checked = version.id === value;
        const marker = markers[version.id];
        return (
          <button
            key={version.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-id={version.id}
            className={cx("rv-vpicker__opt", checked && "is-active")}
            onClick={() => onChange(version.id)}
          >
            <span className="rv-vpicker__num">v{version.number}</span>
            <span className="rv-vpicker__meta">
              <span>{formatDate(version.releasedAt || version.createdAt, { year: false })}</span>
              <span className={cx("rv-vpicker__status", `ui-tone--${statusTone("version", version.status)}`)}>
                <span className="rv-dot" aria-hidden="true" />
                {marker || statusLabel("version", version.status)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- stage

function StageImage({ url, alt, className }) {
  const [state, setState] = useState({ url, loaded: false });
  const loaded = state.url === url && state.loaded;
  if (state.url !== url) setState({ url, loaded: false });
  return (
    <span className={cx("rv-img", loaded && "is-loaded", className)}>
      {!loaded && <span className="rv-img__skel" aria-hidden="true" />}
      <img
        ref={(img) => {
          if (img?.complete && img.naturalWidth > 0 && !loaded) setState({ url, loaded: true });
        }}
        src={url}
        alt={alt}
        decoding="async"
        draggable={false}
        onLoad={() => setState({ url, loaded: true })}
      />
    </span>
  );
}

function DocumentCard({ file }) {
  return (
    <div className="rv-doc">
      <span className="rv-doc__icon" aria-hidden="true">
        <FileText size={26} strokeWidth={1.2} />
      </span>
      <p className="rv-doc__name">{file.name}</p>
      <p className="rv-doc__meta ui-num">
        {[file.format, formatBytes(file.sizeBytes), file.pages ? plural(file.pages, "página", "páginas") : null]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

function Stage({ files, cover, bg, onExpand, material, compact }) {
  const first = files[0];
  if (!first)
    return (
      <div className="rv-stage rv-stage--empty">
        <p>Esta versão ainda não tem arquivos de apresentação.</p>
      </div>
    );
  if (files.length > 1)
    return (
      <CarouselViewer
        files={files}
        bg={bg}
        onExpand={onExpand}
        label={`Slides de ${material.title}`}
        maxHeight={compact ? "420px" : undefined}
      />
    );

  const kind = first.mediaKind;
  if (kind === "video")
    return (
      <div className="rv-stage rv-stage--video">
        <VideoPlayer file={first} poster={cover} />
      </div>
    );

  if (kind === "pdf") {
    const coverUrl = stageUrl(cover) || stageUrl(first);
    return (
      <div className="rv-stage rv-stage--doc" style={{ "--ratio": coverUrl ? ratioOf(cover || first, 3 / 4) : undefined }}>
        {coverUrl ? (
          <button type="button" className="rv-stage__open" onClick={() => onExpand(0)} aria-label="Ampliar capa do documento">
            <StageImage url={coverUrl} alt={`Capa de ${first.name}`} />
          </button>
        ) : (
          <DocumentCard file={first} />
        )}
        {first.previews?.stream && (
          <Button
            href={first.previews.stream}
            target="_blank"
            rel="noopener"
            size="sm"
            icon={ExternalLink}
            className="rv-stage__doc-open"
          >
            Visualizar
          </Button>
        )}
      </div>
    );
  }

  const url = stageUrl(first);
  if (!url)
    return (
      <div className={cx("rv-stage rv-stage--glyph", `rv-bg--${bg}`)}>
        <FileGlyph kind={kind} format={first.format} name={first.name} status={first.previewStatus} />
      </div>
    );
  return (
    <div className={cx("rv-stage rv-stage--image", `rv-bg--${bg}`)} style={{ "--ratio": ratioOf(first, 1) }}>
      <button type="button" className="rv-stage__open" onClick={() => onExpand(0)} aria-label="Ampliar prévia">
        <StageImage url={url} alt={`Prévia de ${first.name}`} />
      </button>
      <span className="rv-stage__hint" aria-hidden="true">
        <Maximize2 size={14} strokeWidth={1.4} />
        Ampliar
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- files

// thumbBg: the artwork's preview background (a white logo on a light square
// would look empty); documents and posts keep the light square.
function FileRow({ file, version, material, position, thumbBg = "light" }) {
  const { downloadFile, isDownloading } = useDownloads();
  const reason = lockReason(file, material);
  return (
    <li className="rv-file">
      {position && (
        <span className="rv-file__pos" aria-hidden="true">
          {String(position).padStart(2, "0")}
        </span>
      )}
      <Thumb file={file} aspect={1} bg={thumbBg} fit="contain" showPlay={false} className="rv-file__thumb" alt="" />
      <div className="rv-file__info">
        <FileMeta file={file} version={version?.number} dimensions />
        {reason && (
          <p className="rv-file__lock">
            <Lock size={13} strokeWidth={1.4} aria-hidden="true" />
            {reason}
          </p>
        )}
      </div>
      {reason ? (
        <Tooltip content={reason}>
          <span className="rv-file__locked">
            <Button size="sm" icon={Lock} disabled aria-label={`Download indisponível: ${file.name}`}>
              Baixar
            </Button>
          </span>
        </Tooltip>
      ) : (
        <Button
          size="sm"
          icon={Download}
          loading={isDownloading(file.id)}
          onClick={() => downloadFile(file.id, { name: file.name })}
          aria-label={`Baixar ${file.name}`}
        >
          Baixar
        </Button>
      )}
    </li>
  );
}

function FileSection({ title, description, files, version, material, action, empty, tone, numbered, compact, thumbBg }) {
  const id = useId();
  if (!files.length && !empty) return null;
  return (
    <section className={cx("rv-files", tone && `rv-files--${tone}`)} aria-labelledby={id}>
      <div className="rv-files__head">
        <div className="rv-files__titles">
          <h3 id={id} className="rv-section-title">
            {title}
          </h3>
          {description && !compact && <p className="rv-files__desc">{description}</p>}
        </div>
        {action}
      </div>
      {files.length ? (
        <ul className="rv-files__list">
          {files.map((file, index) => (
            <FileRow
              key={file.id}
              file={file}
              version={version}
              material={material}
              position={numbered && files.length > 1 ? index + 1 : null}
              thumbBg={file.mediaKind === "image" || file.mediaKind === "vector" ? thumbBg : "light"}
            />
          ))}
        </ul>
      ) : (
        <p className="rv-files__empty">{empty}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- viewer

// An asset delivered in several formats of the same artwork (logo.svg,
// logo.png, logo.jpg) is one piece, not a carousel: the stage keeps one file
// per file name (the first that has a preview). Posts keep every slide.
function stageFilesFor(material, files) {
  if (material.kind === "post" || files.length < 2) return files;
  const stem = (file) => String(file.name || "").replace(/\.[^.]+$/, "").trim().toLowerCase();
  const picked = new Map();
  for (const file of files) {
    const key = stem(file) || file.id;
    const current = picked.get(key);
    if (!current || (!stageUrl(current) && stageUrl(file))) picked.set(key, file);
  }
  return files.filter((file) => picked.get(stem(file) || file.id) === file);
}

// "Baixar … (ZIP)" with the real progress of the job it starts.
function BulkZipButton({ material, version, files, isDefault }) {
  const downloads = useDownloads();
  const post = material.kind === "post";
  return (
    <ZipButton
      size="sm"
      variant="ghost"
      run={() =>
        post && isDefault
          ? downloads.startZip({ type: "carousel", materialId: material.id }, { label: `${material.title} — slides em ordem` })
          : downloads.downloadFiles(
              files.map((file) => file.id),
              { label: `${material.title} — v${version.number}` },
            )
      }
    >
      {post ? "Baixar slides em ordem (ZIP)" : "Baixar todos (ZIP)"}
    </ZipButton>
  );
}

// The heart of the review experience: a large preview (image, rasterised SVG,
// carousel, video with cover, PDF cover or card) with smooth expansion, the
// version selector and the four clearly separated file sections, each file
// with name, format, size, version, date and a download that respects
// file.downloadable. Logos get a light / dark / transparency background.
// bulkDownload={false} hides the "Baixar … (ZIP)" button when the host page
// already offers its own; afterPreview renders right below the preview (e.g.
// the decision panel on phones, before the file lists).
export function MaterialViewer({
  material,
  versionId,
  onVersionChange,
  compact = false,
  bulkDownload = true,
  afterPreview = null,
  className,
}) {
  const { user } = useAuth();
  const [innerId, setInnerId] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [slide, setSlide] = useState(0);
  const [bg, setBg] = useState(() => initialBackground(material));
  const client = user?.role === "client";

  if (!material) return null;
  const versions = material.versions ?? [];
  const defaultId = client
    ? material.releasedVersionId
    : material.currentVersionId ?? material.releasedVersionId ?? versions[0]?.id;
  const selectedId = versionId ?? innerId ?? defaultId;
  const version = versions.find((v) => v.id === selectedId) ?? versions.find((v) => v.id === defaultId) ?? versions[0];
  const select = (id) => {
    if (versionId === undefined) setInnerId(id);
    setSlide(0);
    onVersionChange?.(id);
  };

  const { originals, finals, editables, covers } = groupFiles(version?.files ?? []);
  const artwork = isArtwork(material, originals[0]);
  const stageBg = artwork ? bg : "neutral";
  const markers = {};
  if (material.releasedVersionId) markers[material.releasedVersionId] = client ? null : "Com o cliente";
  if (!client && material.currentVersionId && material.currentVersionId !== material.releasedVersionId)
    markers[material.currentVersionId] = null;

  const downloadable = originals.filter((file) => file.downloadable);
  const isDefault = version?.id === defaultId;
  const bulk =
    bulkDownload && downloadable.length > 1 ? (
      <BulkZipButton key={version?.id} material={material} version={version} files={downloadable} isDefault={isDefault} />
    ) : null;
  // Artwork file thumbnails follow the preview background (white logo on dark).
  const thumbBg = artwork ? bg : "light";

  const stageFiles = stageFilesFor(material, originals);
  const expandedFiles = stageFiles.length > 1 ? stageFiles : stageFiles.slice(0, 1);
  const cover = covers[0];
  const expandedSingle = expanded !== null && stageFiles.length <= 1 ? stageUrl(stageFiles[0]?.mediaKind === "pdf" ? cover || stageFiles[0] : stageFiles[0]) : null;

  return (
    <div className={cx("rv-viewer", compact && "rv-viewer--compact", className)}>
      <section className="rv-preview" aria-label="Prévia para visualização">
        <div className="rv-preview__head">
          <div className="rv-preview__titles">
            <h3 className="rv-section-title">Prévia para visualização</h3>
            {version && (
              <p className="rv-preview__version">
                Versão {version.number}
                {version.releasedAt ? ` · liberada em ${formatDate(version.releasedAt)}` : ` · criada em ${formatDate(version.createdAt)}`}
              </p>
            )}
          </div>
          {artwork && originals[0] && originals[0].mediaKind !== "video" && (
            <Segmented
              size="sm"
              iconOnly
              aria-label="Fundo da prévia"
              options={BACKGROUNDS}
              value={bg}
              onChange={setBg}
              className="rv-bgswitch"
            />
          )}
        </div>
        <VersionPicker versions={versions} value={version?.id} onChange={select} markers={markers} />
        <Stage
          key={version?.id}
          files={originals.length ? stageFiles : stageFilesFor(material, finals)}
          cover={cover}
          bg={stageBg}
          material={material}
          compact={compact}
          onExpand={(index) => {
            setSlide(index ?? 0);
            setExpanded(index ?? 0);
          }}
        />
        {!compact && (
          <p className="rv-preview__note">
            Prévias otimizadas para a tela. Os downloads preservam a qualidade original dos arquivos.
          </p>
        )}
      </section>

      {afterPreview}

      <FileSection
        title="Arquivo original"
        description="Arquivos apresentados nesta versão, na qualidade em que foram enviados."
        files={originals}
        version={version}
        material={material}
        action={bulk}
        numbered
        compact={compact}
        thumbBg={thumbBg}
      />
      {(finals.length > 0 || version?.status === "approved") && (
        <FileSection
          title="Arquivo final aprovado"
          description="Exportações finais desta versão, prontas para uso."
          files={finals}
          version={version}
          material={material}
          tone="final"
          compact={compact}
          thumbBg={thumbBg}
          empty={
            // Often the approved original is the deliverable: never promise
            // separate finals to the client.
            client
              ? "Versão aprovada. Os arquivos desta versão estão em “Arquivo original”; exportações finais separadas, quando houver, aparecem aqui."
              : "Versão aprovada e sem arquivos finais separados. Se a entrega tiver exportações finais, anexe-as e entregue ao cliente."
          }
        />
      )}
      {editables.length > 0 && (
        <FileSection
          title="Arquivo editável"
          description="Arquivos de trabalho incluídos no serviço, para ajustes futuros."
          files={editables}
          version={version}
          material={material}
          tone="editable"
          compact={compact}
          thumbBg={thumbBg}
        />
      )}

      <Modal
        open={expanded !== null}
        onClose={() => setExpanded(null)}
        size="xl"
        eyebrow={version ? `Versão ${version.number}` : undefined}
        title={material.title}
        className="rv-lightbox"
        headerAside={
          artwork ? (
            <Segmented size="sm" iconOnly aria-label="Fundo da prévia" options={BACKGROUNDS} value={bg} onChange={setBg} />
          ) : null
        }
      >
        {expanded !== null &&
          (expandedFiles.length > 1 ? (
            <CarouselViewer
              files={expandedFiles}
              index={slide}
              onIndexChange={setSlide}
              bg={stageBg}
              label={`Slides de ${material.title}`}
            />
          ) : expandedSingle ? (
            <div className={cx("rv-lightbox__stage", `rv-bg--${stageBg}`)}>
              <StageImage url={expandedSingle} alt={`Prévia ampliada de ${stageFiles[0]?.name ?? material.title}`} />
            </div>
          ) : null)}
      </Modal>
    </div>
  );
}

export default MaterialViewer;
