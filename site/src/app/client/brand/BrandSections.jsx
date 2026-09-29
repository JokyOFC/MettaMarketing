// Manual da marca and the downloads area (ready-to-use, editables, kits).
import { ArrowUpRight, Download, ExternalLink, FileText, Lock, Package } from "lucide-react";
import { useDownloads } from "../../api/downloads.js";
import {
  Badge,
  Button,
  FileMeta,
  SkeletonRows,
  formatNumber,
  plural,
  statusLabel,
} from "../../ui/index.js";
import { cx, downloadBlock, filesOf, readyFiles } from "./lib.js";
import { FileChips, FileList, FormatList, ZipButton, versionLine } from "./parts.jsx";

const ICON = { strokeWidth: 1.4, "aria-hidden": true };

// ------------------------------------------------------------ manual

export function ManualCard({ material, details, index = 0 }) {
  const { downloadFile, isDownloading } = useDownloads();
  const detail = details.map[material.id];
  const failed = details.errors[material.id];
  const ready = readyFiles(filesOf(detail));
  const main = ready.find((f) => f.mediaKind === "pdf") || ready[0] || null;
  const others = ready.filter((f) => f !== main);
  const stream = main?.previews?.stream;
  const cover = material.thumb?.url;
  const busy = main && isDownloading(main.id);
  const blocked = main ? downloadBlock(main, material) : null;

  return (
    <article className="mb-manual ui-enter" style={{ "--i": Math.min(index, 8) }}>
      <div className={cx("mb-manual__cover", !cover && "is-document")}>
        {cover ? (
          <img src={cover} alt={`Capa de ${material.title}`} loading="lazy" decoding="async" />
        ) : (
          <span className="mb-manual__doc" aria-hidden="true">
            <FileText size={30} {...ICON} strokeWidth={1.2} />
            <span>{main?.format || material.formats?.[0] || "PDF"}</span>
            {main?.pages ? <small>{plural(main.pages, "página", "páginas")}</small> : null}
          </span>
        )}
      </div>
      <div className="mb-manual__body">
        <p className="ui-eyebrow">Manual da marca</p>
        <h3 className="mb-manual__title">{material.title}</h3>
        {material.description && <p className="mb-manual__desc">{material.description}</p>}
        {main ? (
          <FileMeta
            file={main}
            version={material.version?.number}
            date={material.version?.releasedAt || material.releasedAt}
            extra={main.pages ? plural(main.pages, "página", "páginas") : null}
          />
        ) : (
          <p className="mb-meta-line">{versionLine(material)}</p>
        )}
        <div className="mb-manual__actions">
          {!detail && !failed ? (
            <span className="mb-muted">Carregando arquivos…</span>
          ) : main ? (
            <>
              {stream && (
                <Button
                  href={stream}
                  target="_blank"
                  rel="noopener"
                  icon={ExternalLink}
                  aria-label={`Visualizar ${material.title} em nova aba`}
                >
                  Visualizar
                </Button>
              )}
              <Button
                variant="primary"
                icon={main.downloadable ? Download : Lock}
                loading={busy}
                disabled={!main.downloadable}
                onClick={() => downloadFile(main.id, { name: main.name })}
              >
                Baixar
              </Button>
            </>
          ) : (
            <Button to={`/painel/arquivos?material=${encodeURIComponent(material.id)}`} iconRight={ArrowUpRight}>
              Abrir em Arquivos
            </Button>
          )}
        </div>
        {blocked && (
          <p className="mb-chips__note">
            <Lock size={13} {...ICON} />
            <span>{blocked}</span>
          </p>
        )}
        {others.length > 0 && (
          <div className="mb-manual__more">
            <p className="mb-label">Outros formatos</p>
            <FileChips files={others} material={material} />
          </div>
        )}
      </div>
    </article>
  );
}

// ------------------------------------------------------------ downloads

export function DownloadsArea({
  brand,
  counts,
  editables,
  editablesLoading,
  editableCount,
  kits,
  onBrandKit,
}) {
  const { startZip } = useDownloads();
  const formats = counts?.formats || [];
  const files = counts?.files || 0;
  const released = (kits || []).filter((kit) => !kit.status || kit.status === "released");
  return (
    <div className="mb-downloads">
      <article className="mb-dlcard mb-dlcard--ready ui-enter">
        <p className="ui-eyebrow">Prontos para uso</p>
        <p className="mb-dlcard__figure">
          <span className="mb-dlcard__num">{formatNumber(files)}</span>
          <span>{files === 1 ? "arquivo" : "arquivos"}</span>
        </p>
        <FormatList as="p" formats={formats} prefix="Formatos disponíveis:" className="mb-dlcard__formats" />
        <p className="mb-dlcard__text">
          Os arquivos exatamente como a equipe enviou, organizados em pastas por categoria e
          formato no ZIP.
        </p>
        <div className="mb-dlcard__actions">
          {files > 0 && (
            <ZipButton variant="primary" icon={Package} start={onBrandKit}>
              Baixar kit completo (ZIP)
            </ZipButton>
          )}
          <Button variant="link" to="/painel/arquivos" iconRight={ArrowUpRight}>
            Ver todos os arquivos
          </Button>
        </div>
      </article>

      {editableCount > 0 && (
        <article className="mb-dlcard mb-dlcard--editable ui-enter" style={{ "--i": 1 }}>
          <div className="mb-dlcard__head">
            <p className="ui-eyebrow">Arquivos editáveis</p>
            <Badge tone="olive" dot>
              Incluídos no seu serviço
            </Badge>
          </div>
          <p className="mb-dlcard__text">
            Arquivos-fonte para ajustes futuros. Abra-os no programa em que foram criados.
          </p>
          {editablesLoading && !editables.length ? (
            <SkeletonRows rows={Math.min(editableCount, 3)} columns={2} media label="Carregando editáveis" />
          ) : editables.length ? (
            <FileList files={editables.map((e) => e.file)} label="Arquivos editáveis" />
          ) : (
            <p className="mb-muted">
              {plural(editableCount, "arquivo editável está incluído", "arquivos editáveis estão incluídos")}{" "}
              no kit completo (ZIP).
            </p>
          )}
        </article>
      )}

      {released.length > 0 && (
        <article className="mb-dlcard mb-dlcard--kits ui-enter" style={{ "--i": 2 }}>
          <p className="ui-eyebrow">Pacotes preparados pela Metta</p>
          <ul className="mb-kits">
            {released.map((kit) => (
              <li key={kit.id} className="mb-kit">
                <span className="mb-kit__icon" aria-hidden="true">
                  <Package size={18} {...ICON} />
                </span>
                <span className="mb-kit__text">
                  <strong>{kit.name}</strong>
                  <small>{statusLabel("kitKind", kit.kind)}</small>
                </span>
                <ZipButton
                  size="sm"
                  icon={Download}
                  start={() => startZip({ type: "kit", kitId: kit.id }, { label: `${kit.name} — ${brand.name}` })}
                  aria-label={`Baixar ${kit.name} (ZIP)`}
                >
                  ZIP
                </ZipButton>
              </li>
            ))}
          </ul>
        </article>
      )}
    </div>
  );
}

