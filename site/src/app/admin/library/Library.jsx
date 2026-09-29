import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  CloudUpload,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  FolderInput,
  FolderOpen,
  LayoutGrid,
  List,
  ListOrdered,
  Package,
  Palette,
  Send,
  SlidersHorizontal,
  Star,
  UserRound,
  X,
} from "lucide-react";
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Menu,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  SkeletonCards,
  Switch,
  formatRelative,
  statusLabel,
  statusOptions,
  useApi,
  useIsNarrow,
  useSelection,
  useToast,
  variantLabel,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useDownloads } from "../../api/downloads.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import ReleaseDialog from "./ReleaseDialog.jsx";
import { MaterialCard, materialPath } from "./MaterialCard.jsx";
import { Art, BulkJump, Formats, LibBulkBar, Live, MaterialBadges, SectionHead, VersionTag } from "./parts.jsx";
import { brandClientId, isLogo, itemsOf, materialsLabel, useBrands, useCategories, useClients, useOwners, useProjects } from "./data.js";
import { useDragSort } from "./useDragSort.js";
import "./library.css";

const PAGE_SIZE = 120;
const FILTER_KEYS = ["clientId", "brandId", "projectId", "categoryId", "visibility", "approval", "ownerId", "tag", "q"];
const NARROWING = ["projectId", "visibility", "approval", "ownerId", "tag", "q"];
// Filters that live behind the "Filtros" button on wide screens (phones keep
// every filter there, see LibraryFilters).
const SECONDARY = ["projectId", "visibility", "approval", "ownerId", "tag"];

function readFilters(params) {
  const out = {};
  for (const key of FILTER_KEYS) out[key] = params.get(key) || "";
  out.archived = params.get("archived") === "1";
  out.view = params.get("view") === "list" ? "list" : "grid";
  out.page = Math.max(1, Number(params.get("page")) || 1);
  return out;
}

const countOf = (value, fallback) => (typeof value === "number" ? value : Array.isArray(value) ? value.length : fallback);

