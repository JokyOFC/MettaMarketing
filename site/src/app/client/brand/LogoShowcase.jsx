// Logo principal, variants grid and the lightbox with the background switcher.
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, ChevronLeft, ChevronRight } from "lucide-react";
import { FileMeta, Modal, formatBytes, variantLabel } from "../../ui/index.js";
import {
  defaultBg,
  editableFiles,
  filesOf,
  previewFile,
  readyFiles,
} from "./lib.js";
import { BgSwitcher, FileChips, LogoStage, versionLine } from "./parts.jsx";

const ICON = { strokeWidth: 1.4, "aria-hidden": true };

// Everything a logo card needs from the (possibly still loading) detail.
function useLogoData(material, details) {
  const detail = details.map[material.id];
  const failed = details.errors[material.id];
  const files = filesOf(detail);
  const ready = readyFiles(files);
  const editable = editableFiles(files);
  const main = ready[0] || null;
  const preview = previewFile(detail, material);
  return {
    detail,
    failed,
    loading: !detail && !failed,
    ready,
    editable,
    main,
    preview,
    thumbUrl: preview?.previews?.thumb || material.thumb?.url || null,
    largeUrl: preview?.previews?.preview || preview?.previews?.thumb || material.thumb?.url || null,
    totalBytes: [...ready, ...editable].reduce((sum, f) => sum + (f.sizeBytes || 0), 0),
  };
}

const filesHref = (material) => `/painel/arquivos?material=${encodeURIComponent(material.id)}`;

function FilesLink({ material }) {
  return (
    <Link className="mb-textlink" to={filesHref(material)}>
      <span>Ver versões e detalhes</span>
      <ArrowUpRight size={14} {...ICON} />
    </Link>
  );
}

// Chips (or the formats the list promised, when the detail failed).
function Formats({ material, data, layout }) {
  if (data.failed)
    return (
      <p className="mb-formats-fallback">
        {material.formats?.map((f) => (
          <span key={f} className="ui-format">
            {f}
          </span>
        ))}
        <span className="mb-muted">Abra em Arquivos para baixar.</span>
      </p>
    );
  return (
    <FileChips
      files={data.ready}
      editable={material.editableIncluded ? data.editable : []}
      material={material}
      loading={data.loading}
      formats={material.formats}
      layout={layout}
    />
  );
}

// ------------------------------------------------------------ principal

