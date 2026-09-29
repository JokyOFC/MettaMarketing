import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Archive, Download, Package, PackagePlus, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  IconButton,
  Input,
  Menu,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  SkeletonCards,
  StatusBadge,
  Textarea,
  Thumb,
  formatDate,
  useApi,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useDownloads } from "../../api/downloads.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import ReleaseDialog from "./ReleaseDialog.jsx";
import { Art, Handle, Live, MaterialBadges, MoveButtons, VersionTag } from "./parts.jsx";
import { artBackground, brandClientId, itemsOf, materialsLabel, useBrands, useClients, useProjects } from "./data.js";
import { useDragSort } from "./useDragSort.js";
import "./library.css";

const KINDS = [
  { value: "brand_kit", label: "Kit de marca" },
  { value: "project_package", label: "Pacote do projeto" },
  { value: "custom", label: "Personalizado" },
];

// Kit items may come as Material[], [{material}] or ids; normalise to Material-ish.
function kitItems(kit) {
  const raw = kit?.items ?? kit?.materials ?? [];
  if (Array.isArray(raw) && raw.length) return raw.map((item) => item.material ?? item).filter((m) => m && (m.id || m.materialId)).map((m) => ({ ...m, id: m.id ?? m.materialId }));
  return (kit?.materialIds ?? []).map((id) => ({ id }));
}
const kitBrandId = (kit) => kit.brandId ?? kit.brand?.id ?? null;

