// Slice D's shared review components (src/app/shared/review/*), wrapped so a
// component that fails at runtime falls back to a small local version instead
// of taking the whole library page down.
import { Component, useMemo, useState } from "react";
import { Download, MessageSquare } from "lucide-react";
import {
  Button,
  EmptyState,
  FileMeta,
  Select,
  StatusBadge,
  Thumb,
  fileRoleLabel,
  formatDate,
} from "../../ui/index.js";
import { useDownloads } from "../../api/downloads.js";
import * as review from "../../shared/review/index.js";
import { artBackground } from "./data.js";

class SlotBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    if (import.meta.env?.DEV) console.warn("[library] review component failed, using fallback", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function slot(name, Fallback) {
  const Shared = review[name] || Fallback;
  function Slot(props) {
    return (
      <SlotBoundary fallback={<Fallback {...props} />}>
        <Shared {...props} />
      </SlotBoundary>
    );
  }
  Slot.displayName = `Review(${name})`;
  return Slot;
}

// ---------------------------------------------------------------- fallbacks

// Big preview of the chosen version plus its files by role.
function FallbackViewer({ material, versionId, onVersionChange }) {
  const { downloadFile, isDownloading } = useDownloads();
  const versions = material?.versions ?? [];
  const [local, setLocal] = useState(null);
  const current = versionId ?? local ?? versions[0]?.id;
  const version = versions.find((v) => v.id === current) ?? versions[0];
  const files = version?.files ?? [];
  const main = files.find((f) => f.role === "cover") ?? files.find((f) => f.role === "original") ?? files[0];
  const groups = useMemo(() => {
    const map = new Map();
    for (const file of files) {
      if (!map.has(file.role)) map.set(file.role, []);
      map.get(file.role).push(file);
    }
    return [...map.entries()];
  }, [files]);

  if (!version) return <EmptyState compact title="Sem versões ainda" description="Envie arquivos para criar a primeira versão." />;
  return (
    <div className="lib-fallback-viewer">
      <div className="lib-fallback-viewer__stage">
        <Thumb file={main} rendition="preview" aspect="4/3" bg={artBackground(material)} fit="contain" alt={material.title} />
      </div>
      {versions.length > 1 && (
        <div className="lib-fallback-viewer__bar">
          <Select
            size="sm"
            aria-label="Versão"
            value={version.id}
            onValueChange={(value) => (onVersionChange ? onVersionChange(value) : setLocal(value))}
            options={versions.map((v) => ({ value: v.id, label: `Versão ${v.number} · ${formatDate(v.createdAt)}` }))}
          />
          <StatusBadge kind="version" value={version.status} size="sm" />
        </div>
      )}
      {groups.map(([role, list]) => (
        <section key={role} className="lib-fallback-viewer__files">
          <h3 className="lib-mini-title">{role === "original" ? "Arquivo original" : fileRoleLabel(role)}</h3>
          <ul>
            {list.map((file) => (
              <li key={file.id}>
                <FileMeta file={file} version={version.number} layout="inline" />
                {role !== "cover" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Download}
                    loading={isDownloading?.(file.id)}
                    onClick={() => downloadFile(file.id, { name: file.name })}
                  >
                    Baixar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FallbackComments() {
  return (
    <EmptyState
      compact
      icon={MessageSquare}
      title="Comentários indisponíveis agora"
      description="Recarregue a página em instantes para ver a conversa com o cliente e as notas internas."
    />
  );
}

function FallbackVersions({ material, onSelect }) {
  const versions = material?.versions ?? [];
  if (!versions.length) return <EmptyState compact title="Nenhuma versão ainda" />;
  return (
    <ol className="lib-versions">
      {versions.map((version) => (
        <li key={version.id}>
          <button type="button" className="lib-versions__item" onClick={() => onSelect?.(version.id)}>
            <span className="lib-vtag">v{version.number}</span>
            <span className="lib-versions__text">
              <span>{version.changeSummary || (version.number === 1 ? "Primeira versão" : "Nova versão")}</span>
              <small>
                {version.createdBy?.name ? `${version.createdBy.name} · ` : ""}
                {formatDate(version.createdAt)} · {version.files?.length ?? 0} arquivos
              </small>
            </span>
            <StatusBadge kind="version" value={version.status} size="sm" />
          </button>
        </li>
      ))}
    </ol>
  );
}

export const MaterialViewer = slot("MaterialViewer", FallbackViewer);
export const CommentThread = slot("CommentThread", FallbackComments);
export const VersionHistory = slot("VersionHistory", FallbackVersions);