export function PrincipalLogo({ material, details, onOpen }) {
  const [bg, setBg] = useState(() => defaultBg(material));
  const data = useLogoData(material, details);
  return (
    <div className="mb-principal ui-enter">
      <div className="mb-principal__stage">
        <LogoStage
          url={data.largeUrl}
          bg={bg}
          size="lg"
          format={material.formats?.[0]}
          mediaKind={material.thumb?.mediaKind}
          onOpen={() => onOpen(material, bg)}
          openLabel={`Ampliar ${material.title}`}
        />
        <div className="mb-principal__switch">
          <BgSwitcher value={bg} onChange={setBg} iconOnly={false} />
        </div>
      </div>
      <div className="mb-principal__info">
        <p className="ui-eyebrow">Logo principal</p>
        <h3 className="mb-principal__title">{material.title}</h3>
        {material.description && <p className="mb-principal__desc">{material.description}</p>}
        {data.main ? (
          <FileMeta
            className="mb-principal__meta"
            file={data.main}
            version={material.version?.number}
            date={material.version?.releasedAt || material.releasedAt}
            dimensions
          />
        ) : (
          <p className="mb-meta-line">{versionLine(material)}</p>
        )}
        <div className="mb-principal__formats">
          <p className="mb-label">Baixar em</p>
          <Formats material={material} data={data} />
        </div>
        <FilesLink material={material} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ variants

// Card with its own ground switcher (for artwork with transparency) and the
// downloads listed like a spec sheet.
export function LogoCard({ material, details, onOpen, index, eyebrow, switcher = true, padded = true }) {
  const [bg, setBg] = useState(() => defaultBg(material));
  const data = useLogoData(material, details);
  return (
    <article className="mb-logo ui-enter" style={{ "--i": Math.min(index, 8) }}>
      <LogoStage
        url={data.thumbUrl}
        bg={bg}
        format={material.formats?.[0]}
        mediaKind={material.thumb?.mediaKind}
        onOpen={() => onOpen(material, bg)}
        openLabel={`Ampliar ${material.title}`}
        className={padded ? undefined : "is-tight"}
      />
      <div className="mb-logo__body">
        <div className="mb-logo__top">
          <div className="mb-logo__titles">
            {eyebrow && <p className="mb-logo__eyebrow">{eyebrow}</p>}
            <h4 className="mb-logo__title">{material.title}</h4>
            <p className="mb-meta-line">{versionLine(material)}</p>
          </div>
          {switcher && (
            <BgSwitcher
              value={bg}
              onChange={setBg}
              label={`Fundo da prévia de ${material.title}`}
              className="mb-logo__bgs"
            />
          )}
        </div>
        <Formats material={material} data={data} layout="rows" />
      </div>
    </article>
  );
}

// items: [{ material, eyebrow }] in one responsive grid.
export function LogoGallery({ title, hint, items, details, onOpen, switcher = true, padded = true }) {
  if (!items.length) return null;
  return (
    <section className="mb-group" aria-label={title || undefined}>
      {(title || hint) && (
        <div className="mb-group__head">
          {title && <h3 className="mb-group__title">{title}</h3>}
          {hint && <p className="mb-group__hint">{hint}</p>}
        </div>
      )}
      <div className="mb-logogrid">
        {items.map(({ material, eyebrow }, i) => (
          <LogoCard
            key={material.id}
            material={material}
            eyebrow={eyebrow}
            details={details}
            onOpen={onOpen}
            index={i}
            switcher={switcher}
            padded={padded}
          />
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ lightbox

// Keys that move between logos, and targets that keep their own arrows.
const STEP_KEYS = { ArrowRight: 1, ArrowLeft: -1 };
const OWN_ARROWS = "[role='radiogroup'], [role='tablist'], input, textarea, select, [contenteditable='true']";

// Enlarged preview with the same switcher; the previous / next buttons and
// the arrow keys (anywhere in the dialog) move between logos. Only the
// per-logo content changes: the controls stay mounted, so focus stays on the
// button that was pressed.
export function LogoLightbox({ items, open, onClose, details }) {
  const [state, setState] = useState({ from: null, index: 0, bg: "light" });
  // A new `open` request resets the position; closing keeps the last logo on
  // screen while the dialog fades out.
  if (open && state.from !== open) setState({ from: open, index: open.index, bg: open.bg });
  const index = open && state.from !== open ? open.index : state.index;
  const shown = items[index] || null;
  const many = items.length > 1;

  const move = useCallback(
    (step) =>
      setState((s) => {
        const next = (s.index + step + items.length) % items.length;
        return { ...s, index: next, bg: defaultBg(items[next]) };
      }),
    [items],
  );

  // Bound on a wrapper around the dialog (the dialog is not portalled), so it
  // also works from the header's close button.
  const onKeyDown = (event) => {
    const step = STEP_KEYS[event.key];
    if (!open || !many || !step || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target.closest?.(OWN_ARROWS)) return;
    event.preventDefault();
    move(step);
  };

  return (
    <div className="mb-lightbox-scope" onKeyDown={onKeyDown}>
      <Modal
        open={Boolean(open)}
        onClose={onClose}
        size="xl"
        className="mb-lightbox"
        eyebrow={shown ? variantLabel(shown.variant) || shown.category?.name : undefined}
        title={shown?.title}
      >
        {shown && (
          <div className="mb-lightbox__body">
            <div className="mb-lightbox__stage">
              {/* a fresh image per logo; nothing focusable lives here */}
              <LightboxStage key={shown.id} material={shown} details={details} bg={state.bg} />
            </div>
            <div className="mb-lightbox__bar">
              <BgSwitcher value={state.bg} onChange={(bg) => setState((s) => ({ ...s, bg }))} iconOnly={false} />
              {many && (
                <div className="mb-lightbox__nav" role="group" aria-label="Navegar entre os logos">
                  <button type="button" className="mb-navbtn" onClick={() => move(-1)} aria-label="Logo anterior">
                    <ChevronLeft size={18} {...ICON} />
                  </button>
                  <span className="mb-lightbox__count" aria-hidden="true">
                    {index + 1} / {items.length}
                  </span>
                  <button type="button" className="mb-navbtn" onClick={() => move(1)} aria-label="Próximo logo">
                    <ChevronRight size={18} {...ICON} />
                  </button>
                </div>
              )}
            </div>
            <LightboxInfo material={shown} details={details} />
            {many && (
              <span className="ui-sr-only" role="status" aria-live="polite">
                {`${shown.title}, ${index + 1} de ${items.length}`}
              </span>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function LightboxStage({ material, details, bg }) {
  const data = useLogoData(material, details);
  return (
    <LogoStage
      url={data.largeUrl}
      alt={`Prévia de ${material.title}`}
      bg={bg}
      size="xl"
      format={material.formats?.[0]}
      mediaKind={material.thumb?.mediaKind}
    />
  );
}

function LightboxInfo({ material, details }) {
  const data = useLogoData(material, details);
  return (
    <div className="mb-lightbox__info">
      <div>
        {data.main ? (
          <FileMeta
            file={data.main}
            version={material.version?.number}
            date={material.version?.releasedAt || material.releasedAt}
            dimensions
          />
        ) : (
          <p className="mb-meta-line">{versionLine(material)}</p>
        )}
        {data.totalBytes > 0 && (
          <p className="mb-meta-line">
            {data.ready.length + (material.editableIncluded ? data.editable.length : 0)} arquivos ·{" "}
            {formatBytes(data.totalBytes)}
          </p>
        )}
      </div>
      <Formats material={material} data={data} />
      <FilesLink material={material} />
    </div>
  );
}