export default function Library() {
  usePageTitle("Biblioteca de arquivos");
  const { can, user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { startZip } = useDownloads();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);

  const clients = useClients();
  const brands = useBrands();
  const projects = useProjects(filters.brandId || null);
  const categories = useCategories();
  const owners = useOwners(null);

  const setFilters = useCallback(
    (patch, { keepPage = false } = {}) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === "" || value === null || value === undefined || value === false) next.delete(key);
            else next.set(key, value === true ? "1" : String(value));
          }
          if (!keepPage && !("page" in patch)) next.delete("page");
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const query = {
    brandId: filters.brandId || undefined,
    clientId: filters.clientId || undefined,
    projectId: filters.projectId || undefined,
    categoryId: filters.categoryId || undefined,
    visibility: filters.visibility || undefined,
    approval: filters.approval || undefined,
    ownerId: filters.ownerId || undefined,
    tag: filters.tag || undefined,
    q: filters.q || undefined,
    archived: filters.archived ? 1 : undefined,
    sort: "sortOrder",
    page: filters.page,
    pageSize: PAGE_SIZE,
  };
  const list = useApi("/materials", { params: query });
  const items = useMemo(() => {
    let rows = itemsOf(list.data);
    if (filters.clientId && !filters.brandId) rows = rows.filter((m) => !m.client?.id || m.client.id === filters.clientId);
    return rows;
  }, [list.data, filters.clientId, filters.brandId]);
  const total = typeof list.data?.total === "number" ? list.data.total : items.length;
  const selection = useSelection(items.map((m) => m.id));
  const selectedItems = items.filter((m) => selection.has(m.id));
  const selectedBrandIds = new Set(selectedItems.map((m) => m.brand?.id).filter(Boolean));
  const mixedBrands = selectedBrandIds.size > 1;

  // Keyboard path to the batch bar: the most recently selected item offers
  // "Ações em lote (N)", and Esc in the bar returns to that item.
  const [lastPicked, setLastPicked] = useState(null);
  const pageRef = useRef(null);
  const barRef = useRef(null);
  const pickOne = (id, force) => {
    const on = force ?? !selection.has(id);
    selection.toggle(id, on);
    if (on) setLastPicked(id);
  };
  const pickMany = (next) => {
    const chosen = next instanceof Set ? next : new Set(next || []);
    const added = [...chosen].filter((id) => !selection.has(id));
    selection.set(chosen);
    if (added.length === 1) setLastPicked(added[0]);
  };
  const jumpTarget = lastPicked && selection.has(lastPicked) ? lastPicked : null;
  const focusBar = () =>
    (barRef.current?.querySelector(".ui-bulkbar__actions button:not(:disabled)") ?? barRef.current?.querySelector("button"))?.focus();
  const focusSelection = () => {
    const root = pageRef.current;
    if (!root) return;
    for (const id of [jumpTarget, ...selection.ids].filter(Boolean)) {
      const host = root.querySelector(`[data-lib-id="${CSS.escape(id)}"]`);
      const box = host?.closest("tr, article")?.querySelector('input[type="checkbox"]');
      if (box) return box.focus();
    }
    root.querySelector('input[type="search"]')?.focus();
  };

  const [reorderMode, setReorderMode] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // {type:'release'|'category'|'owner'|'archive', ids}
  const [bulkBusy, setBulkBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const reorderSeq = useRef(0);

  const canUpload = can("materials.upload");
  const canEdit = can("materials.edit");
  const canRelease = can("materials.release");
  const canArchive = can("materials.archive");

  // ---------------------------------------------------------------- options
  const brandOptions = useMemo(
    () =>
      brands.items
        .filter((brand) => !filters.clientId || brandClientId(brand) === filters.clientId)
        .map((brand) => ({
          value: brand.id,
          label: filters.clientId || !brand.client?.name ? brand.name : `${brand.name} · ${brand.client.name}`,
        })),
    [brands.items, filters.clientId],
  );
  const clientOptions = useMemo(() => {
    const fromClients = clients.items.map((client) => ({ value: client.id, label: client.name }));
    if (fromClients.length) return fromClients;
    const seen = new Map();
    for (const brand of brands.items) if (brand.client?.id) seen.set(brand.client.id, brand.client.name);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [clients.items, brands.items]);
  const selectedBrand = brands.items.find((brand) => brand.id === filters.brandId) ?? null;
  const activeCount = FILTER_KEYS.filter((key) => key !== "q" && filters[key]).length + (filters.archived ? 1 : 0);
  const narrowed = NARROWING.some((key) => filters[key]) || filters.archived;

  // ---------------------------------------------------------------- grouping
  const groups = useMemo(() => {
    const map = new Map();
    for (const material of items) {
      const key = material.category?.id ?? "none";
      if (!map.has(key)) map.set(key, { category: material.category ?? { id: "none", name: "Sem categoria" }, items: [] });
      map.get(key).items.push(material);
    }
    return [...map.values()].sort(
      (a, b) => (a.category.sortOrder ?? 0) - (b.category.sortOrder ?? 0) || String(a.category.name).localeCompare(String(b.category.name)),
    );
  }, [items]);

  // ---------------------------------------------------------------- actions
  const refreshAfter = async (promise, success) => {
    try {
      const result = await promise;
      if (success) toast.success(typeof success === "function" ? success(result) : success);
      await list.reload().catch(() => {});
      return result;
    } catch (error) {
      toast.error(error.message);
      throw error;
    }
  };

  const runBulk = async (action, value, verb, ids = selection.ids) => {
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const result = await api.post("/materials/bulk", { ids, action, ...(value !== undefined ? { value } : {}) });
      const updated = countOf(result?.updated, ids.length);
      const skipped = result?.skipped ?? [];
      if (updated) toast.success(`${materialsLabel(updated)} ${verb}.`);
      if (skipped.length)
        toast.info(
          `${skipped.length === 1 ? "1 material ficou" : `${skipped.length} materiais ficaram`} de fora: ${skipped[0]?.reason ?? "sem permissão"}`,
        );
      selection.clear();
      await list.reload().catch(() => {});
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const openRelease = (ids) => {
    const chosen = items.filter((m) => ids.includes(m.id));
    const brandsInvolved = new Set(chosen.map((m) => m.brand?.id));
    if (brandsInvolved.size > 1) {
      toast.error("Selecione materiais de uma única marca para liberar de uma vez.");
      return;
    }
    setDialog({ type: "release", ids });
  };

  const zipSelection = (ids) => {
    const label = ids.length === 1 ? items.find((m) => m.id === ids[0])?.title ?? "Material" : `Seleção da biblioteca (${ids.length})`;
    startZip({ type: "selection", materialIds: ids }, { label });
  };

  const submitOne = (material) =>
    refreshAfter(api.post(`/materials/${material.id}/submit`), `“${material.title}” foi para revisão interna.`).catch(() => {});

  const archiveOne = (material, archive) =>
    refreshAfter(
      api.post(`/materials/${material.id}/${archive ? "archive" : "unarchive"}`),
      archive ? `“${material.title}” foi arquivado.` : `“${material.title}” voltou para a biblioteca.`,
    ).catch(() => {});

  const toggleDownload = (material) =>
    refreshAfter(
      api.patch(`/materials/${material.id}`, { downloadEnabled: !material.downloadEnabled }),
      material.downloadEnabled ? "Download desativado para o cliente." : "Download ativado para o cliente.",
    ).catch(() => {});

  const setPrimary = async (material) => {
    const same = (m) =>
      m.brand?.id === material.brand?.id && m.category?.id === material.category?.id && (m.variant ?? null) === (material.variant ?? null);
    const before = list.data;
    list.setData((data) => ({ ...data, items: itemsOf(data).map((m) => (same(m) ? { ...m, isPrimary: m.id === material.id } : m)) }));
    try {
      await api.post(`/materials/${material.id}/primary`);
      toast.success(`“${material.title}” agora é o arquivo principal${material.variant ? ` de ${variantLabel(material.variant)}` : ""}.`);
      setAnnouncement(`${material.title} definido como principal.`);
      list.reload().catch(() => {});
    } catch (error) {
      list.setData(before);
      toast.error(error.message);
    }
  };

  const reorderGroup = async (categoryId, nextIds) => {
    const before = list.data;
    const seq = ++reorderSeq.current;
    list.setData((data) => {
      const rows = itemsOf(data);
      const byId = new Map(rows.map((m) => [m.id, m]));
      const queue = nextIds.map((id) => byId.get(id)).filter(Boolean);
      let i = 0;
      return { ...data, items: rows.map((m) => ((m.category?.id ?? "none") === categoryId && queue.length ? queue[i++] ?? m : m)) };
    });
    try {
      await api.post("/materials/reorder", { ids: nextIds });
    } catch (error) {
      if (seq === reorderSeq.current) {
        list.setData(before);
        toast.error(error.message || "Não foi possível salvar a nova ordem.");
      }
    }
  };

  const menuFor = (material) => {
    const released = material.visibility === "released";
    const pendingVersion = released && material.currentVersionId && material.currentVersionId !== material.releasedVersionId;
    return [
      { label: "Abrir", icon: Eye, to: materialPath(material) },
      canUpload && !material.archivedAt && material.kind !== "post" && {
        label: "Enviar nova versão",
        icon: CloudUpload,
        to: `/admin/biblioteca/enviar?materialId=${material.id}`,
      },
      canEdit && material.visibility === "draft" && !material.archivedAt && { label: "Enviar para revisão", icon: Send, onSelect: () => submitOne(material) },
      canRelease && !material.archivedAt && (!released || pendingVersion) && {
        label: pendingVersion ? "Liberar nova versão" : "Liberar para o cliente",
        icon: Send,
        onSelect: () => openRelease([material.id]),
      },
      canEdit && isLogo(material) && !material.isPrimary && !material.archivedAt && { label: "Definir como principal", icon: Star, onSelect: () => setPrimary(material) },
      { divider: true },
      { label: "Baixar ZIP", icon: Download, onSelect: () => zipSelection([material.id]) },
      canEdit && {
        label: material.downloadEnabled ? "Desativar download" : "Ativar download",
        icon: material.downloadEnabled ? EyeOff : Download,
        onSelect: () => toggleDownload(material),
      },
      canArchive && {
        label: material.archivedAt ? "Restaurar" : "Arquivar",
        icon: material.archivedAt ? ArchiveRestore : Archive,
        danger: !material.archivedAt,
        onSelect: () => (material.archivedAt ? archiveOne(material, false) : setDialog({ type: "archive", ids: [material.id] })),
      },
    ].filter(Boolean);
  };

  // Frequent actions inline; the rest in "Mais ações" so the bar stays one line.
  const bulkButtons = (ids) => {
    const b = (label, icon, onClick, { danger, disabled, title, key } = {}) => {
      const Icon = icon;
      return (
        <button
          key={key ?? label}
          type="button"
          className={`ui-bulkbar__action${danger ? " is-danger" : ""}`}
          disabled={bulkBusy || disabled}
          title={title}
          onClick={onClick}
        >
          <Icon size={16} strokeWidth={1.4} aria-hidden="true" />
          <span>{label}</span>
        </button>
      );
    };
    const more = [
      canEdit && { label: "Ativar download", icon: Download, onSelect: () => runBulk("enable_download", undefined, "com download ativo", ids) },
      canEdit && { label: "Desativar download", icon: EyeOff, onSelect: () => runBulk("disable_download", undefined, "sem download", ids) },
      canEdit && { label: "Mover para categoria", icon: FolderInput, onSelect: () => setDialog({ type: "category", ids }) },
      canEdit && { label: "Atribuir responsável", icon: UserRound, onSelect: () => setDialog({ type: "owner", ids }) },
      canArchive && { divider: true },
      canArchive &&
        (filters.archived
          ? { label: "Restaurar", icon: ArchiveRestore, onSelect: () => runBulk("unarchive", undefined, "restaurados", ids) }
          : { label: "Arquivar", icon: Archive, danger: true, onSelect: () => setDialog({ type: "archive", ids }) }),
    ].filter(Boolean);
    return [
      canEdit && !filters.archived && b("Enviar para revisão", Send, () => runBulk("submit", undefined, "enviados para revisão", ids)),
      canRelease &&
        !filters.archived &&
        b(mixedBrands ? "Liberar: uma marca por vez" : "Liberar", Send, () => openRelease(ids), {
          key: "release",
          disabled: mixedBrands,
          title: mixedBrands ? "A seleção tem materiais de marcas diferentes. Selecione materiais de uma única marca para liberar." : undefined,
        }),
      b("Baixar ZIP", Download, () => zipSelection(ids)),
      more.length > 0 && (
        <Menu
          key="more"
          label="Mais ações em lote"
          placement="top"
          items={more}
          trigger={
            <button type="button" className="ui-bulkbar__action" disabled={bulkBusy}>
              <Ellipsis size={16} strokeWidth={1.4} aria-hidden="true" />
              <span>Mais ações</span>
            </button>
          }
        />
      ),
    ].filter(Boolean);
  };

  // ---------------------------------------------------------------- render
  const uploadHref = (() => {
    const q = new URLSearchParams();
    if (filters.brandId) q.set("brandId", filters.brandId);
    if (filters.projectId) q.set("projectId", filters.projectId);
    if (filters.categoryId) q.set("categoryId", filters.categoryId);
    const text = q.toString();
    return `/admin/biblioteca/enviar${text ? `?${text}` : ""}`;
  })();

  const reorderAvailable = canEdit && Boolean(filters.brandId) && filters.view === "grid";
  const reorderActive = reorderAvailable && reorderMode && !narrowed;
  const toggleReorder = () => {
    if (reorderMode && !narrowed) return setReorderMode(false);
    if (narrowed) setFilters(Object.fromEntries([...NARROWING.map((key) => [key, ""]), ["archived", ""]]));
    setReorderMode(true);
    selection.clear();
  };

  const summary = list.loading
    ? "Carregando materiais…"
    : `${materialsLabel(total)}${list.refreshing ? " · atualizando" : ""}${selectedBrand ? ` em ${selectedBrand.name}` : ""}`;

  const clearFilters = () => setFilters({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, ""])), archived: "" });

  return (
    <div className="lib-page" ref={pageRef}>
      <PageHeader
        eyebrow="Biblioteca de arquivos"
        title="Materiais"
        accent="entregues"
        description="Logos, identidade, posts e arquivos de cada marca, do rascunho à liberação para o cliente."
        actions={
          <>
            <Button icon={Package} to={filters.brandId ? `/admin/kits?brandId=${filters.brandId}` : "/admin/kits"}>
              Kits
            </Button>
            {canUpload && (
              <Button variant="primary" icon={CloudUpload} to={uploadHref}>
                Enviar arquivos
              </Button>
            )}
          </>
        }
      />

      <LibraryFilters
        filters={filters}
        setFilters={setFilters}
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        summary={summary}
        onClear={clearFilters}
        clientOptions={clientOptions}
        brandOptions={brandOptions}
        selectedBrand={selectedBrand}
        brands={brands.items}
        projectOptions={[{ value: "none", label: "Sem projeto" }, ...projects.items.map((p) => ({ value: p.id, label: p.name }))]}
        categoryOptions={categories.items.map((c) => ({ value: c.id, label: c.archivedAt ? `${c.name} (arquivada)` : c.name }))}
        ownerOptions={[
          { value: "me", label: "Meus materiais" },
          ...owners.items.filter((person) => person.id !== user?.id).map((person) => ({ value: person.id, label: person.name })),
        ]}
        onArchivedChange={(on) => {
          setReorderMode(false);
          setFilters({ archived: on });
        }}
      />

      {!reorderActive && (
        <LibBulkBar
          ref={barRef}
          count={selection.count}
          onClear={selection.clear}
          onEscape={focusSelection}
          noun={["material selecionado", "materiais selecionados"]}
        >
          {bulkButtons(selection.ids)}
        </LibBulkBar>
      )}

      {selectedBrand && (
        <div className="lib-brandstrip ui-page-enter">
          <div className="lib-brandstrip__name">
            <span className="ui-eyebrow">{selectedBrand.client?.name ?? "Marca"}</span>
            <strong>{selectedBrand.name}</strong>
          </div>
          <div className="lib-brandstrip__links">
            <Button size="sm" variant="ghost" icon={Palette} to={`/admin/marcas/${selectedBrand.id}`}>
              Identidade da marca
            </Button>
            <Button size="sm" variant="ghost" icon={Package} to={`/admin/kits?brandId=${selectedBrand.id}`}>
              Kits e pacotes
            </Button>
            {reorderAvailable && (
              <Button
                size="sm"
                variant={reorderActive ? "primary" : "secondary"}
                icon={ListOrdered}
                aria-pressed={reorderActive}
                onClick={toggleReorder}
              >
                {reorderActive ? "Concluir ordem" : "Organizar ordem"}
              </Button>
            )}
          </div>
        </div>
      )}
      {reorderActive && (
        <p className="lib-hint" role="note">
          Arraste pela alça ou use os botões e as setas do teclado. A nova ordem vale para a área do cliente e para os ZIPs.
        </p>
      )}

      {list.error && !items.length ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <SkeletonCards count={8} aspect={4 / 3} minWidth={230} lines={2} label="Carregando materiais" />
      ) : !items.length ? (
        activeCount || filters.q ? (
          <EmptyState
            icon={FolderOpen}
            title="Nenhum material com esses filtros"
            description="Ajuste a busca ou limpe os filtros para ver toda a biblioteca."
            action={<Button onClick={clearFilters}>Limpar filtros</Button>}
          />
        ) : (
          <EmptyState
            icon={CloudUpload}
            title="A biblioteca ainda está vazia"
            description="Envie logos, identidade e posts como rascunho. Nada fica visível ao cliente até você liberar."
            action={
              canUpload && (
                <Button variant="primary" icon={CloudUpload} to={uploadHref}>
                  Enviar arquivos
                </Button>
              )
            }
          />
        )
      ) : filters.view === "list" ? (
        <DataTable
          aria-label="Materiais"
          className="lib-table"
          rows={items}
          selectable
          selected={selection.selected}
          onSelectedChange={pickMany}
          rowLabel={(m) => m.title}
          onRowClick={(m) => navigate(materialPath(m))}
          columns={[
            {
              key: "title",
              header: "Material",
              primary: true,
              width: "42%",
              sortable: true,
              sortValue: (m) => m.title,
              render: (m) => (
                <span className="lib-rowtitle" data-lib-id={m.id}>
                  {jumpTarget === m.id && <BulkJump count={selection.count} onJump={focusBar} className="lib-bulkjump--row" />}
                  <span className="lib-rowtitle__thumb">
                    <Art material={m} stage={1} />
                  </span>
                  <span className="lib-rowtitle__text">
                    <Link to={materialPath(m)}>{m.title}</Link>
                    <span className="lib-rowtitle__meta">
                      <span>
                        {m.category?.name}
                        {isLogo(m) && m.variant ? ` · ${variantLabel(m.variant)}` : ""}
                      </span>
                      <VersionTag number={m.version?.number} />
                    </span>
                    <small>
                      {m.brand?.name}
                      {m.client?.name ? ` · ${m.client.name}` : ""}
                    </small>
                  </span>
                </span>
              ),
            },
            { key: "status", header: "Status", className: "lib-col-status", render: (m) => <MaterialBadges material={m} /> },
            {
              key: "formats",
              header: "Formatos",
              hideOnMobile: true,
              nowrap: true,
              className: "lib-col-formats",
              headerClassName: "lib-col-formats",
              render: (m) => <Formats formats={m.formats} max={3} />,
            },
            {
              key: "owner",
              header: "Responsável",
              hideOnMobile: true,
              sortable: true,
              className: "lib-col-owner",
              headerClassName: "lib-col-owner",
              sortValue: (m) => m.owner?.name,
              render: (m) => m.owner?.name ?? "—",
            },
            {
              key: "updated",
              header: "Atualizado",
              nowrap: true,
              sortable: true,
              sortValue: (m) => m.updatedAt,
              render: (m) => <time dateTime={m.updatedAt}>{formatRelative(m.updatedAt)}</time>,
            },
            { key: "actions", header: "Ações", actions: true, render: (m) => <MenuCell items={menuFor(m)} title={m.title} /> },
          ]}
        />
      ) : (
        <div className="lib-groups">
          {groups.map((group, gi) => (
            <CategoryGroup
              key={group.category.id}
              group={group}
              index={gi}
              showBrand={!filters.brandId}
              brandId={filters.brandId}
              selection={selection}
              onPick={pickOne}
              jump={jumpTarget ? { id: jumpTarget, count: selection.count, onJump: focusBar } : null}
              reorder={reorderActive}
              canStar={canEdit && !filters.archived}
              onStar={setPrimary}
              menuFor={menuFor}
              onReorder={reorderGroup}
              onZip={(category) =>
                startZip(
                  { type: "category", brandId: filters.brandId, categoryId: category.id },
                  { label: `${selectedBrand?.name ?? "Marca"} · ${category.name}` },
                )
              }
            />
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <Pagination
          page={filters.page}
          pageSize={PAGE_SIZE}
          total={total}
          onChange={(page) => {
            setFilters({ page: page === 1 ? "" : page }, { keepPage: true });
            window.scrollTo({ top: 0 });
          }}
        />
      )}

      {filters.view === "grid" && selection.count > 0 && <div className="ui-bulkbar-spacer" aria-hidden="true" />}
      <Live text={announcement} />

      <ReleaseDialog
        open={dialog?.type === "release"}
        materialIds={dialog?.type === "release" ? dialog.ids : []}
        onClose={() => setDialog(null)}
        onReleased={() => {
          selection.clear();
          list.reload().catch(() => {});
        }}
      />
      <MoveCategoryDialog
        open={dialog?.type === "category"}
        count={dialog?.ids?.length ?? 0}
        categories={categories.active}
        onClose={() => setDialog(null)}
        onConfirm={async (categoryId) => {
          const ids = dialog.ids;
          setDialog(null);
          await runBulk("set_category", categoryId, "movidos de categoria", ids);
        }}
      />
      <AssignOwnerDialog
        open={dialog?.type === "owner"}
        count={dialog?.ids?.length ?? 0}
        people={owners.items}
        onClose={() => setDialog(null)}
        onConfirm={async (ownerId) => {
          const ids = dialog.ids;
          setDialog(null);
          await runBulk("set_owner", ownerId, "com novo responsável", ids);
        }}
      />
      <ConfirmDialog
        open={dialog?.type === "archive"}
        tone="danger"
        title={dialog?.ids?.length === 1 ? "Arquivar este material?" : `Arquivar ${materialsLabel(dialog?.ids?.length ?? 0)}?`}
        description="Materiais arquivados saem da biblioteca e da área do cliente. O histórico e os arquivos são preservados e você pode restaurar depois."
        confirmLabel="Arquivar"
        icon={Archive}
        onClose={() => setDialog(null)}
        onConfirm={() => runBulk("archive", undefined, "arquivados", dialog.ids)}
      />
    </div>
  );
}

function MenuCell({ items, title }) {
  return <Menu items={items} label={`Ações de ${title}`} />;
}

// Search + the three filters used most (client, brand, category) on one row,
// with the rest behind "Filtros" (count badge) and every active filter shown
// as a removable chip. Phones keep all filters behind the button.
function LibraryFilters({
  filters,
  setFilters,
  open,
  onOpenChange,
  summary,
  onClear,
  clientOptions,
  brandOptions,
  selectedBrand,
  brands,
  projectOptions,
  categoryOptions,
  ownerOptions,
  onArchivedChange,
}) {
  const narrow = useIsNarrow();
  const panelId = useId();
  const chipsRef = useRef(null);
  const toggleRef = useRef(null);
  const refocus = useRef(null);
  const labelOf = (options, value) => options.find((option) => option.value === value)?.label;

  const secondaryCount = SECONDARY.filter((key) => filters[key]).length + (filters.archived ? 1 : 0);
  const badge = narrow ? secondaryCount + ["clientId", "brandId", "categoryId"].filter((key) => filters[key]).length : secondaryCount;

  const chips = [
    filters.clientId && { key: "clientId", label: `Cliente: ${labelOf(clientOptions, filters.clientId) ?? "selecionado"}`, clear: { clientId: "" } },
    filters.brandId && { key: "brandId", label: `Marca: ${selectedBrand?.name ?? "selecionada"}`, clear: { brandId: "", projectId: "" } },
    filters.categoryId && {
      key: "categoryId",
      label: `Categoria: ${labelOf(categoryOptions, filters.categoryId) ?? "selecionada"}`,
      clear: { categoryId: "" },
    },
    filters.projectId && { key: "projectId", label: `Projeto: ${labelOf(projectOptions, filters.projectId) ?? "selecionado"}`, clear: { projectId: "" } },
    filters.visibility && { key: "visibility", label: statusLabel("visibility", filters.visibility), clear: { visibility: "" } },
    filters.approval && { key: "approval", label: statusLabel("approval", filters.approval), clear: { approval: "" } },
    filters.ownerId && { key: "ownerId", label: `Responsável: ${labelOf(ownerOptions, filters.ownerId) ?? "selecionado"}`, clear: { ownerId: "" } },
    filters.tag && { key: "tag", label: `Etiqueta: ${filters.tag}`, clear: { tag: "" } },
    filters.archived && { key: "archived", label: "Arquivados", clear: { archived: false } },
  ].filter(Boolean);

  // Removing a chip keeps the focus in the chip row (or on "Filtros").
  useEffect(() => {
    if (refocus.current === null) return;
    const index = refocus.current;
    refocus.current = null;
    const buttons = chipsRef.current?.querySelectorAll("[data-chip]") ?? [];
    (buttons[Math.min(index, buttons.length - 1)] ?? toggleRef.current)?.focus();
  });

  return (
    <div className={`lib-filters${open ? " is-open" : ""}`}>
      <div className="lib-filters__row">
        <div className="lib-filters__search">
          <SearchInput
            value={filters.q}
            onChange={(q) => setFilters({ q })}
            placeholder="Buscar título ou etiqueta"
            label="Buscar materiais"
            shortcut="/"
          />
        </div>
        <div className="lib-filters__primary">
          <Select
            aria-label="Cliente"
            placeholder="Todos os clientes"
            value={filters.clientId}
            options={clientOptions}
            onValueChange={(clientId) => {
              const brand = brands.find((b) => b.id === filters.brandId);
              const keep = brand && brandClientId(brand) === clientId;
              setFilters({ clientId, ...(keep ? {} : { brandId: "", projectId: "" }) });
            }}
          />
          <Select
            aria-label="Marca"
            placeholder="Todas as marcas"
            value={filters.brandId}
            options={brandOptions}
            onValueChange={(brandId) => {
              const brand = brands.find((b) => b.id === brandId);
              setFilters({ brandId, projectId: "", ...(brand && brandClientId(brand) ? { clientId: brandClientId(brand) } : {}) });
            }}
          />
          <Select
            aria-label="Categoria"
            placeholder="Todas as categorias"
            value={filters.categoryId}
            options={categoryOptions}
            onValueChange={(categoryId) => setFilters({ categoryId })}
          />
        </div>
        <Button
          ref={toggleRef}
          className="lib-filters__toggle"
          icon={SlidersHorizontal}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
        >
          Filtros
          {badge > 0 && (
            <span className="lib-filters__badge">
              {badge}
              <span className="ui-sr-only"> {badge === 1 ? "ativo" : "ativos"}</span>
            </span>
          )}
        </Button>
        <div className="lib-filters__end">
          <span className="lib-filters__count" aria-live="polite">
            {summary}
          </span>
          <Segmented
            aria-label="Visualização"
            iconOnly
            value={filters.view}
            onChange={(view) => setFilters({ view: view === "grid" ? "" : view }, { keepPage: true })}
            options={[
              { value: "grid", label: "Grade", icon: LayoutGrid },
              { value: "list", label: "Lista", icon: List },
            ]}
          />
        </div>
      </div>

      <div id={panelId} className="lib-filters__panel" role="group" aria-label="Mais filtros" hidden={!open}>
        <Field label="Projeto">
          <Select
            placeholder={filters.brandId ? "Todos os projetos" : "Escolha a marca primeiro"}
            disabled={!filters.brandId}
            value={filters.projectId}
            options={projectOptions}
            onValueChange={(projectId) => setFilters({ projectId })}
          />
        </Field>
        <Field label="Visibilidade">
          <Select
            placeholder="Todas"
            value={filters.visibility}
            options={statusOptions("visibility")}
            onValueChange={(visibility) => setFilters({ visibility })}
          />
        </Field>
        <Field label="Aprovação">
          <Select placeholder="Todas" value={filters.approval} options={statusOptions("approval")} onValueChange={(approval) => setFilters({ approval })} />
        </Field>
        <Field label="Responsável">
          <Select placeholder="Toda a equipe" value={filters.ownerId} options={ownerOptions} onValueChange={(ownerId) => setFilters({ ownerId })} />
        </Field>
        <Field label="Etiqueta">
          <TagFilter value={filters.tag} onChange={(tag) => setFilters({ tag })} />
        </Field>
        <div className="lib-filters__switch">
          <Switch label="Mostrar arquivados" checked={filters.archived} onCheckedChange={onArchivedChange} />
        </div>
      </div>

      {chips.length > 0 && (
        <div className="lib-filters__chips" ref={chipsRef}>
          <ul aria-label="Filtros ativos">
            {chips.map((chip, index) => (
              <li key={chip.key}>
                <button
                  type="button"
                  className="lib-chip"
                  data-chip
                  aria-label={`Remover filtro ${chip.label}`}
                  onClick={() => {
                    refocus.current = index;
                    setFilters(chip.clear);
                  }}
                >
                  <span>{chip.label}</span>
                  <X size={14} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {chips.length > 1 && (
            <Button size="sm" variant="link" onClick={onClear}>
              Limpar filtros
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function TagFilter({ value, onChange }) {
  const [text, setText] = useState(value);
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(value);
  }
  const commit = () => text.trim() !== value && onChange(text.trim());
  return (
    <Input
      type="search"
      placeholder="Ex.: campanha-verão"
      enterKeyHint="search"
      value={text}
      onValueChange={setText}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      className="lib-tagfilter"
    />
  );
}

function CategoryGroup({ group, index, showBrand, brandId, selection, onPick, jump, reorder, canStar, onStar, menuFor, onReorder, onZip }) {
  const ids = group.items.map((m) => m.id);
  const byId = useMemo(() => new Map(group.items.map((m) => [m.id, m])), [group.items]);
  const sort = useDragSort({
    ids,
    disabled: !reorder,
    labelOf: (id) => byId.get(id)?.title ?? "Material",
    onReorder: (next) => onReorder(group.category.id, next),
  });
  const ordered = reorder ? sort.order.map((id) => byId.get(id)).filter(Boolean) : group.items;
  const allSelected = ids.length > 0 && ids.every((id) => selection.has(id));
  const headingId = `lib-group-${group.category.id}`;
  const stage = group.category.slug === "stories" || group.category.slug === "reels-videos" ? 4 / 5 : 4 / 3;

  return (
    <section className="lib-group ui-enter" style={{ "--i": Math.min(index, 8) }} aria-labelledby={headingId}>
      <SectionHead
        id={headingId}
        title={group.category.name}
        count={group.items.length}
        actions={
          <>
            {!reorder && (
              <Button size="sm" variant="ghost" onClick={() => ids.forEach((id) => onPick(id, !allSelected))}>
                {allSelected ? "Desmarcar" : "Selecionar"}
              </Button>
            )}
            {brandId && group.category.id !== "none" && (
              <Button size="sm" variant="ghost" icon={Download} onClick={() => onZip(group.category)}>
                Baixar pasta
              </Button>
            )}
          </>
        }
      />
      <div className={`lib-grid${reorder ? " is-sorting" : ""}`} role={reorder ? "list" : undefined}>
        {ordered.map((material, i) => (
          <MaterialCard
            key={material.id}
            {...(reorder ? sort.itemProps(material.id) : {})}
            role={reorder ? "listitem" : undefined}
            material={material}
            index={i}
            stage={stage}
            showBrand={showBrand}
            selectable={!reorder}
            selected={selection.has(material.id)}
            onToggle={onPick}
            jump={!reorder && jump?.id === material.id ? jump : null}
            data-lib-id={material.id}
            canStar={canStar}
            onStar={onStar}
            menuItems={reorder ? null : menuFor(material)}
            sort={
              reorder
                ? {
                    handleProps: sort.handleProps(material.id),
                    index: i,
                    count: ordered.length,
                    onMove: (delta) => sort.move(material.id, delta),
                  }
                : null
            }
          />
        ))}
      </div>
      <Live text={sort.announcement} />
    </section>
  );
}

function MoveCategoryDialog({ open, count, categories, onClose, onConfirm }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      size="sm"
      title="Mover para categoria"
      description={`${materialsLabel(count)} ${count === 1 ? "vai" : "vão"} para a categoria escolhida. Logos precisam de uma variante na página do material.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            icon={FolderInput}
            disabled={!value}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(value);
              } finally {
                setBusy(false);
                setValue("");
              }
            }}
          >
            Mover
          </Button>
        </>
      }
    >
      <Field label="Categoria" required>
        <Select placeholder="Escolha a categoria" value={value} onValueChange={setValue} options={categories.map((c) => ({ value: c.id, label: c.name }))} data-autofocus />
      </Field>
    </Modal>
  );
}

function AssignOwnerDialog({ open, count, people, onClose, onConfirm }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      size="sm"
      title="Atribuir responsável"
      description={`Quem acompanha ${count === 1 ? "este material" : `estes ${count} materiais`} dentro da equipe.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            icon={UserRound}
            disabled={!value}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(value);
              } finally {
                setBusy(false);
                setValue("");
              }
            }}
          >
            Atribuir
          </Button>
        </>
      }
    >
      <Field label="Responsável" required>
        <Select placeholder="Escolha alguém da equipe" value={value} onValueChange={setValue} options={people.map((p) => ({ value: p.id, label: p.name }))} data-autofocus />
      </Field>
    </Modal>
  );
}
