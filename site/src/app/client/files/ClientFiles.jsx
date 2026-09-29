// /painel/arquivos — every released delivery of the selected brand.
// URL: ?categoria=slug · ?area=identity|content|other · ?projeto=id · ?material=id
//      · ?kit=id (a released kit: only its materials, with the kit ZIP)
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { FolderDown, FolderOpen, LayoutGrid, List, Package, PackageOpen } from "lucide-react";
import { useDownloads } from "../../api/downloads.js";
import { useBrand, usePageTitle } from "../../shell/index.js";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  SkeletonCards,
  SkeletonRows,
  BulkBar,
  formatBytes,
  plural,
  useApi,
  useSelection,
  useToast,
} from "../../ui/index.js";
import {
  deliverableFiles,
  filesOf,
  loadMaterialDetail,
  readStored,
  writeStored,
} from "../brand/lib.js";
import FilesNav, { AREAS, areaOf, buildTree } from "./FilesNav.jsx";
import { MaterialGrid, MaterialTable } from "./MaterialCards.jsx";
import MaterialDrawer from "./MaterialDrawer.jsx";
import { ZipButton } from "../brand/parts.jsx";
import "../brand/brand.css";

const VIEW_KEY = "metta:arquivos:view";
const PAGE = 48;
const MAX_ZIP_MATERIALS = 1000; // selection limit of POST /api/zips

const SORTS = [
  { value: "recent", label: "Mais recentes" },
  { value: "oldest", label: "Mais antigos" },
  { value: "name", label: "Nome (A–Z)" },
];

const fold = (text) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const releasedOf = (m) => m.version?.releasedAt || m.releasedAt || m.createdAt || "";

function haystack(m) {
  return fold(
    [
      m.title,
      m.description,
      ...(m.tags || []),
      m.category?.name,
      m.project?.name,
      m.post?.campaign?.name,
      ...(m.formats || []),
    ].join(" "),
  );
}

function sortItems(items, sort) {
  const out = [...items];
  if (sort === "name") out.sort((a, b) => a.title.localeCompare(b.title, "pt-BR", { numeric: true }));
  else {
    out.sort((a, b) => releasedOf(b).localeCompare(releasedOf(a)));
    if (sort === "oldest") out.reverse();
  }
  return out;
}

function FilesSkeleton({ view }) {
  return (
    <div className="mb-files" aria-busy="true">
      <aside className="mb-files__aside" aria-hidden="true">
        <div className="mb-nav mb-nav--skel">
          {[70, 55, 62, 48, 58, 44].map((w, i) => (
            <Skeleton key={i} width={`${w}%`} height={12} />
          ))}
        </div>
      </aside>
      <div className="mb-files__main">
        {view === "list" ? (
          <SkeletonRows rows={8} columns={4} media label="Carregando arquivos" />
        ) : (
          <SkeletonCards count={8} aspect={1} minWidth={200} label="Carregando arquivos" />
        )}
      </div>
    </div>
  );
}