export default function Kits() {
  usePageTitle("Kits e pacotes");
  const { can } = useAuth();
  const toast = useToast();
  const { startZip } = useDownloads();
  const [params, setParams] = useSearchParams();
  const brandId = params.get("brandId") || "";
  const clientId = params.get("clientId") || "";
  const status = params.get("status") || "";
  const projectId = params.get("projectId") || "";
  const clients = useClients();
  const brands = useBrands();
  const list = useApi("/kits", { params: { brandId: brandId || undefined, projectId: projectId || undefined, status: status || undefined } });
  const [editor, setEditor] = useState(null); // { kit?, kind?, brandId }
  const [release, setRelease] = useState(null);
  const [removing, setRemoving] = useState(null);
  const handled = useRef(false);

  const canManage = can(["materials.edit", "materials.release"]);
  const canRelease = can("materials.release");

  const setParam = (patch) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (!value) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );

  // Deep links: ?novo=brand_kit and ?kit=<id>.
  useEffect(() => {
    if (handled.current) return;
    const novo = params.get("novo");
    const kitId = params.get("kit");
    if (novo && brandId) {
      handled.current = true;
      setEditor({ kind: KINDS.some((k) => k.value === novo) ? novo : "custom", brandId, preselectIdentity: novo === "brand_kit" });
      setParam({ novo: "" });
    } else if (kitId && list.data) {
      handled.current = true;
      const kit = itemsOf(list.data).find((k) => k.id === kitId);
      if (kit) setEditor({ kit, brandId: kitBrandId(kit) });
      setParam({ kit: "" });
    }
  }, [params, brandId, list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const brandById = useMemo(() => new Map(brands.items.map((b) => [b.id, b])), [brands.items]);
  const kits = itemsOf(list.data)
    .filter((kit) => (status ? kit.status === status : kit.status !== "archived"))
    .filter((kit) => !clientId || brandClientId(brandById.get(kitBrandId(kit))) === clientId || kit.brand?.clientId === clientId);
  const brandOptions = brands.items
    .filter((b) => !clientId || brandClientId(b) === clientId)
    .map((b) => ({ value: b.id, label: clientId || !b.client?.name ? b.name : `${b.name} · ${b.client.name}` }));
  const selectedBrand = brandById.get(brandId) ?? null;

  const archive = async (kit) => {
    try {
      await api.patch(`/kits/${kit.id}`, { status: "archived" });
      toast.success(`“${kit.name}” arquivado.`);
      list.reload().catch(() => {});
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="lib-page">
      <PageHeader
        back={{ to: brandId ? `/admin/biblioteca?brandId=${brandId}` : "/admin/biblioteca", label: "Biblioteca" }}
        eyebrow="Biblioteca de arquivos"
        title="Kits"
        accent="e pacotes"
        description="Reúna logos, manual e arquivos em uma entrega organizada. O cliente baixa tudo em um ZIP com pastas por área e formato."
        actions={
          canManage && (
            <Button variant="primary" icon={PackagePlus} onClick={() => setEditor(projectId ? { brandId, kind: "project_package", projectId } : { brandId, kind: "brand_kit", preselectIdentity: true })}>
              Novo kit
            </Button>
          )
        }
      />
      <FilterBar
        activeCount={[clientId, brandId, projectId, status].filter(Boolean).length}
        onClear={() => setParam({ clientId: "", brandId: "", projectId: "", status: "" })}
        summary={list.loading ? "Carregando kits…" : `${kits.length === 1 ? "1 kit" : `${kits.length} kits`}${selectedBrand ? ` de ${selectedBrand.name}` : ""}`}
        actions={
          <Segmented
            aria-label="Situação"
            size="sm"
            value={status}
            onChange={(value) => setParam({ status: value })}
            options={[
              { value: "", label: "Ativos" },
              { value: "draft", label: "Rascunho" },
              { value: "released", label: "Liberados" },
              { value: "archived", label: "Arquivados" },
            ]}
          />
        }
      >
        <Select
          aria-label="Cliente"
          placeholder="Todos os clientes"
          value={clientId}
          options={clients.items.map((c) => ({ value: c.id, label: c.name }))}
          onValueChange={(value) => {
            const keep = selectedBrand && brandClientId(selectedBrand) === value;
            setParam({ clientId: value, ...(keep ? {} : { brandId: "" }) });
          }}
        />
        <Select aria-label="Marca" placeholder="Todas as marcas" value={brandId} options={brandOptions} onValueChange={(value) => setParam({ brandId: value })} />
      </FilterBar>

      {list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <SkeletonCards count={6} aspect={16 / 9} minWidth={280} label="Carregando kits" />
      ) : !kits.length ? (
        <EmptyState
          icon={Package}
          title={status || clientId || brandId || projectId ? "Nenhum kit com esses filtros" : "Nenhum kit montado ainda"}
          description="Um kit de marca reúne logos, cores, tipografia e manual para o cliente baixar de uma vez. Pacotes de projeto juntam as entregas finais."
          action={
            canManage && (
              <Button variant="primary" icon={PackagePlus} onClick={() => setEditor(projectId ? { brandId, kind: "project_package", projectId } : { brandId, kind: "brand_kit", preselectIdentity: true })}>
                Montar kit
              </Button>
            )
          }
        />
      ) : (
        <div className="lib-kits">
          {kits.map((kit, index) => {
            const items = kitItems(kit);
            const count = kit.itemCount ?? items.length;
            const brand = kit.brand ?? brandById.get(kitBrandId(kit));
            const covers = items.filter((m) => m.thumb).slice(0, 4);
            if (!covers.length && kit.cover) covers.push({ id: `${kit.id}-cover`, thumb: kit.cover });
            return (
              <article key={kit.id} className="lib-kit ui-enter" style={{ "--i": Math.min(index, 8) }}>
                <button type="button" className="lib-kit__cover" onClick={() => canManage && setEditor({ kit, brandId: kitBrandId(kit) })} disabled={!canManage} aria-label={`Editar ${kit.name}`}>
                  {covers.length ? (
                    <span className={`lib-kit__mosaic n${covers.length}`}>
                      {covers.map((m) => (
                        <Thumb key={m.id} thumb={m.thumb} aspect="1" bg={artBackground(m)} fit="contain" alt="" rounded={false} />
                      ))}
                    </span>
                  ) : (
                    <span className="lib-kit__glyph" aria-hidden="true">
                      <Package size={30} strokeWidth={1.1} />
                    </span>
                  )}
                </button>
                <div className="lib-kit__body">
                  <div className="lib-kit__badges">
                    <StatusBadge kind="kitKind" value={kit.kind} size="sm" />
                    <StatusBadge kind="kit" value={kit.status} size="sm" />
                  </div>
                  <h2 className="lib-kit__name">{kit.name}</h2>
                  <p className="lib-kit__meta">
                    {brand?.name && <span>{brand.name}</span>}
                    <span>{count === 1 ? "1 material" : `${count} materiais`}</span>
                    {kit.releasedAt && <span>liberado em {formatDate(kit.releasedAt)}</span>}
                  </p>
                  {kit.description && <p className="lib-kit__desc">{kit.description}</p>}
                  <div className="lib-kit__actions">
                    {canManage && (
                      <Button size="sm" icon={Pencil} onClick={() => setEditor({ kit, brandId: kitBrandId(kit) })}>
                        Editar
                      </Button>
                    )}
                    {canRelease && kit.status !== "archived" && (
                      <Button size="sm" variant={kit.status === "released" ? "ghost" : "primary"} icon={Send} disabled={!count} onClick={() => setRelease(kit)}>
                        {kit.status === "released" ? "Liberar de novo" : "Liberar"}
                      </Button>
                    )}
                    <Menu
                      label={`Mais ações de ${kit.name}`}
                      items={[
                        { label: "Baixar ZIP do kit", icon: Download, disabled: !count, onSelect: () => startZip({ type: "kit", kitId: kit.id }, { label: kit.name }) },
                        canManage && kit.status !== "archived" && { label: "Arquivar", icon: Archive, onSelect: () => archive(kit) },
                        canManage && { label: "Excluir kit", icon: Trash2, danger: true, onSelect: () => setRemoving(kit) },
                      ].filter(Boolean)}
                    />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <KitEditor
        open={Boolean(editor)}
        state={editor}
        brands={brands.items}
        onClose={() => setEditor(null)}
        onSaved={(kit) => {
          setEditor(null);
          list.reload().catch(() => {});
          if (kit && canRelease && kit.status !== "released") toast.info("Kit salvo. Use “Liberar” para disponibilizá-lo ao cliente.");
        }}
      />
      <ReleaseDialog
        open={Boolean(release)}
        kitId={release?.id ?? null}
        materialIds={release ? kitItems(release).map((m) => m.id) : []}
        onClose={() => setRelease(null)}
        onReleased={() => list.reload().catch(() => {})}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        tone="danger"
        title={`Excluir “${removing?.name ?? ""}”?`}
        description="Só o agrupamento é excluído. Os materiais continuam na biblioteca e o que já foi liberado segue disponível ao cliente."
        confirmLabel="Excluir kit"
        icon={Trash2}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          await api.del(`/kits/${removing.id}`);
          toast.success("Kit excluído.");
          list.reload().catch(() => {});
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- editor

function KitEditor({ open, state, brands, onClose, onSaved }) {
  const toast = useToast();
  const existing = state?.kit ?? null;
  const [brandId, setBrandId] = useState("");
  const [form, setForm] = useState({ name: "", kind: "brand_kit", projectId: "", description: "" });
  const [selected, setSelected] = useState([]);
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("");
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const initialised = useRef(null);

  const detail = useApi(open && existing ? `/kits/${existing.id}` : null);
  const materials = useApi(open && brandId ? "/materials" : null, { params: { brandId, pageSize: 200, sort: "sortOrder" } });
  const projects = useProjects(open && brandId ? brandId : null);
  const pool = itemsOf(materials.data);
  const byId = useMemo(() => new Map(pool.map((m) => [m.id, m])), [pool]);
  const brand = brands.find((b) => b.id === brandId);

  // (Re)initialise when the drawer opens for a kit or a new one.
  useEffect(() => {
    if (!open) {
      initialised.current = null;
      return;
    }
    const token = existing?.id ?? `new:${state?.kind}:${state?.brandId}`;
    if (initialised.current === token) return;
    initialised.current = token;
    setErrors({});
    setQuery("");
    setArea("");
    setBrandId(state?.brandId || "");
    setForm({
      name: existing?.name ?? "",
      kind: existing?.kind ?? state?.kind ?? "brand_kit",
      projectId: existing?.projectId ?? existing?.project?.id ?? state?.projectId ?? "",
      description: existing?.description ?? "",
    });
    setSelected(existing ? kitItems(existing).map((m) => m.id) : []);
  }, [open, existing, state]);

  // Items from the kit detail (authoritative order).
  useEffect(() => {
    const kit = detail.data?.kit ?? detail.data;
    if (kit && existing && kit.id === existing.id) setSelected(kitItems(kit).map((m) => m.id));
  }, [detail.data, existing]);

  // New brand kit: name it and preselect the identity materials once loaded.
  useEffect(() => {
    if (!open || existing || !state?.preselectIdentity || !pool.length) return;
    setSelected((current) => (current.length ? current : pool.filter((m) => m.category?.area === "identity" && !m.archivedAt).map((m) => m.id)));
  }, [open, existing, state, pool]);
  useEffect(() => {
    if (open && !existing && brand && !form.name)
      setForm((f) => ({ ...f, name: f.kind === "brand_kit" ? `Kit de marca · ${brand.name}` : f.kind === "project_package" ? "Pacote final do projeto" : "" }));
  }, [open, existing, brand]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  };
  const toggle = (id, on) => setSelected((list) => (on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id)));

  const sort = useDragSort({
    ids: selected,
    labelOf: (id) => byId.get(id)?.title ?? "Material",
    onReorder: setSelected,
  });

  const filtered = pool.filter((m) => {
    if (m.archivedAt) return false;
    if (area && m.category?.area !== area) return false;
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return [m.title, m.category?.name, ...(m.tags ?? [])].some((text) => String(text ?? "").toLowerCase().includes(q));
  });

  const save = async () => {
    const e = {};
    if (!brandId) e.brandId = "Escolha a marca do kit.";
    if (!form.name.trim()) e.name = "Dê um nome ao kit.";
    if (form.kind === "project_package" && !form.projectId) e.projectId = "Escolha o projeto do pacote.";
    if (Object.keys(e).length) {
      setErrors(e);
      return;
    }
    setSaving(true);
    try {
      let kit;
      const body = {
        name: form.name.trim(),
        kind: form.kind,
        description: form.description.trim() || null,
        projectId: form.projectId || null,
      };
      if (existing) {
        const res = await api.patch(`/kits/${existing.id}`, body);
        await api.put(`/kits/${existing.id}/items`, { materialIds: selected });
        kit = res?.kit ?? { ...existing, ...body };
      } else {
        const res = await api.post("/kits", { ...body, brandId, materialIds: selected });
        kit = res?.kit ?? res;
      }
      toast.success(existing ? "Kit atualizado." : "Kit criado como rascunho.");
      onSaved?.(kit);
    } catch (error) {
      if (error.code === "validation" && error.fields) setErrors(error.fields);
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={saving ? undefined : onClose}
      size="lg"
      eyebrow={existing ? "Editar kit" : "Novo kit"}
      title={form.name || (existing ? existing.name : "Montar kit")}
      footer={
        <>
          <span className="lib-kitedit__count">{materialsLabel(selected.length)} no kit</span>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" icon={Package} loading={saving} onClick={save}>
            {existing ? "Salvar kit" : "Criar kit"}
          </Button>
        </>
      }
    >
      <div className="lib-kitedit">
        <div className="lib-form">
          {!existing && (
            <Field label="Marca" required error={errors.brandId}>
              <Select
                placeholder="Escolha a marca"
                value={brandId}
                options={brands.map((b) => ({ value: b.id, label: b.client?.name ? `${b.name} · ${b.client.name}` : b.name }))}
                onValueChange={(value) => {
                  setBrandId(value);
                  setSelected([]);
                  setErrors((er) => ({ ...er, brandId: undefined }));
                }}
              />
            </Field>
          )}
          <Field label="Tipo">
            <Segmented aria-label="Tipo de kit" className="lib-kitedit__kind" value={form.kind} onChange={(kind) => set({ kind })} options={KINDS} />
          </Field>
          <div className="lib-form__two">
            <Field label="Nome" required error={errors.name}>
              <Input value={form.name} maxLength={120} onValueChange={(name) => set({ name })} />
            </Field>
            <Field label="Projeto" required={form.kind === "project_package"} optional={form.kind !== "project_package"} error={errors.projectId}>
              <Select
                placeholder={brandId ? "Sem projeto" : "Escolha a marca"}
                disabled={!brandId}
                value={form.projectId}
                options={projects.items.map((p) => ({ value: p.id, label: p.name }))}
                onValueChange={(projectId) => set({ projectId })}
              />
            </Field>
          </div>
          <Field label="Descrição" optional>
            <Textarea rows={2} autoGrow maxLength={2000} value={form.description} onValueChange={(description) => set({ description })} />
          </Field>
        </div>

        <div className="lib-kitedit__cols">
          <section className="lib-kitedit__pool" aria-label="Materiais da marca">
            <div className="lib-kitedit__tools">
              <SearchInput value={query} onChange={setQuery} delay={120} placeholder="Buscar materiais" label="Buscar materiais da marca" />
              <Select
                aria-label="Área"
                value={area}
                onValueChange={setArea}
                options={[
                  { value: "", label: "Todas as áreas" },
                  { value: "identity", label: "Identidade visual" },
                  { value: "content", label: "Conteúdo" },
                  { value: "other", label: "Materiais" },
                ]}
              />
            </div>
            {!brandId ? (
              <p className="lib-state__muted">Escolha a marca para ver os materiais.</p>
            ) : materials.loading ? (
              <div className="lib-kitedit__skel">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} height={52} radius={4} />
                ))}
              </div>
            ) : !filtered.length ? (
              <p className="lib-state__muted">{pool.length ? "Nada encontrado com essa busca." : "Esta marca ainda não tem materiais na biblioteca."}</p>
            ) : (
              <ul className="lib-pick">
                {filtered.map((m) => (
                  <li key={m.id}>
                    <label className={`lib-pick__row${selected.includes(m.id) ? " is-on" : ""}`}>
                      <Checkbox checked={selected.includes(m.id)} onCheckedChange={(on) => toggle(m.id, on)} aria-label={`Incluir ${m.title}`} />
                      <span className="lib-pick__thumb">
                        <Art material={m} stage={1} />
                      </span>
                      <span className="lib-pick__text">
                        <strong>{m.title}</strong>
                        <small>
                          {m.category?.name} · <VersionTag number={m.version?.number} />
                        </small>
                      </span>
                      <MaterialBadges material={m} pending={false} delivered={false} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="lib-kitedit__chosen" aria-labelledby="lib-kit-order">
            <h3 id="lib-kit-order" className="lib-mini-title">
              Ordem no kit
            </h3>
            {!selected.length ? (
              <p className="lib-state__muted">Marque materiais ao lado para montar o kit.</p>
            ) : (
              <ol className="lib-order">
                {sort.order.map((id, index) => {
                  const m = byId.get(id);
                  return (
                    <li key={id} className="lib-order__item" {...sort.itemProps(id)}>
                      <Handle {...sort.handleProps(id)} />
                      <span className="lib-order__n">{index + 1}</span>
                      {m && (
                        <span className="lib-order__thumb" aria-hidden="true">
                          <Art material={m} stage={1} />
                        </span>
                      )}
                      <span className="lib-order__title" title={m?.title}>
                        {m?.title ?? "Material"}
                        {m?.category?.name && <small>{m.category.name}</small>}
                      </span>
                      <span className="lib-order__ctrl">
                        <MoveButtons index={index} count={sort.order.length} label={m?.title ?? "material"} onMove={(delta) => sort.move(id, delta)} />
                        <IconButton size="sm" variant="ghost" icon={X} label={`Tirar ${m?.title ?? "material"} do kit`} tooltip={false} onClick={() => toggle(id, false)} />
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
            <Live text={sort.announcement} />
            {selected.some((id) => byId.get(id) && byId.get(id).visibility !== "released") && (
              <p className="lib-kitedit__note">
                <Plus size={13} strokeWidth={1.5} aria-hidden="true" /> Materiais ainda não liberados entram no resumo quando o kit for liberado.
              </p>
            )}
          </section>
        </div>
      </div>
    </Drawer>
  );
}
