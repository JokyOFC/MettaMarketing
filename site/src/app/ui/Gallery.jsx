import { useEffect, useRef, useState } from "react";
import {
  Archive,
  CalendarDays,
  CheckCheck,
  Download,
  FolderOpen,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  Checker,
  ConfirmDialog,
  CopyButton,
  DataTable,
  DateInput,
  Drawer,
  Dropzone,
  EmptyState,
  ErrorState,
  Field,
  FileMeta,
  FilterBar,
  Icon,
  IconButton,
  Input,
  Kbd,
  Menu,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  ProgressBar,
  STATUS,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  SkeletonCards,
  SkeletonRows,
  Stat,
  StatusBadge,
  Switch,
  Tabs,
  TagInput,
  Textarea,
  Thumb,
  ToastProvider,
  Tooltip,
  formatBytes,
  formatDate,
  formatDateTime,
  formatMoney,
  formatRelative,
  statusOptions,
  useCopy,
  useDebounced,
  useMediaQuery,
  useReducedMotion,
  useToast,
} from "./index.js";
import "./gallery.css";

// Visual QA page for the kit (dev only, /admin/ui). Every sample below is
// labelled as an example; nothing here is product data.

const LOGO = "/brand/metta-logo.svg";
const PHOTO = "/images/brand-original.webp";
const PHOTO_2 = "/images/hero.webp";

const sampleFile = (over) => ({
  id: over.id,
  role: "original",
  position: 1,
  name: "arquivo.png",
  ext: "png",
  format: "PNG",
  mime: "image/png",
  sizeBytes: 482_000,
  width: 1080,
  height: 1350,
  durationMs: null,
  mediaKind: "image",
  previewStatus: "ready",
  previews: { thumb: null, preview: null, poster: null, stream: null },
  downloadable: true,
  createdAt: "2026-09-20T13:10:00Z",
  ...over,
});

const ROWS = [
  {
    id: "m1",
    title: "Logo principal",
    category: "Logotipo",
    owner: "Exemplo A",
    visibility: "released",
    approval: "approved",
    version: 3,
    updated: "2026-09-26T15:20:00Z",
    size: 1_250_000,
  },
  {
    id: "m2",
    title: "Carrossel lançamento",
    category: "Posts e carrosséis",
    owner: "Exemplo B",
    visibility: "internal_review",
    approval: "none",
    version: 1,
    updated: "2026-09-27T10:05:00Z",
    size: 18_400_000,
  },
  {
    id: "m3",
    title: "Manual da marca",
    category: "Manual da marca",
    owner: "Exemplo A",
    visibility: "released",
    approval: "pending",
    version: 2,
    updated: "2026-09-18T09:00:00Z",
    size: 9_800_000,
  },
  {
    id: "m4",
    title: "Reels bastidores",
    category: "Reels e vídeos",
    owner: "Exemplo C",
    visibility: "draft",
    approval: "none",
    version: 1,
    updated: "2026-09-28T08:40:00Z",
    size: 84_000_000,
  },
  {
    id: "m5",
    title: "Paleta institucional",
    category: "Paleta de cores",
    owner: "Exemplo B",
    visibility: "released",
    approval: "changes_requested",
    version: 2,
    updated: "2026-09-22T17:45:00Z",
    size: 320_000,
  },
];

function Section({ id, title, eyebrow, children }) {
  return (
    <section className="ui-gallery__section" aria-labelledby={`g-${id}`}>
      <div className="ui-gallery__section-head">
        <p className="ui-eyebrow">{eyebrow}</p>
        <h2 id={`g-${id}`} className="ui-title">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div className="ui-gallery__row">
      {label && <span className="ui-gallery__label">{label}</span>}
      <div className="ui-gallery__items">{children}</div>
    </div>
  );
}

function ColorChip({ name, hex }) {
  const { copy, copied } = useCopy();
  return (
    <button
      type="button"
      className="ui-gallery__swatch"
      onClick={() => copy(hex)}
      aria-label={`Copiar ${hex}`}
    >
      <span className="ui-gallery__swatch-color" style={{ background: hex }} />
      <span className="ui-gallery__swatch-text">
        <strong>{name}</strong>
        <span>{copied ? "Copiado" : hex.toUpperCase()}</span>
      </span>
      <span className="ui-sr-only" role="status">
        {copied ? `${hex} copiado` : ""}
      </span>
    </button>
  );
}