export default function ClientFiles() {
  usePageTitle("Arquivos");
  const { brand, brands, setBrandId } = useBrand();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const { startZip, downloadFile } = useDownloads();

  const categoria = params.get("categoria") || "";
  const area = categoria ? "" : params.get("area") || "";
  const projeto = params.get("projeto") || "";
  const materialId = params.get("material") || "";
  const kitId = params.get("kit") || "";

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [view, setViewState] = useState(() => (readStored(VIEW_KEY, "grid") === "list" ? "list" : "grid"));
  const [limit, setLimit] = useState(PAGE);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const setView = (next) => {
    setViewState(next);
    writeStored(VIEW_KEY, next);
  };

  const { data, error, loading, reload, setData } = useApi(
    brand ? `/materials?brandId=${encodeURIComponent(brand.id)}&sort=released` : null,
  );
  const all = useMemo(() => data?.items || [], [data]);
  const kitApi = useApi(kitId ? `/kits/${encodeURIComponent(kitId)}` : null);
  const kit = kitApi.data?.kit ?? null;
  // A kit link (notification) of the client's other brand switches to that brand.
  const kitBrandId = kit?.brand?.id;
  useEffect(() => {
    if (kitBrandId && brand && kitBrandId !== brand.id && brands?.some((b) => b.id === kitBrandId)) setBrandId(kitBrandId);
  }, [kitBrandId, brand, brands, setBrandId]);
  const kitMaterialIds = useMemo(() => (kit ? new Set(kit.materialIds ?? (kit.items ?? []).map((m) => m.id)) : null), [kit]);

  // ---------------------------------------------------------------- filters
  const projects = useMemo(() => {
    const map = new Map();
    for (const m of all) if (m.project?.id) map.set(m.project.id, m.project.name || "Projeto");
    return [...map].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  }, [all]);

  const q = fold(query.trim());
  // A new filter starts the list from the top again.
  const filterKey = [brand?.id, categoria, area, projeto, kitId, q, sort].join("|");
  const [limitKey, setLimitKey] = useState(filterKey);
  if (limitKey !== filterKey) {
    setLimitKey(filterKey);
    setLimit(PAGE);
  }
  const scoped = useMemo(
    () =>
      all.filter(
        (m) =>
          (!projeto || m.project?.id === projeto) &&
          (!kitId || (kitMaterialIds ? kitMaterialIds.has(m.id) : false)) &&
          (!q || haystack(m).includes(q)),
      ),
    [all, projeto, kitId, kitMaterialIds, q],
  );
  const tree = useMemo(() => buildTree(scoped), [scoped]);
  const filtered = useMemo(
    () =>
      sortItems(
        scoped.filter(
          (m) =>
            (!categoria || m.category?.slug === categoria) && (!area || areaOf(m) === area),
        ),
        sort,
      ),
    [scoped, categoria, area, sort],
  );
  const shown = filtered.slice(0, limit);
  const selectableIds = useMemo(
    () => filtered.filter((m) => m.downloadEnabled).map((m) => m.id),
    [filtered],
  );
  const selection = useSelection(selectableIds);

  const category = useMemo(() => {
    if (!categoria) return null;
    const hit = all.find((m) => m.category?.slug === categoria);
    return hit ? hit.category : { slug: categoria, name: "Categoria" };
  }, [all, categoria]);
  const areaInfo = AREAS.find((a) => a.key === area) || null;
  const project = projects.find((p) => p.value === projeto) || null;

  // ---------------------------------------------------------------- URL
  const hrefFor = (patch) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.delete("material");
    const text = next.toString();
    return { pathname: location.pathname, search: text ? `?${text}` : "" };
  };
  const setParam = (key, value) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const openMaterial = (material) => {
    const next = new URLSearchParams(params);
    next.set("material", material.id);
    setParams(next, { state: { mbDrawer: true } });
  };
  const closeMaterial = () => {
    if (location.state?.mbDrawer) navigate(-1);
    else setParam("material", null);
  };
  const clearFilters = () => {
    setQuery("");
    setParams(new URLSearchParams(), { replace: true });
  };

  // ---------------------------------------------------------------- downloads
  const brandName = brand?.name || "Marca";
  const downloadable = (list) => list.filter((m) => m.downloadEnabled).map((m) => m.id);

  const quickDownload = async (material) => {
    if (!material.downloadEnabled) return;
    if (material.fileCount > 1) {
      startZip({ type: "selection", materialIds: [material.id] }, { label: material.title });
      return;
    }
    setBusyIds((s) => new Set(s).add(material.id));
    try {
      const detail = await loadMaterialDetail(material);
      const files = deliverableFiles(filesOf(detail)).filter((f) => f.downloadable);
      if (files.length === 1) await downloadFile(files[0].id, { name: files[0].name });
      else if (files.length > 1)
        await startZip({ type: "selection", materialIds: [material.id] }, { label: material.title });
      else toast.error("Nenhum arquivo deste material está disponível para download.");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(material.id);
        return next;
      });
    }
  };

  const zipSelection = async () => {
    const ids = selection.ids;
    if (!ids.length) return;
    const job = await startZip(
      { type: "selection", materialIds: ids },
      { label: `${plural(ids.length, "material selecionado", "materiais selecionados")} — ${brandName}` },
    );
    if (job) selection.clear();
  };
  const zipCategory = () =>
    category?.id &&
    startZip(
      { type: "category", brandId: brand.id, categoryId: category.id },
      { label: `${category.name} — ${brandName}` },
    );
  const zipArea = () =>
    startZip(
      { type: "selection", materialIds: downloadable(filtered) },
      { label: `${areaInfo?.label} — ${brandName}` },
    );
  const zipProject = () =>
    startZip({ type: "project", projectId: projeto }, { label: `Pacote do projeto ${project?.label || ""}`.trim() });
  const zipKit = () => kit && startZip({ type: "kit", kitId: kit.id }, { label: `${kit.name} — ${brandName}` });
  const zipAll = () => {
    const ids = downloadable(all);
    if (ids.length > MAX_ZIP_MATERIALS) {
      toast.error("São muitos materiais para um único ZIP. Baixe por área, categoria ou projeto.");
      return null;
    }
    return startZip({ type: "selection", materialIds: ids }, { label: `Todos os arquivos — ${brandName}` });
  };

  // ---------------------------------------------------------------- render
  const header = (
    <PageHeader
      eyebrow={brand ? `Arquivos · ${brandName}` : "Arquivos"}
      title="Arquivos"
      accent="liberados"
      description="Tudo o que a Metta disponibilizou para a sua marca, por área e categoria. Baixe um arquivo, uma seleção ou pastas inteiras em ZIP."
      actions={
        all.length > 0 && (
          <ZipButton icon={PackageOpen} start={zipAll} disabled={!downloadable(all).length}>
            Baixar tudo desta marca
          </ZipButton>
        )
      }
    />
  );

  const summary = all.find((m) => m.id === materialId) || null;
  // The drawer keeps one position in the tree for every page state: moving it
  // would remount the dialog, and its close event would drop ?material.
  const drawer = (
    <MaterialDrawer
      id={materialId || null}
      summary={summary}
      onClose={closeMaterial}
      onChanged={(next) =>
        setData((d) =>
          d?.items
            ? { ...d, items: d.items.map((m) => (m.id === next.id ? { ...m, ...next } : m)) }
            : d,
        )
      }
    />
  );
  const frame = (body) => (
    <div className="mb-page">
      {header}
      {body}
      {drawer}
    </div>
  );

  if (!brand)
    return frame(
      <EmptyState
        icon={FolderOpen}
        title="Nenhuma marca vinculada à sua conta"
        description="Assim que a Metta cadastrar sua marca, os arquivos liberados aparecerão aqui."
      />,
    );
  if (loading && !data) return frame(<FilesSkeleton view={view} />);
  if (error && !data) return frame(<ErrorState error={error} onRetry={reload} />);
  if (!all.length)
    return frame(
      <EmptyState
        icon={FolderOpen}
        title="Nenhum arquivo liberado ainda"
        description={`Assim que a Metta liberar materiais para ${brandName}, eles aparecem aqui organizados por categoria, prontos para baixar.`}
        action={
          <Button to="/painel/projetos" variant="secondary">
            Acompanhar projetos
          </Button>
        }
      />,
    );

  const kitMissing = Boolean(kitId) && Boolean(kitApi.error);
  const scopeTitle = kit?.name || category?.name || areaInfo?.label || (kitMissing ? "Kit indisponível" : "Todos os arquivos");
  const scopeEyebrow = kitId
    ? "Kit"
    : category
      ? AREAS.find((a) => a.key === category.area)?.label || "Categoria"
      : areaInfo
        ? "Área"
        : brandName;
  const totalBytes = filtered.reduce((sum, m) => sum + (m.totalBytes || 0), 0);
  const activeFilters = (projeto ? 1 : 0) + (kitId ? 1 : 0) + (q ? 1 : 0);
  const selectedCount = selection.count;

  return frame(
    <>
      <div className="mb-files">
        <aside className="mb-files__aside">
          <FilesNav
            tree={tree}
            total={scoped.length}
            area={area}
            categoria={categoria}
            hrefFor={hrefFor}
          />
        </aside>

        <div className="mb-files__main">
          <FilterBar
            className="mb-toolbar"
            search={
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="Buscar por nome, etiqueta ou campanha"
                label="Buscar arquivos"
                shortcut="/"
              />
            }
            activeCount={activeFilters}
            onClear={activeFilters ? clearFilters : undefined}
          >
            {projects.length > 0 && (
              <Select
                aria-label="Projeto"
                value={projeto}
                onValueChange={(value) => setParam("projeto", value)}
                placeholder="Todos os projetos"
                options={projects}
              />
            )}
            <Select aria-label="Ordenar" value={sort} onValueChange={setSort} options={SORTS} />
          </FilterBar>

          <div className="mb-scope">
            <div className="mb-scope__titles">
              <p className="ui-eyebrow">{scopeEyebrow}</p>
              <h2 className="mb-scope__title">{scopeTitle}</h2>
              <p className="mb-scope__meta" aria-live="polite">
                {plural(filtered.length, "material", "materiais")}
                {totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ""}
                {project ? ` · ${project.label}` : ""}
              </p>
            </div>
            <div className="mb-scope__actions">
              {view === "grid" && selectableIds.length > 0 && (
                <Checkbox
                  className="mb-selectall"
                  checked={selection.isAll}
                  indeterminate={selection.isSome}
                  onChange={selection.toggleAll}
                  label={selection.isAll ? "Desmarcar todos" : "Selecionar todos"}
                />
              )}
              {category?.id && (
                <ZipButton key={`cat-${category.id}`} icon={FolderDown} start={zipCategory}>
                  Baixar categoria (ZIP)
                </ZipButton>
              )}
              {areaInfo && filtered.length > 0 && (
                <ZipButton
                  key={`area-${areaInfo.key}`}
                  icon={FolderDown}
                  start={zipArea}
                  disabled={!downloadable(filtered).length}
                >
                  Baixar {areaInfo.label.toLowerCase()} (ZIP)
                </ZipButton>
              )}
              {project && (
                <ZipButton key={`prj-${project.value}`} icon={Package} start={zipProject}>
                  Baixar pacote do projeto (ZIP)
                </ZipButton>
              )}
              {kit && (
                <ZipButton key={`kit-${kit.id}`} icon={Package} start={zipKit}>
                  Baixar kit (ZIP)
                </ZipButton>
              )}
              <Segmented
                iconOnly
                aria-label="Visualização"
                value={view}
                onChange={setView}
                options={[
                  { value: "grid", label: "Grade", icon: LayoutGrid },
                  { value: "list", label: "Lista", icon: List },
                ]}
              />
            </div>
          </div>

          {/* Right after the controls and before the files, so the selection
              actions are a couple of Tab presses away from the checkboxes. */}
          <BulkBar
            count={selectedCount}
            onClear={selection.clear}
            label="Arquivos selecionados"
            noun={["material selecionado", "materiais selecionados"]}
          >
            <button type="button" className="ui-bulkbar__action" onClick={zipSelection}>
              <FolderDown size={16} strokeWidth={1.4} aria-hidden="true" />
              <span>Baixar selecionados (ZIP)</span>
            </button>
          </BulkBar>

          {filtered.length === 0 ? (
            <EmptyState
              compact
              icon={FolderOpen}
              title={q ? "Nenhum arquivo encontrado" : kitMissing ? "Este kit não está disponível" : "Nada nesta categoria ainda"}
              description={
                q
                  ? "Tente outras palavras ou limpe os filtros para ver todos os arquivos."
                  : kitMissing
                    ? "Ele pode ter sido arquivado pela equipe Metta. Os arquivos liberados continuam na lista completa."
                    : "Quando a Metta liberar arquivos aqui, eles aparecem nesta lista."
              }
              action={
                <Button variant="secondary" onClick={clearFilters}>
                  Ver todos os arquivos
                </Button>
              }
            />
          ) : view === "list" ? (
            <MaterialTable
              items={shown}
              selection={selection}
              onOpen={openMaterial}
              onDownload={quickDownload}
              busyIds={busyIds}
            />
          ) : (
            <MaterialGrid
              items={shown}
              selection={selection}
              onOpen={openMaterial}
              onDownload={quickDownload}
              busyIds={busyIds}
            />
          )}

          {filtered.length > shown.length && (
            <div className="mb-more">
              <Button onClick={() => setLimit((n) => n + PAGE)}>
                Mostrar mais ({filtered.length - shown.length} restantes)
              </Button>
            </div>
          )}
        </div>
      </div>

      {selectedCount > 0 && <div className="mb-bulk-spacer" aria-hidden="true" />}
    </>,
  );
}
