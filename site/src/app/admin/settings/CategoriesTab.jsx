import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  FolderClosed,
  GripVertical,
  Lock,
  Pencil,
  Plus,
  Shapes,
} from "lucide-react";
import { api } from "../../api/client.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Menu,
  Modal,
  Panel,
  Segmented,
  Select,
  SkeletonRows,
  formatDate,
  plural,
  useApi,
  useToast,
} from "../../ui/index.js";
import { moveItem, useDragSort } from "../briefings/useDragSort.js";
import { useInvalidFocus } from "../clients/crmShared.jsx";

const cx = (...parts) => parts.filter(Boolean).join(" ");

export const AREAS = [
  {
    value: "identity",
    label: "Identidade visual",
    root: "Identidade visual",
    description: "Logos, paleta, tipografia e manual. Formam a área “Minha marca” do cliente.",
  },
  {
    value: "content",
    label: "Conteúdo",
    root: "Conteúdo",
    description: "Posts, stories, vídeos e campanhas da central de conteúdo.",
  },
  {
    value: "other",
    label: "Materiais",
    root: "Materiais",
    description: "Apresentações e demais arquivos entregues.",
  },
];
const areaOf = (value) => AREAS.find((area) => area.value === value) ?? AREAS[2];
const zipPath = (area, folder) => `Marca / ${areaOf(area).root} / ${folder || "…"}`;
const FOLDER_BAD = /[\\/:*?"<>|]/;

export default function CategoriesTab() {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi("/categories", { params: { archived: 1 } });
  const [view, setView] = useState("active");
  const [editing, setEditing] = useState(null); // category, or {} for a new one
  const [archiving, setArchiving] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const items = data?.items ?? [];
  const active = items.filter((item) => !item.archivedAt);
  const archived = items.filter((item) => item.archivedAt);

  const replace = (category) =>
    setData((d) => ({ ...d, items: (d?.items ?? []).map((item) => (item.id === category.id ? category : item)) }));

  const reorder = async (area, from, to) => {
    const inArea = active.filter((item) => item.area === area);
    const moved = moveItem(inArea, from, to);
    const ordered = AREAS.flatMap((a) => (a.value === area ? moved : active.filter((item) => item.area === a.value)));
    const previous = data;
    setData((d) => ({ ...d, items: [...ordered, ...archived] }));
    try {
      const res = await api.post("/categories/reorder", { ids: ordered.map((item) => item.id) }, { params: { archived: 1 } });
      setData(res);
    } catch (err) {
      setData(previous);
      toast.error(err);
    }
  };

  const archive = async () => {
    const res = await api.patch(`/categories/${archiving.id}`, { archived: true });
    replace(res.category);
    toast.success({
      message: `Categoria “${res.category.name}” arquivada.`,
      action: { label: "Desfazer", onClick: () => restore(res.category) },
    });
  };

  const restore = async (category) => {
    setRestoring(category.id);
    try {
      const res = await api.patch(`/categories/${category.id}`, { archived: false });
      replace(res.category);
      toast.success(`Categoria “${res.category.name}” restaurada.`);
    } catch (err) {
      toast.error(err);
    } finally {
      setRestoring(null);
    }
  };

  if (loading) return <SkeletonRows rows={8} columns={3} label="Carregando categorias" />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="hub-stack">
      <div className="hub-toolbar">
        <Segmented
          aria-label="Categorias ativas ou arquivadas"
          value={view}
          onChange={setView}
          options={[
            { value: "active", label: `Ativas (${active.length})` },
            { value: "archived", label: `Arquivadas (${archived.length})` },
          ]}
        />
        <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
          Nova categoria
        </Button>
      </div>
      <p className="ui-meta hub-lead">
        A categoria organiza a biblioteca, os filtros do cliente e as pastas dos ZIPs. Arraste pela alça, use as setas
        do teclado na alça ou o menu de cada linha para mudar a ordem. Categorias do sistema podem ser renomeadas, mas não
        arquivadas nem trocadas de área.
      </p>

      {view === "active" ? (
        AREAS.map((area, index) => (
          <AreaPanel
            key={area.value}
            area={area}
            index={index}
            categories={active.filter((item) => item.area === area.value)}
            onMove={(from, to) => reorder(area.value, from, to)}
            onEdit={setEditing}
            onArchive={setArchiving}
          />
        ))
      ) : archived.length ? (
        <Panel padding="sm" className="hub-catpanel">
          <ul className="hub-catlist">
            {archived.map((category) => (
              <li key={category.id} className="hub-catrow is-archived">
                <div className="hub-catrow__main">
                  <p className="hub-catrow__name">{category.name}</p>
                  <p className="hub-catrow__path">
                    {areaOf(category.area).label} · arquivada em {formatDate(category.archivedAt)} ·{" "}
                    {plural(category.materialCount ?? 0, "material", "materiais")}
                  </p>
                </div>
                <Button size="sm" icon={ArchiveRestore} loading={restoring === category.id} onClick={() => restore(category)}>
                  Restaurar
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <EmptyState
          icon={Archive}
          title="Nenhuma categoria arquivada"
          description="Categorias arquivadas deixam de aparecer para novos materiais, e os materiais que já as usam continuam onde estão."
        />
      )}

      <CategoryModal
        category={editing}
        onClose={() => setEditing(null)}
        onSaved={(category, isNew) => {
          if (isNew) setData((d) => ({ ...d, items: [...(d?.items ?? []), category] }));
          else replace(category);
          setView("active");
        }}
      />
      <ConfirmDialog
        open={Boolean(archiving)}
        onClose={() => setArchiving(null)}
        onConfirm={archive}
        title={archiving ? `Arquivar “${archiving.name}”?` : "Arquivar categoria?"}
        description={
          archiving?.materialCount
            ? `Ela deixa de aparecer para novos materiais. Os ${plural(archiving.materialCount, "material", "materiais")} que já usam esta categoria continuam onde estão.`
            : "Ela deixa de aparecer para novos materiais. Você pode restaurá-la quando quiser."
        }
        confirmLabel="Arquivar"
        icon={Archive}
      />
    </div>
  );
}

function AreaPanel({ area, categories, onMove, onEdit, onArchive, index }) {
  const sort = useDragSort({
    keys: categories.map((item) => item.id),
    onMove,
    label: (i) => `categoria ${categories[i]?.name ?? i + 1}`,
  });
  return (
    <Panel
      eyebrow={`Marca / ${area.root}`}
      title={area.label}
      description={area.description}
      padding="md"
      index={index}
      className="hub-catpanel"
      actions={<span className="ui-meta">{plural(categories.length, "categoria", "categorias")}</span>}
    >
      {categories.length === 0 ? (
        <EmptyState compact icon={Shapes} title="Nenhuma categoria nesta área" description="Crie uma em “Nova categoria”." />
      ) : (
        <ol className={cx("hub-catlist", sort.dragging && "is-sorting")}>
          {categories.map((category, i) => (
            <li
              key={category.id}
              ref={sort.itemRef(category.id)}
              style={sort.itemStyle(i)}
              className={cx("hub-catrow", sort.itemClass(i))}
            >
              <button className="hub-grip" {...sort.handleProps(i)}>
                <GripVertical size={18} strokeWidth={1.4} aria-hidden="true" />
              </button>
              <div className="hub-catrow__main">
                <p className="hub-catrow__name">
                  <span>{category.name}</span>
                  {category.isSystem && (
                    <Badge size="sm" icon={Lock} title="Categoria do sistema">
                      Sistema
                    </Badge>
                  )}
                </p>
                <p className="hub-catrow__path">
                  <FolderClosed size={13} strokeWidth={1.4} aria-hidden="true" />
                  <span>{zipPath(category.area, category.folder)}</span>
                </p>
              </div>
              <span className="hub-catrow__count ui-meta">{plural(category.materialCount ?? 0, "material", "materiais")}</span>
              <div className="hub-catrow__actions">
                <IconButton label={`Editar ${category.name}`} icon={Pencil} size="sm" variant="ghost" onClick={() => onEdit(category)} />
                <Menu
                  label={`Mais ações para ${category.name}`}
                  items={[
                    { label: "Mover para cima", icon: ArrowUp, disabled: i === 0, onSelect: () => onMove(i, i - 1) },
                    {
                      label: "Mover para baixo",
                      icon: ArrowDown,
                      disabled: i === categories.length - 1,
                      onSelect: () => onMove(i, i + 1),
                    },
                    { divider: true },
                    {
                      label: "Arquivar",
                      icon: Archive,
                      disabled: category.isSystem,
                      description: category.isSystem ? "Categorias do sistema não podem ser arquivadas" : undefined,
                      onSelect: () => onArchive(category),
                    },
                  ]}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
      <span className="ui-sr-only" aria-live="polite">
        {sort.message}
      </span>
    </Panel>
  );
}

function CategoryModal({ category, onClose, onSaved }) {
  const toast = useToast();
  const open = Boolean(category);
  const isNew = open && !category.id;
  const [form, setForm] = useState({ name: "", area: "identity", folder: "" });
  const [folderTouched, setFolderTouched] = useState(false);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [formRef, focusInvalid] = useInvalidFocus();

  useEffect(() => {
    if (!category) return;
    setForm({ name: category.name ?? "", area: category.area ?? "identity", folder: category.folder ?? "" });
    setFolderTouched(Boolean(category.id));
    setErrors({});
    setSaving(false);
  }, [category]);

  const folder = folderTouched ? form.folder : form.name.replace(/[\\/:*?"<>|]/g, "-");

  const submit = async (event) => {
    event.preventDefault();
    const local = {};
    if (!form.name.trim()) local.name = "Informe o nome da categoria.";
    if (!folder.trim()) local.folder = "Informe o nome da pasta.";
    else if (FOLDER_BAD.test(folder)) local.folder = 'Use um nome de pasta sem / \\ : * ? " < > |.';
    setErrors(local);
    if (Object.keys(local).length) return focusInvalid();
    setSaving(true);
    try {
      const body = { name: form.name.trim(), folder: folder.trim() };
      if (isNew || !category.isSystem) body.area = form.area;
      const res = isNew ? await api.post("/categories", body) : await api.patch(`/categories/${category.id}`, body);
      toast.success(isNew ? `Categoria “${res.category.name}” criada.` : "Categoria atualizada.");
      onSaved(res.category, isNew);
      onClose();
    } catch (err) {
      setSaving(false);
      if (err.fields) {
        setErrors(err.fields);
        focusInvalid(err.message);
      } else toast.error(err);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      size="sm"
      title={isNew ? "Nova categoria" : "Editar categoria"}
      description={isNew ? "Fica disponível para a equipe classificar materiais e para o cliente filtrar." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="hub-category-form" loading={saving}>
            {isNew ? "Criar categoria" : "Salvar"}
          </Button>
        </>
      }
    >
      <form ref={formRef} id="hub-category-form" className="hub-stack" onSubmit={submit} noValidate>
        <Field label="Nome" required error={errors.name}>
          <Input
            value={form.name}
            maxLength={80}
            data-autofocus
            placeholder="Ex.: Endomarketing"
            onValueChange={(name) => setForm((f) => ({ ...f, name }))}
          />
        </Field>
        <Field
          label="Área"
          required
          error={errors.area}
          hint={category?.isSystem ? "Categorias do sistema mantêm a área original." : areaOf(form.area).description}
        >
          <Select
            value={form.area}
            disabled={Boolean(category?.isSystem)}
            options={AREAS.map((area) => ({ value: area.value, label: area.label }))}
            onValueChange={(area) => setForm((f) => ({ ...f, area }))}
          />
        </Field>
        <Field label="Pasta nos ZIPs" required error={errors.folder} hint="Nome da pasta onde os arquivos desta categoria entram nos downloads.">
          <Input
            value={folder}
            maxLength={80}
            onValueChange={(value) => {
              setFolderTouched(true);
              setForm((f) => ({ ...f, folder: value }));
            }}
          />
        </Field>
        <p className="hub-zippath" aria-live="polite">
          <FolderClosed size={14} strokeWidth={1.4} aria-hidden="true" />
          {zipPath(form.area, folder.trim())}
        </p>
      </form>
    </Modal>
  );
}