function ToastDemo() {
  const toast = useToast();
  return (
    <Row label="Avisos">
      <Button onClick={() => toast.success("Alterações salvas.")}>Sucesso</Button>
      <Button
        onClick={() =>
          toast.success({ title: "Versão aprovada", message: "A equipe foi avisada." })
        }
      >
        Sucesso com título
      </Button>
      <Button
        onClick={() =>
          toast.error(
            Object.assign(new Error("Arquivo acima do limite permitido."), { status: 413 }),
          )
        }
      >
        Erro
      </Button>
      <Button
        onClick={() =>
          toast.info("ZIP em preparação. Avisaremos quando estiver pronto.", {
            action: { label: "Ver", onClick: () => {} },
          })
        }
      >
        Informação com ação
      </Button>
    </Row>
  );
}

function UploadDemo() {
  const [items, setItems] = useState([]);
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearInterval), []);
  const start = (files) => {
    const next = files.map((file, i) => ({
      key: `${file.name}-${Date.now()}-${i}`,
      name: file.name,
      size: file.size,
      loaded: 0,
      failed: false,
    }));
    setItems((list) => [...next, ...list].slice(0, 6));
    next.forEach((item, i) => {
      const id = setInterval(() => {
        setItems((list) =>
          list.map((it) => {
            if (it.key !== item.key || it.failed || it.loaded >= it.size) return it;
            const loaded = Math.min(it.size, it.loaded + Math.max(it.size / 12, 40_000));
            const failed = i === 1 && loaded > it.size / 2;
            return { ...it, loaded, failed };
          }),
        );
      }, 180);
      timers.current.push(id);
    });
  };
  return (
    <div className="ui-stack">
      <Dropzone
        onFiles={start}
        description="Exemplo local: nada é enviado. O segundo arquivo simula uma falha."
        accept="image/*,.pdf,.svg,.ai,.mp4"
      />
      {items.length > 0 && (
        <ul className="ui-gallery__uploads">
          {items.map((item) => {
            const ratio = item.size ? item.loaded / item.size : 0;
            return (
              <li key={item.key}>
                <FileMeta name={item.name} sizeBytes={item.size} />
                <ProgressBar
                  value={ratio}
                  tone={item.failed ? "red" : "olive"}
                  label={
                    item.failed
                      ? "Falha no envio — tente de novo"
                      : ratio >= 1
                        ? "Enviado"
                        : `Enviando ${formatBytes(item.loaded)}`
                  }
                  showValue={!item.failed}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function GalleryBody() {
  const [tab, setTab] = useState("todos");
  const [view, setView] = useState("grade");
  const [tags, setTags] = useState(["lançamento", "institucional"]);
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search, 400);
  const [selected, setSelected] = useState(new Set());
  const [tableState, setTableState] = useState("data");
  const [page, setPage] = useState(3);
  const [modal, setModal] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [loadingBtn, setLoadingBtn] = useState(false);
  const [statsLoading, setStatsLoading] = useState(true);
  const [check, setCheck] = useState({ a: true, b: false });
  const [on, setOn] = useState(true);
  const [invalid, setInvalid] = useState("");
  const toast = useToast();
  const narrow = useMediaQuery("(max-width: 759.98px)");
  const reduced = useReducedMotion();

  useEffect(() => {
    const id = setTimeout(() => setStatsLoading(false), 1200);
    return () => clearTimeout(id);
  }, []);

  const columns = [
    {
      key: "title",
      header: "Material",
      primary: true,
      sortable: true,
      render: (row) => (
        <div className="ui-gallery__cell">
          <Thumb
            src={row.id === "m1" ? LOGO : PHOTO}
            bg={row.id === "m1" ? "light" : "auto"}
            aspect={1}
            className="ui-gallery__cellthumb"
          />
          <div>
            <div>{row.title}</div>
            <div className="ui-meta">{row.category}</div>
          </div>
        </div>
      ),
      sortValue: (row) => row.title,
    },
    {
      key: "visibility",
      header: "Visibilidade",
      render: (row) => <StatusBadge kind="visibility" value={row.visibility} />,
    },
    {
      key: "approval",
      header: "Aprovação",
      render: (row) => <StatusBadge kind="approval" value={row.approval} />,
    },
    {
      key: "version",
      header: "Versão",
      sortable: true,
      align: "end",
      render: (row) => `v${row.version}`,
      nowrap: true,
    },
    {
      key: "size",
      header: "Tamanho",
      sortable: true,
      align: "end",
      nowrap: true,
      render: (row) => formatBytes(row.size),
      hideOnMobile: true,
    },
    {
      key: "updated",
      header: "Atualizado",
      sortable: true,
      nowrap: true,
      render: (row) => formatRelative(row.updated),
    },
    {
      key: "actions",
      header: "Ações",
      actions: true,
      render: (row) => (
        <Menu
          label={`Ações de ${row.title}`}
          items={[
            { label: "Abrir", icon: FolderOpen, onSelect: () => toast.info(`Abrir ${row.title}`) },
            {
              label: "Baixar original",
              icon: Download,
              onSelect: () => toast.info("Exemplo: download"),
            },
            { divider: true },
            { label: "Arquivar", icon: Archive, danger: true, onSelect: () => setConfirm(row) },
          ]}
        />
      ),
    },
  ];

  return (
    <div className="app ui-gallery">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Painel", to: "/admin" },
              { label: "Configurações", to: "/admin/configuracoes" },
              { label: "Kit visual" },
            ]}
          />
        }
        eyebrow="Controle de qualidade"
        title="Kit visual da"
        accent="plataforma"
        description="Todos os componentes em seus estados. Os dados desta página são exemplos para conferência visual, não informações de clientes."
        meta={
          <>
            <span>Largura: {narrow ? "celular" : "desktop"}</span>
            <span>Movimento reduzido: {reduced ? "ativo" : "inativo"}</span>
          </>
        }
        actions={
          <>
            <Button icon={Upload}>Enviar arquivos</Button>
            <Button variant="primary" icon={Plus}>
              Novo material
            </Button>
          </>
        }
      />

      <Section id="tokens" eyebrow="Identidade" title="Cores e tipografia">
        <div className="ui-gallery__swatches">
          <ColorChip name="Oliva 950" hex="#121a0e" />
          <ColorChip name="Oliva 800" hex="#202619" />
          <ColorChip name="Oliva 700" hex="#303827" />
          <ColorChip name="Sálvia" hex="#aeb99a" />
          <ColorChip name="Papel" hex="#ede9df" />
          <ColorChip name="Superfície" hex="#f4f1e9" />
          <ColorChip name="Tinta" hex="#252a20" />
          <ColorChip name="Secundário" hex="#646858" />
        </div>
        <div className="ui-gallery__type">
          <p className="ui-display">
            Título de página <em>editorial</em>
          </p>
          <p className="ui-title">Título de seção em Raleway 300</p>
          <p>Texto de interface em Manrope 400, 14 px, para leitura rápida e hierarquia clara.</p>
          <p className="ui-meta">Metadado · 12 px · {formatDateTime("2026-09-28T14:30:00Z")}</p>
          <p className="ui-eyebrow">Etiqueta de seção</p>
        </div>
      </Section>

      <Section id="buttons" eyebrow="Ações" title="Botões">
        <Row label="Variantes">
          <Button variant="primary">Liberar ao cliente</Button>
          <Button>Salvar rascunho</Button>
          <Button variant="ghost">Cancelar</Button>
          <Button variant="danger" icon={Trash2}>
            Excluir
          </Button>
          <Button variant="link">Ver histórico</Button>
        </Row>
        <Row label="Tamanhos e ícones">
          <Button size="sm" icon={Download}>
            Baixar
          </Button>
          <Button icon={Download}>Baixar ZIP</Button>
          <Button variant="primary" iconRight="arrow-right">
            Continuar
          </Button>
          <Button variant="primary" size="lg">
            Aprovar versão
          </Button>
        </Row>
        <Row label="Estados">
          <Button
            variant="primary"
            loading={loadingBtn}
            onClick={() => {
              setLoadingBtn(true);
              setTimeout(() => {
                setLoadingBtn(false);
                toast.success("Salvo.");
              }, 1400);
            }}
          >
            Salvar (clique)
          </Button>
          <Button loading>Carregando</Button>
          <Button disabled>Indisponível</Button>
          <Button variant="primary" disabled>
            Indisponível
          </Button>
        </Row>
        <Row label="Ícone">
          <IconButton label="Editar" icon={Pencil} />
          <IconButton label="Baixar" icon={Download} variant="ghost" />
          <IconButton label="Adicionar" icon={Plus} variant="solid" />
          <IconButton label="Enviar" icon={Send} size="sm" />
          <IconButton label="Processando" icon={Send} loading />
          <Menu
            label="Mais ações"
            items={[
              { heading: "Material" },
              {
                label: "Enviar nova versão",
                icon: Upload,
                description: "Mantém o histórico anterior",
              },
              { label: "Definir como principal", icon: CheckCheck },
              { label: "Indisponível", disabled: true },
              { divider: true },
              { label: "Arquivar", icon: Archive, danger: true },
            ]}
          />
          <Menu
            align="start"
            trigger={<Button iconRight="chevron-down">Exportar</Button>}
            items={[
              { label: "CSV", onSelect: () => toast.info("Exemplo: CSV") },
              { label: "ZIP organizado", onSelect: () => toast.info("Exemplo: ZIP") },
            ]}
          />
          <Tooltip content="Atalho para buscar">
            <Kbd tabIndex={0}>/</Kbd>
          </Tooltip>
        </Row>
      </Section>

      <Section id="fields" eyebrow="Formulários" title="Campos">
        <div className="ui-gallery__form">
          <Field label="Título interno" hint="Visível apenas para a equipe." required>
            <Input placeholder="Ex.: Carrossel de lançamento" />
          </Field>
          <Field label="Link oficial da fonte" optional>
            <Input icon="link" type="url" placeholder="https://" />
          </Field>
          <Field
            label="Limite por arquivo"
            error={invalid ? undefined : "Informe um limite maior que zero."}
          >
            <Input
              suffix="MB"
              inputMode="numeric"
              value={invalid}
              onValueChange={setInvalid}
              placeholder="1024"
            />
          </Field>
          <Field label="Categoria">
            <Select
              placeholder="Selecione"
              options={[
                { value: "logo", label: "Logotipo" },
                { value: "id", label: "Identidade visual" },
                { value: "posts", label: "Posts e carrosséis" },
              ]}
            />
          </Field>
          <Field label="Data prevista">
            <DateInput defaultValue="2026-10-12" />
          </Field>
          <Field label="Etiquetas" hint="Enter ou vírgula adiciona; Backspace remove a última.">
            <TagInput
              value={tags}
              onChange={setTags}
              suggestions={["campanha", "institucional", "produto"]}
            />
          </Field>
          <Field label="Legenda" className="ui-gallery__wide">
            <Textarea autoGrow rows={3} placeholder="Escreva a legenda…" />
          </Field>
          <div className="ui-stack ui-gallery__wide" style={{ "--gap": "14px" }}>
            <Checkbox
              label="Incluir arquivos editáveis"
              description="Somente quando o serviço inclui editáveis."
              checked={check.a}
              onCheckedChange={(v) => setCheck((c) => ({ ...c, a: v }))}
            />
            <Checkbox
              label="Notificar por e-mail"
              checked={check.b}
              onCheckedChange={(v) => setCheck((c) => ({ ...c, b: v }))}
            />
            <Checkbox
              label="Parcial (indeterminado)"
              indeterminate
              checked={false}
              onChange={() => {}}
            />
            <Checkbox label="Desativado" disabled />
            <Switch
              label="Download liberado"
              description="O cliente pode baixar os arquivos finais."
              checked={on}
              onCheckedChange={setOn}
            />
          </div>
        </div>
      </Section>

      <Section id="status" eyebrow="Estados" title="Rótulos de status">
        {[
          "visibility",
          "approval",
          "publication",
          "version",
          "project",
          "task",
          "order",
          "subscription",
          "payment",
          "briefing",
          "zip",
          "role",
          "user",
          "kit",
          "email",
          "previewStatus",
        ].map((kind) => (
          <Row key={kind} label={kind}>
            {Object.keys(STATUS[kind]).map((value) => (
              <StatusBadge key={value} kind={kind} value={value} />
            ))}
          </Row>
        ))}
        <Row label="entrega e arquivo">
          <StatusBadge kind="delivered" value="2026-09-20T10:00:00Z" />
          <StatusBadge kind="archived" value="2026-09-20T10:00:00Z" />
        </Row>
        <Row label="Badge">
          {["neutral", "slate", "olive", "amber", "clay", "teal", "red", "dark", "outline"].map(
            (tone) => (
              <Badge key={tone} tone={tone}>
                {tone}
              </Badge>
            ),
          )}
          <Badge tone="outline" icon="file">
            Carrossel · 8
          </Badge>
          <Badge size="sm">Pequeno</Badge>
        </Row>
      </Section>

      <Section id="nav" eyebrow="Navegação" title="Abas, alternância e paginação">
        <Tabs
          aria-label="Filtrar materiais"
          value={tab}
          onChange={setTab}
          items={[
            { value: "todos", label: "Todos", count: 42 },
            { value: "pendentes", label: "Aguardando aprovação", count: 5 },
            { value: "ajustes", label: "Ajustes solicitados", count: 2 },
            { value: "arquivados", label: "Arquivados" },
          ]}
        >
          <p className="ui-muted">Painel da aba “{tab}”. Use as setas para trocar de aba.</p>
        </Tabs>
        <Row label="Visualização">
          <Segmented
            aria-label="Modo de visualização"
            value={view}
            onChange={setView}
            options={[
              { value: "grade", label: "Grade", icon: LayoutGrid },
              { value: "lista", label: "Lista", icon: List },
              { value: "calendario", label: "Calendário", icon: CalendarDays },
            ]}
          />
          <Segmented
            aria-label="Modo compacto"
            size="sm"
            iconOnly
            value={view}
            onChange={setView}
            options={[
              { value: "grade", label: "Grade", icon: LayoutGrid },
              { value: "lista", label: "Lista", icon: List },
              { value: "calendario", label: "Calendário", icon: CalendarDays },
            ]}
          />
        </Row>
        <Pagination page={page} pageSize={50} total={612} onChange={setPage} />
      </Section>

      <Section id="cards" eyebrow="Resumo" title="Indicadores, cards e painéis">
        <div className="ui-gallery__stats">
          <Stat
            index={0}
            label="Projetos em andamento"
            value={statsLoading ? null : 7}
            loading={statsLoading}
            hint="Exemplo"
            to="/admin/projetos"
            icon="projects"
          />
          <Stat
            index={1}
            label="Aprovações pendentes"
            value={statsLoading ? null : 3}
            loading={statsLoading}
            tone="amber"
            hint="Exemplo"
          />
          <Stat
            index={2}
            label="Ajustes solicitados"
            value={statsLoading ? null : 1}
            loading={statsLoading}
            tone="clay"
          />
          <Stat
            index={3}
            label="Pagamentos pendentes"
            value={statsLoading ? null : formatMoney(150000)}
            loading={statsLoading}
            tone="teal"
          />
        </div>
        <div className="ui-grid" style={{ "--min": "220px" }}>
          {[
            { title: "Logo principal", bg: "light", src: LOGO, kind: "vector" },
            { title: "Versão escura", bg: "dark", src: LOGO, kind: "vector" },
            { title: "Transparência", bg: "checker", src: LOGO, kind: "vector" },
            { title: "Post estático", bg: "auto", src: PHOTO, kind: "image", aspect: 4 / 5 },
          ].map((item, i) => (
            <Card
              key={item.title}
              index={i}
              padding="none"
              onClick={() => toast.info(`Exemplo: abrir ${item.title}`)}
              className="ui-gallery__card"
            >
              <Thumb
                src={item.src}
                bg={item.bg}
                aspect={item.aspect || 4 / 3}
                mediaKind={item.kind}
                alt=""
                className={item.bg === "dark" ? "ui-gallery__invert" : undefined}
              />
              <div className="ui-gallery__card-body">
                <strong>{item.title}</strong>
                <FileMeta
                  showName={false}
                  format={item.kind === "vector" ? "SVG" : "WEBP"}
                  sizeBytes={48_200}
                  version={2}
                  date="2026-09-24"
                />
              </div>
            </Card>
          ))}
        </div>
        <Panel
          eyebrow="Projeto"
          title="Identidade visual"
          description="Painel com cabeçalho, ações e rodapé."
          actions={
            <>
              <Button size="sm">Editar</Button>
              <Menu items={[{ label: "Duplicar" }, { label: "Arquivar", danger: true }]} />
            </>
          }
          footer={<Button variant="primary">Salvar</Button>}
        >
          <p className="ui-prose">
            Conteúdo do painel. Espaçamento generoso, linhas finas e hierarquia clara, com títulos
            leves e metadados em Manrope.
          </p>
        </Panel>
      </Section>

      <Section id="table" eyebrow="Listas" title="Tabela de dados">
        <FilterBar
          search={
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Buscar materiais"
              shortcut="/"
            />
          }
          activeCount={search ? 1 : 0}
          onClear={() => setSearch("")}
          summary={debounced ? `Busca aplicada: “${debounced}”` : "Sem filtros"}
          actions={
            <Segmented
              size="sm"
              aria-label="Estado da tabela"
              value={tableState}
              onChange={setTableState}
              options={[
                { value: "data", label: "Dados" },
                { value: "loading", label: "Carregando" },
                { value: "empty", label: "Vazia" },
                { value: "error", label: "Erro" },
              ]}
            />
          }
        >
          <Select
            size="md"
            aria-label="Visibilidade"
            placeholder="Visibilidade"
            options={statusOptions("visibility")}
          />
          <Select
            size="md"
            aria-label="Aprovação"
            placeholder="Aprovação"
            options={statusOptions("approval")}
          />
        </FilterBar>
        <DataTable
          caption="Materiais de exemplo"
          columns={columns}
          rows={
            tableState === "data"
              ? ROWS.filter((r) => r.title.toLowerCase().includes(debounced.toLowerCase()))
              : []
          }
          loading={tableState === "loading"}
          error={
            tableState === "error"
              ? Object.assign(
                  new Error("Sem conexão com o servidor. Verifique sua internet e tente de novo."),
                  { status: 0, code: "network" },
                )
              : null
          }
          onRetry={() => setTableState("data")}
          empty={{
            icon: FolderOpen,
            title: "Nenhum material encontrado",
            description: "Ajuste os filtros ou envie os primeiros arquivos.",
            action: <Button icon={Upload}>Enviar arquivos</Button>,
          }}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          rowLabel={(row) => row.title}
          onRowClick={(row) => toast.info(`Abrir ${row.title}`)}
          defaultSort={{ key: "updated", dir: "desc" }}
          bulkActions={[
            {
              label: "Liberar",
              icon: Send,
              onClick: (ids) => toast.success(`${ids.length} prontos para o resumo de liberação.`),
            },
            { label: "Baixar ZIP", icon: Download, onClick: () => toast.info("Exemplo: ZIP") },
            {
              label: "Arquivar",
              icon: Archive,
              tone: "danger",
              onClick: (ids, rows, clear) => {
                clear();
                toast.success("Arquivados (exemplo).");
              },
            },
          ]}
        />
      </Section>

      <Section id="media" eyebrow="Arquivos" title="Prévias, metadados e envio">
        <div className="ui-gallery__thumbs">
          <figure>
            <Thumb src={LOGO} bg="light" aspect={4 / 3} mediaKind="vector" />
            <figcaption>Logo · fundo claro</figcaption>
          </figure>
          <figure>
            <Thumb
              src={LOGO}
              bg="dark"
              aspect={4 / 3}
              mediaKind="vector"
              className="ui-gallery__invert"
            />
            <figcaption>Logo · fundo escuro</figcaption>
          </figure>
          <figure>
            <Thumb src={LOGO} bg="checker" aspect={4 / 3} mediaKind="vector" />
            <figcaption>Logo · transparência</figcaption>
          </figure>
          <figure>
            <Thumb
              file={sampleFile({
                id: "f1",
                previews: { thumb: PHOTO_2 },
                width: 1920,
                height: 1080,
                mediaKind: "video",
                format: "MP4",
                durationMs: 42_000,
              })}
            />
            <figcaption>Vídeo com capa</figcaption>
          </figure>
          <figure>
            <Thumb
              file={sampleFile({ id: "f2", previews: { thumb: PHOTO }, width: 1080, height: 1350 })}
              badge="1/8"
            />
            <figcaption>Carrossel identificado</figcaption>
          </figure>
          <figure>
            <Thumb
              file={sampleFile({
                id: "f3",
                name: "manual-da-marca.pdf",
                format: "PDF",
                mediaKind: "pdf",
                previewStatus: "unsupported",
                width: null,
                height: null,
              })}
              aspect={3 / 4}
            />
            <figcaption>PDF sem prévia</figcaption>
          </figure>
          <figure>
            <Thumb
              file={sampleFile({
                id: "f4",
                name: "logo-editavel.ai",
                format: "AI",
                mediaKind: "design",
                previewStatus: "unsupported",
              })}
              aspect={4 / 3}
            />
            <figcaption>Editável</figcaption>
          </figure>
          <figure>
            <Thumb
              file={sampleFile({ id: "f5", name: "post.png", previewStatus: "pending" })}
              aspect={1}
            />
            <figcaption>Prévia em processamento</figcaption>
          </figure>
          <figure>
            <Thumb src="/nao-existe.png" name="imagem.png" aspect={1} />
            <figcaption>Falha ao carregar</figcaption>
          </figure>
          <figure>
            <Thumb
              file={sampleFile({
                id: "f6",
                name: "fonte-titulos.otf",
                format: "OTF",
                mediaKind: "font",
                previewStatus: "unsupported",
              })}
              aspect={16 / 9}
              bg="dark"
            />
            <figcaption>Fonte · fundo escuro</figcaption>
          </figure>
        </div>
        <div className="ui-gallery__metas">
          <FileMeta
            file={sampleFile({
              id: "x",
              name: "carrossel-lancamento-slide-01.png",
              sizeBytes: 1_258_291,
            })}
            version={2}
            dimensions
          />
          <FileMeta
            name="kit-de-marca.zip"
            format="ZIP"
            sizeBytes={148_000_000}
            date="2026-09-27"
            layout="inline"
          />
          <Checker className="ui-gallery__checker">Checker 14 px</Checker>
        </div>
        <UploadDemo />
      </Section>

      <Section id="overlays" eyebrow="Camadas" title="Modais, painel lateral e confirmação">
        <Row>
          <Button onClick={() => setModal("sm")}>Modal pequeno</Button>
          <Button onClick={() => setModal("md")}>Modal médio</Button>
          <Button onClick={() => setModal("lg")}>Modal grande</Button>
          <Button onClick={() => setModal("drawer")}>Painel lateral</Button>
          <Button variant="danger" onClick={() => setConfirm({ title: "Arquivo de exemplo" })}>
            Confirmar exclusão
          </Button>
        </Row>
        <Modal
          open={modal === "sm" || modal === "md" || modal === "lg"}
          size={modal === "drawer" ? "md" : modal || "md"}
          onClose={() => setModal(null)}
          eyebrow="Liberação"
          title="Resumo antes de liberar"
          description="Confira o cliente destinatário, os materiais e as permissões."
          footer={
            <>
              <Button variant="ghost" onClick={() => setModal(null)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                icon={Send}
                onClick={() => {
                  setModal(null);
                  toast.success("Materiais liberados (exemplo).");
                }}
              >
                Liberar
              </Button>
            </>
          }
        >
          <div className="ui-stack">
            <Field label="Mensagem ao cliente" optional>
              <Textarea rows={3} data-autofocus placeholder="Opcional" />
            </Field>
            <Switch label="Notificar por e-mail" defaultChecked />
            <Button size="sm" onClick={() => toast.error("Erro mostrado por cima do modal.")}>
              Testar aviso dentro do modal
            </Button>
            <Menu
              align="start"
              trigger={
                <Button size="sm" iconRight="chevron-down">
                  Menu dentro do modal
                </Button>
              }
              items={[{ label: "Primeira opção" }, { label: "Segunda opção" }]}
            />
          </div>
        </Modal>
        <Drawer
          open={modal === "drawer"}
          onClose={() => setModal(null)}
          eyebrow="Material"
          title="Detalhes"
          description="Painel lateral com as mesmas regras do modal."
        >
          <div className="ui-stack">
            <Thumb src={PHOTO} aspect={4 / 5} />
            <FileMeta
              name="post-lancamento.png"
              format="PNG"
              sizeBytes={2_400_000}
              version={3}
              date="2026-09-26"
            />
            <SkeletonRows rows={3} columns={2} />
          </div>
        </Drawer>
        <ConfirmDialog
          open={Boolean(confirm)}
          onClose={() => setConfirm(null)}
          tone="danger"
          title="Arquivar material?"
          description={
            confirm
              ? `“${confirm.title}” sai das listas do cliente. O histórico é preservado.`
              : undefined
          }
          confirmLabel="Arquivar"
          onConfirm={() =>
            new Promise((resolve, reject) =>
              setTimeout(
                () =>
                  Math.random() > 0.5
                    ? resolve()
                    : reject(new Error("Não foi possível arquivar agora. Tente de novo.")),
                900,
              ),
            ).then(() => toast.success("Arquivado (exemplo)."))
          }
        />
      </Section>

      <Section id="feedback" eyebrow="Retorno" title="Avisos, cópia, progresso e estados">
        <ToastDemo />
        <Row label="Copiar">
          <CopyButton text="#202619" label="Copiar HEX" />
          <CopyButton text="Legenda de exemplo #metta" label="Copiar legenda" variant="secondary" />
          <CopyButton text="#aeb99a" iconOnly label="Copiar #aeb99a" />
        </Row>
        <div className="ui-gallery__progress">
          <ProgressBar value={0.42} label="Gerando ZIP · 42 de 100 MB" showValue />
          <ProgressBar value={1} label="Concluído" showValue tone="sage" />
          <ProgressBar label="Tamanho ainda desconhecido" />
          <ProgressBar value={0.66} size="sm" aria-label="Progresso pequeno" />
        </div>
        <Row label="Pessoas">
          <Avatar name="Ana Exemplo" />
          <Avatar name="Bruno Modelo" size={40} />
          <Avatar name="Carla" size={28} />
          <Avatar name="Diego Teste" size={48} />
        </Row>
        <div className="ui-gallery__skeletons">
          <div>
            <Skeleton height={20} width="60%" />
            <Skeleton height={12} width="90%" style={{ marginTop: 10 }} />
            <Skeleton height={12} width="75%" style={{ marginTop: 6 }} />
          </div>
          <SkeletonCards count={3} aspect={4 / 3} minWidth={160} />
        </div>
        <div className="ui-gallery__states">
          <Card padding="none">
            <EmptyState
              title="Nenhuma aprovação pendente"
              description="Quando a equipe liberar uma nova versão, ela aparece aqui."
              action={<Button size="sm">Ver histórico</Button>}
            />
          </Card>
          <Card padding="none">
            <ErrorState
              error={Object.assign(
                new Error("Sem conexão com o servidor. Verifique sua internet e tente de novo."),
                { status: 0, code: "network" },
              )}
              onRetry={() => toast.info("Tentando de novo…")}
            />
          </Card>
          <Card padding="none">
            <ErrorState
              error={Object.assign(
                new Error(
                  "Não encontramos este item. Ele pode ter sido removido ou não estar disponível para você.",
                ),
                { status: 404 },
              )}
              compact
            />
          </Card>
        </div>
        <p className="ui-meta">
          Formatos: {formatDate("2026-10-12")} · {formatDateTime("2026-10-12T17:30:00Z")} ·{" "}
          {formatRelative(new Date(Date.now() - 5 * 60_000))} · {formatMoney(150000)} ·{" "}
          {formatBytes(1_258_291)} · <Icon name="check" size={14} /> ícones com traço 1,4
        </p>
      </Section>
    </div>
  );
}

export default function Gallery() {
  return (
    <ToastProvider>
      <GalleryBody />
    </ToastProvider>
  );
}
