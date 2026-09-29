import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  Archive,
  ArchiveRestore,
  ChevronDown,
  FolderKanban,
  Library,
  CalendarDays,
  History,
  Mail,
  Pencil,
  Plus,
  Receipt,
  RotateCcw,
  Send,
  ShieldCheck,
  Shapes,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Menu,
  Modal,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  SkeletonCards,
  StatusBadge,
  Tabs,
  Textarea,
  formatDate,
  formatNumber,
  formatRelative,
  useApi,
  useToast,
} from "../../ui/index.js";
import ProjectFormDrawer from "../projects/ProjectFormDrawer.jsx";
import { OPEN_PROJECT, ProjectCard } from "../projects/projectShared.jsx";
import BrandDrawer from "./BrandDrawer.jsx";
import ClientFormDrawer from "./ClientFormDrawer.jsx";
import { BrandMark, InternalBadge, InviteResult, PersonCell, clean, count, inviteText, useForm, useSticky } from "./crmShared.jsx";
import "./crm.css";

// ------------------------------------------------------------------ overview

function InternalNotes({ client, canEdit, onSaved }) {
  const toast = useToast();
  const [text, setText] = useState(client.internalNotes ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setText(client.internalNotes ?? ""), [client.internalNotes]);
  const dirty = (clean(text) ?? null) !== (client.internalNotes ?? null);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.patch(`/clients/${client.id}`, { internalNotes: clean(text) });
      onSaved(res.client);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  if (!canEdit)
    return client.internalNotes ? (
      <p className="crm-notes__text">{client.internalNotes}</p>
    ) : (
      <p className="ui-muted">Sem notas internas.</p>
    );
  return (
    <div className="crm-notes">
      <Textarea
        value={text}
        onValueChange={setText}
        rows={4}
        autoGrow
        aria-label="Notas internas do cliente"
        placeholder="Preferências, combinados e contexto para a equipe. Nunca aparecem para o cliente."
      />
      <div className="crm-notes__foot">
        {saved && (
          <span className="crm-saved" role="status">
            Notas salvas
          </span>
        )}
        <Button size="sm" variant={dirty ? "primary" : "secondary"} onClick={save} loading={saving} disabled={!dirty}>
          Salvar notas
        </Button>
      </div>
    </div>
  );
}

function Overview({ data, onEdit, onClientChange, goTab }) {
  const { client, brands, users, projects, permissions } = data;
  const { can } = useAuth();
  const designer = client.document === undefined;
  const activeUsers = users.filter((u) => u.status === "active").length;
  const openProjects = projects.filter((p) => OPEN_PROJECT(p.status)).length;
  const rows = [
    ["Razão social", client.legalName],
    !designer && ["CNPJ / CPF", client.document],
    !designer && ["Contato", client.contactName],
    !designer && [
      "E-mail",
      client.contactEmail && (
        <a className="ui-link" href={`mailto:${client.contactEmail}`}>
          {client.contactEmail}
        </a>
      ),
    ],
    !designer && [
      "Telefone",
      client.contactPhone && (
        <a className="ui-link" href={`tel:${client.contactPhone.replace(/[^\d+]/g, "")}`}>
          {client.contactPhone}
        </a>
      ),
    ],
    ["Cliente desde", formatDate(client.createdAt)],
  ].filter(Boolean);

  const links = [
    permissions.canViewLibrary && { to: `/admin/biblioteca?clientId=${client.id}`, label: "Biblioteca de arquivos", icon: Library },
    permissions.canViewContent && { to: `/admin/conteudo?clientId=${client.id}`, label: "Conteúdo e calendário", icon: CalendarDays },
    permissions.canViewProjects && { to: `/admin/projetos?clientId=${client.id}`, label: "Projetos e tarefas", icon: FolderKanban },
    permissions.canViewOrders && { to: `/admin/pedidos?clientId=${client.id}`, label: "Pedidos e assinaturas", icon: Receipt },
    can("activity.view") && { to: `/admin/historico?clientId=${client.id}`, label: "Histórico do cliente", icon: History },
  ].filter(Boolean);

  return (
    <div className="crm-overview">
      <div className="crm-overview__main">
        <Panel
          title="Dados do cliente"
          index={0}
          actions={
            permissions.canEdit && (
              <Button size="sm" variant="ghost" icon={Pencil} onClick={onEdit}>
                Editar
              </Button>
            )
          }
        >
          <dl className="crm-dl">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || <span className="ui-muted">Não informado</span>}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        {client.internalNotes !== undefined && (
          <Panel title="Notas internas" index={1} actions={<InternalBadge />}>
            <InternalNotes client={client} canEdit={permissions.canEdit} onSaved={onClientChange} />
          </Panel>
        )}
      </div>
      <aside className="crm-overview__aside">
        <div className="crm-kpis">
          <button type="button" className="crm-kpi ui-enter" style={{ "--i": 1 }} onClick={() => goTab("marcas")}>
            <span className="crm-kpi__value">{formatNumber(brands.filter((b) => b.status === "active").length)}</span>
            <span className="crm-kpi__label">{brands.length === 1 ? "marca ativa" : "marcas ativas"}</span>
          </button>
          {permissions.canViewProjects && (
            <button type="button" className="crm-kpi ui-enter" style={{ "--i": 2 }} onClick={() => goTab("projetos")}>
              <span className="crm-kpi__value">{formatNumber(openProjects)}</span>
              <span className="crm-kpi__label">{openProjects === 1 ? "projeto em andamento" : "projetos em andamento"}</span>
            </button>
          )}
          {client.stats?.released !== null && client.stats?.released !== undefined && (
            <div className="crm-kpi ui-enter" style={{ "--i": 3 }}>
              <span className="crm-kpi__value">{formatNumber(client.stats.released)}</span>
              <span className="crm-kpi__label">
                {client.stats.released === 1 ? "material liberado" : "materiais liberados"}
                {client.stats.lastReleaseAt && <small>último {formatRelative(client.stats.lastReleaseAt)}</small>}
              </span>
            </div>
          )}
          {permissions.canViewUsers && (
            <button type="button" className="crm-kpi ui-enter" style={{ "--i": 4 }} onClick={() => goTab("usuarios")}>
              <span className="crm-kpi__value">{formatNumber(activeUsers)}</span>
              <span className="crm-kpi__label">{activeUsers === 1 ? "pessoa com acesso ativo" : "pessoas com acesso ativo"}</span>
            </button>
          )}
        </div>
        <nav className="crm-quicklinks" aria-label="Atalhos do cliente">
          {links.map((link) => (
            <Link key={link.to} to={link.to} className="crm-quicklink">
              <link.icon size={18} strokeWidth={1.4} aria-hidden="true" />
              <span>{link.label}</span>
              <ArrowUpRight size={16} strokeWidth={1.4} aria-hidden="true" className="crm-quicklink__go" />
            </Link>
          ))}
        </nav>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ brands

function BrandCard({ brand, index, permissions, onEdit, onToggle }) {
  const counts = brand.counts;
  const archived = brand.status === "archived";
  return (
    <Card index={index} padding="none" className={`crm-brand${archived ? " is-archived" : ""}`}>
      <div className="crm-brand__hero">
        <BrandMark name={brand.name} size={52} tone={archived ? "stone" : "olive"} />
        <span className="crm-brand__heroside">
          <StatusBadge kind="brand" value={brand.status} size="sm" />
          {permissions.canManageBrands && (
            <Menu
              label={`Ações da marca ${brand.name}`}
              items={[
                { label: "Editar marca", icon: Pencil, onSelect: () => onEdit(brand) },
                archived
                  ? { label: "Reativar marca", icon: ArchiveRestore, onSelect: () => onToggle(brand) }
                  : {
                      label: "Arquivar marca",
                      icon: Archive,
                      danger: true,
                      description: "Some das listas e do portal do cliente",
                      onSelect: () => onToggle(brand),
                    },
              ]}
            />
          )}
        </span>
      </div>
      <div className="crm-brand__body">
        <h3 className="crm-brand__name">{brand.name}</h3>
        {brand.description ? (
          <p className="crm-brand__desc">{brand.description}</p>
        ) : (
          <p className="crm-brand__desc ui-muted">Sem descrição.</p>
        )}
        {counts && (
          <dl className="crm-brand__counts">
            <div>
              <dt>Projetos</dt>
              <dd>{formatNumber(counts.activeProjects)}</dd>
            </div>
            <div>
              <dt>Materiais</dt>
              <dd>{formatNumber(counts.materials)}</dd>
            </div>
            <div>
              <dt>Liberados</dt>
              <dd>{formatNumber(counts.released)}</dd>
            </div>
            <div>
              <dt>Kits</dt>
              <dd>{formatNumber(counts.kits)}</dd>
            </div>
          </dl>
        )}
      </div>
      {permissions.canViewLibrary && (
        <nav className="crm-brand__foot crm-brand__links" aria-label={`Atalhos da marca ${brand.name}`}>
          <Link to={`/admin/marcas/${brand.id}`}>
            <Shapes size={15} strokeWidth={1.4} aria-hidden="true" /> Identidade
          </Link>
          <Link to={`/admin/biblioteca?brandId=${brand.id}`}>
            <Library size={15} strokeWidth={1.4} aria-hidden="true" /> Biblioteca
          </Link>
          {permissions.canViewContent && (
            <Link to={`/admin/conteudo?brandId=${brand.id}`}>
              <CalendarDays size={15} strokeWidth={1.4} aria-hidden="true" /> Conteúdo
            </Link>
          )}
        </nav>
      )}
    </Card>
  );
}

function BrandsTab({ data, reload }) {
  const { client, brands, permissions } = data;
  const toast = useToast();
  const [drawer, setDrawer] = useState(null); // {brand} | {brand: null}
  const [archiving, setArchiving] = useState(null);
  const drawerView = useSticky(drawer);
  const archivingView = useSticky(archiving);
  const toggle = async (brand) => {
    if (brand.status === "active") return setArchiving(brand);
    try {
      await api.patch(`/brands/${brand.id}`, { status: "active" });
      toast.success(`Marca ${brand.name} reativada.`);
      reload();
    } catch (error) {
      toast.error(error);
    }
  };
  return (
    <>
      <div className="crm-sectionhead">
        <p className="crm-sectionhead__text">
          Cada marca organiza seus próprios arquivos, projetos e identidade. As pessoas do cliente acessam todas as marcas ativas.
        </p>
        {permissions.canManageBrands && (
          <Button icon={Plus} onClick={() => setDrawer({ brand: null })}>
            Nova marca
          </Button>
        )}
      </div>
      {brands.length ? (
        <div className="crm-brand-grid">
          {brands.map((brand, index) => (
            <BrandCard key={brand.id} brand={brand} index={index} permissions={permissions} onEdit={(b) => setDrawer({ brand: b })} onToggle={toggle} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Shapes}
          title="Nenhuma marca cadastrada"
          description="Crie a primeira marca para organizar logos, identidade, conteúdo e projetos deste cliente."
          action={
            permissions.canManageBrands && (
              <Button variant="primary" size="sm" icon={Plus} onClick={() => setDrawer({ brand: null })}>
                Nova marca
              </Button>
            )
          }
        />
      )}
      <BrandDrawer
        open={Boolean(drawer)}
        onClose={() => setDrawer(null)}
        clientId={client.id}
        clientName={client.name}
        brand={drawerView?.brand ?? null}
        onSaved={() => reload()}
      />
      <ConfirmDialog
        open={Boolean(archiving)}
        onClose={() => setArchiving(null)}
        tone="danger"
        title={`Arquivar a marca ${archivingView?.name ?? ""}?`}
        description="A marca sai das listas e do portal do cliente. Arquivos, projetos e histórico são preservados e você pode reativá-la depois."
        confirmLabel="Arquivar marca"
        icon={Archive}
        onConfirm={async () => {
          await api.patch(`/brands/${archiving.id}`, { status: "archived" });
          toast.success(`Marca ${archiving.name} arquivada.`);
          reload();
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ users

function InviteUserModal({ open, onClose, client, onInvited }) {
  const toast = useToast();
  const form = useForm({ name: "", email: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) form.reset({ name: "", email: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = async (event) => {
    event.preventDefault();
    const local = {};
    if (!form.values.name.trim()) local.name = "Informe o nome.";
    if (!form.values.email.trim()) local.email = "Informe o e-mail.";
    if (Object.keys(local).length) return form.setErrors(local);
    setSaving(true);
    try {
      const res = await api.post(`/clients/${client.id}/users`, { name: form.values.name.trim(), email: form.values.email.trim() });
      onInvited(res);
      onClose();
    } catch (error) {
      if (!form.fail(error)) toast.error(error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      size="sm"
      eyebrow={client.name}
      title="Convidar pessoa do cliente"
      description="Ela recebe um link para criar a senha e passa a ver somente as marcas deste cliente e o que for liberado."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="crm-invite-client" loading={saving} icon={Send}>
            Enviar convite
          </Button>
        </>
      }
    >
      <form ref={form.ref} id="crm-invite-client" className="crm-form" onSubmit={submit} noValidate>
        <Field label="Nome" required error={form.fieldError("name")}>
          <Input {...form.bind("name")} autoComplete="off" data-autofocus />
        </Field>
        <Field label="E-mail" required error={form.fieldError("email")}>
          <Input {...form.bind("email")} type="email" autoComplete="off" icon={Mail} />
        </Field>
      </form>
    </Modal>
  );
}

function UsersTab({ data, reload, lastInvite, setLastInvite }) {
  const { client, users, permissions } = data;
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const confirmView = useSticky(confirm);
  const [busy, setBusy] = useState(null);

  const resend = async (user) => {
    setBusy(user.id);
    try {
      const res = await api.post(`/users/${user.id}/invite`);
      setLastInvite({ name: user.name, email: user.email, inviteUrl: res.inviteUrl, emailStatus: res.emailStatus });
      if (!res.inviteUrl) toast.success(`Convite reenviado para ${user.email}.`);
      reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
    }
  };
  const setStatus = async (user, status) => {
    const res = await api.patch(`/clients/${client.id}/users/${user.id}`, { status });
    toast.success(status === "disabled" ? `Acesso de ${user.name} desativado.` : res.user.status === "invited" ? `${user.name} reativado. O convite continua pendente.` : `Acesso de ${user.name} reativado.`);
    reload();
  };

  const columns = [
    {
      key: "name",
      header: "Pessoa",
      primary: true,
      sortable: true,
      render: (user) => <PersonCell name={user.name} email={user.email} muted={user.status === "disabled"} />,
      sortValue: (user) => user.name,
    },
    {
      key: "status",
      header: "Status",
      render: (user) => (
        <span className="crm-statuscell">
          <StatusBadge kind="user" value={user.status} size="sm" />
          {user.status === "invited" && <span className="ui-meta">{inviteText(user)}</span>}
        </span>
      ),
    },
    {
      key: "lastLoginAt",
      header: "Último acesso",
      nowrap: true,
      sortable: true,
      render: (user) =>
        user.lastLoginAt ? <span title={formatDate(user.lastLoginAt)}>{formatRelative(user.lastLoginAt)}</span> : <span className="ui-muted">Nunca acessou</span>,
    },
    permissions.canManageUsers && {
      key: "actions",
      header: "Ações",
      actions: true,
      render: (user) => (
        <Menu
          label={`Ações de ${user.name}`}
          items={[
            user.status === "invited" && {
              label: busy === user.id ? "Reenviando…" : "Reenviar convite",
              icon: RotateCcw,
              description: "Gera um novo link; o anterior deixa de valer",
              disabled: busy === user.id,
              onSelect: () => resend(user),
            },
            user.status !== "disabled"
              ? { label: "Desativar acesso", icon: UserMinus, danger: true, onSelect: () => setConfirm(user) }
              : { label: "Reativar acesso", icon: UserPlus, onSelect: () => setStatus(user, "active").catch((e) => toast.error(e)) },
          ]}
        />
      ),
    },
  ].filter(Boolean);

  return (
    <>
      <div className="crm-sectionhead">
        <p className="crm-sectionhead__text">
          Pessoas do cliente veem somente as marcas ativas de {client.name} e o que a equipe liberar.
          {!data.email.configured && " O e-mail não está configurado: os links de convite aparecem aqui para você repassar."}
        </p>
        {permissions.canManageUsers && client.status !== "archived" && (
          <Button icon={UserPlus} onClick={() => setInviting(true)}>
            Convidar pessoa
          </Button>
        )}
      </div>
      {lastInvite && (
        <div className="crm-invite-wrap">
          <InviteResult result={lastInvite} name={lastInvite.name} email={lastInvite.email} />
          <IconButton label="Fechar aviso" icon={X} variant="ghost" size="sm" onClick={() => setLastInvite(null)} className="crm-invite-close" />
        </div>
      )}
      <DataTable
        caption={`Pessoas de ${client.name}`}
        columns={columns}
        rows={users}
        rowLabel={(user) => user.name}
        rowClassName={(user) => (user.status === "disabled" ? "crm-row--muted" : undefined)}
        empty={{
          icon: Users,
          title: "Ninguém do cliente tem acesso ainda",
          description: "Convide a primeira pessoa para que ela acompanhe projetos, aprove conteúdos e baixe os arquivos liberados.",
          action: permissions.canManageUsers && client.status !== "archived" && (
            <Button variant="primary" size="sm" icon={UserPlus} onClick={() => setInviting(true)}>
              Convidar pessoa
            </Button>
          ),
        }}
      />
      <InviteUserModal
        open={inviting}
        onClose={() => setInviting(false)}
        client={client}
        onInvited={(res) => {
          setLastInvite({ name: res.user.name, email: res.user.email, inviteUrl: res.inviteUrl, emailStatus: res.emailStatus });
          reload();
        }}
      />
      <ConfirmDialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        tone="danger"
        title={`Desativar o acesso de ${confirmView?.name ?? ""}?`}
        description="A sessão é encerrada na hora e links de convite deixam de funcionar. O histórico é preservado e você pode reativar depois."
        confirmLabel="Desativar acesso"
        icon={UserMinus}
        onConfirm={() => setStatus(confirm, "disabled")}
      />
    </>
  );
}

// ------------------------------------------------------------------ projects

function ProjectsTab({ data, reload }) {
  const { client, projects, permissions, brands } = data;
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const open = projects.filter((p) => OPEN_PROJECT(p.status));
  const closed = projects.filter((p) => !OPEN_PROJECT(p.status));
  const canCreate = permissions.canManageProjects && brands.some((b) => b.status === "active");
  return (
    <>
      <div className="crm-sectionhead">
        <p className="crm-sectionhead__text">
          {projects.length
            ? `${count(open.length, "projeto em andamento", "projetos em andamento")}${closed.length ? ` · ${count(closed.length, "entregue ou arquivado", "entregues ou arquivados")}` : ""}.`
            : "Os projetos organizam tarefas, equipe e entregas de cada marca."}
        </p>
        <div className="ui-cluster">
          {projects.length > 0 && (
            <Button variant="ghost" iconRight={ArrowUpRight} to={`/admin/projetos?clientId=${client.id}`}>
              Abrir em Projetos
            </Button>
          )}
          {canCreate && (
            <Button icon={Plus} onClick={() => setCreating(true)}>
              Novo projeto
            </Button>
          )}
        </div>
      </div>
      {projects.length ? (
        <div className="crm-project-grid">
          {[...open, ...closed].map((project, index) => (
            <ProjectCard key={project.id} project={project} index={index} showClient={false} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={FolderKanban}
          title="Nenhum projeto ainda"
          description={
            canCreate
              ? "Abra o primeiro projeto e atribua a equipe: cada pessoa recebe o aviso do projeto atribuído."
              : "Quando a gestão abrir um projeto para este cliente, ele aparece aqui."
          }
          action={
            canCreate && (
              <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
                Novo projeto
              </Button>
            )
          }
        />
      )}
      {permissions.canManageProjects && (
        <ProjectFormDrawer
          open={creating}
          onClose={() => setCreating(false)}
          defaults={{ clientId: client.id }}
          onSaved={(project) => {
            reload();
            navigate(`/admin/projetos/${project.id}`);
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ access

function AccessTab({ data, reload }) {
  const { client, managers, permissions } = data;
  const toast = useToast();
  const team = useApi(permissions.canManageAccess ? "/team/users" : null, { params: { role: "manager" } });
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null);
  const removingView = useSticky(removing);
  const available = (team.data?.items ?? []).filter((m) => m.status !== "disabled" && !managers.some((x) => x.id === m.id));

  const add = async () => {
    if (!adding) return;
    setSaving(true);
    try {
      await api.post(`/clients/${client.id}/managers`, { userId: adding });
      const person = available.find((m) => m.id === adding);
      toast.success(`${person?.name ?? "O gestor"} agora acessa ${client.name}.`);
      setAdding("");
      reload();
      team.reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="crm-access">
      <Panel
        title="Gestores com acesso"
        description="Gestores veem e gerenciam somente os clientes liberados para eles. Administradores acessam todos; designers acessam apenas os projetos em que estão."
        index={0}
      >
        {managers.length ? (
          <ul className="crm-peoplelist">
            {managers.map((manager, index) => (
              <li key={manager.id} className="crm-peoplelist__row ui-enter" style={{ "--i": index }}>
                <PersonCell name={manager.name} email={manager.email} detail={manager.jobTitle} muted={manager.status === "disabled"} />
                <span className="crm-peoplelist__meta">
                  {manager.status !== "active" && <StatusBadge kind="user" value={manager.status} size="sm" />}
                  <span className="ui-meta">desde {formatDate(manager.grantedAt)}</span>
                </span>
                {permissions.canManageAccess && (
                  <IconButton label={`Remover acesso de ${manager.name}`} icon={X} variant="ghost" size="sm" onClick={() => setRemoving(manager)} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact icon={ShieldCheck} title="Nenhum gestor com acesso" description="Somente administradores gerenciam este cliente no momento." />
        )}
        {permissions.canManageAccess && (
          <div className="crm-access__add">
            <Field label="Adicionar gestor" hint={team.data && !available.length ? "Todos os gestores ativos já têm acesso ou não há gestores cadastrados." : undefined}>
              <Select
                value={adding}
                onValueChange={setAdding}
                placeholder={team.loading ? "Carregando…" : "Escolha um gestor"}
                options={available.map((m) => ({ value: m.id, label: m.status === "invited" ? `${m.name} (convite pendente)` : m.name }))}
                disabled={!available.length}
              />
            </Field>
            <Button onClick={add} loading={saving} disabled={!adding} icon={Plus}>
              Dar acesso
            </Button>
          </div>
        )}
      </Panel>
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        tone="danger"
        title={`Remover o acesso de ${removingView?.name ?? ""}?`}
        description={`${removingView?.name ?? "A pessoa"} deixa de ver ${client.name}, suas marcas, projetos e arquivos imediatamente.`}
        confirmLabel="Remover acesso"
        onConfirm={async () => {
          await api.del(`/clients/${client.id}/managers/${removing.id}`);
          toast.success("Acesso removido.");
          reload();
          team.reload();
        }}
      />
    </div>
  );
}

function FinanceTab({ client }) {
  const { can } = useAuth();
  return (
    <Panel
      title="Pedidos, assinaturas e pagamentos"
      description={`Cobranças de ${client.name} ficam no módulo comercial, com o status real do Mercado Pago.`}
      index={0}
    >
      <div className="ui-cluster">
        <Button variant="primary" icon={Receipt} to={`/admin/pedidos?clientId=${client.id}`}>
          Ver pedidos do cliente
        </Button>
        {can("finance.view") && (
          <Button iconRight={ArrowUpRight} to="/admin/financeiro">
            Visão financeira
          </Button>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ page

function DetailSkeleton() {
  return (
    <div className="crm-page" aria-busy="true">
      <div className="crm-skelhead">
        <Skeleton width={120} height={12} />
        <Skeleton width="42%" height={34} />
        <Skeleton width="28%" height={14} />
      </div>
      <SkeletonCards count={3} aspect={3} lines={2} minWidth={260} label="Carregando cliente" />
    </div>
  );
}

const STATUS_ACTIONS = [
  { value: "active", label: "Ativo", description: "Cliente em atendimento" },
  { value: "paused", label: "Pausado", description: "Contrato ou trabalho em pausa" },
  { value: "archived", label: "Arquivado", description: "Encerrado; histórico preservado" },
];

export default function ClientDetail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data, error, loading, reload, setData } = useApi(`/clients/${id}`);
  const client = data?.client;
  usePageTitle(client?.name || "Cliente", {
    crumbs: [{ label: "Clientes e marcas", to: "/admin/clientes" }, { label: client?.name || "Cliente" }],
  });
  const [editing, setEditing] = useState(false);
  const [statusConfirm, setStatusConfirm] = useState(null);
  const statusView = useSticky(statusConfirm);
  const [lastInvite, setLastInvite] = useState(location.state?.invite ?? null);

  // the invite link from the create flow is shown once (on the Usuários
  // tab), not after a refresh
  useEffect(() => {
    if (location.state?.invite) navigate(`${location.pathname}?aba=usuarios`, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabs = useMemo(() => {
    if (!data) return [];
    const p = data.permissions;
    return [
      { value: "visao", label: "Visão geral" },
      { value: "marcas", label: "Marcas", count: data.brands.filter((b) => b.status === "active").length },
      p.canViewUsers && { value: "usuarios", label: "Usuários", count: data.users.filter((u) => u.status !== "disabled").length },
      p.canViewProjects && { value: "projetos", label: "Projetos", count: data.projects.filter((x) => OPEN_PROJECT(x.status)).length },
      p.canViewTeam && { value: "equipe", label: "Equipe com acesso", count: data.managers.length },
      p.canViewOrders && { value: "financeiro", label: "Financeiro" },
    ].filter(Boolean);
  }, [data]);
  const requested = params.get("aba") || (location.state?.invite ? "usuarios" : "visao");
  const tab = tabs.some((t) => t.value === requested) ? requested : "visao";
  const goTab = (value) => {
    const next = new URLSearchParams(params);
    if (value === "visao") next.delete("aba");
    else next.set("aba", value);
    setParams(next, { replace: true });
  };

  if (loading) return <DetailSkeleton />;
  if (error && !data)
    return (
      <div className="crm-page">
        <ErrorState
          error={error}
          title={error.status === 404 ? "Cliente não encontrado" : undefined}
          onRetry={reload}
          action={
            <Button size="sm" variant="ghost" to="/admin/clientes">
              Voltar para clientes
            </Button>
          }
        />
      </div>
    );
  if (!data) return null;
  const { permissions } = data;

  const changeStatus = async (status) => {
    const res = await api.patch(`/clients/${client.id}`, { status });
    setData((current) => ({ ...current, client: { ...current.client, ...res.client } }));
    toast.success(`Cliente marcado como ${STATUS_ACTIONS.find((s) => s.value === status).label.toLowerCase()}.`);
  };

  const content = {
    visao: (
      <Overview
        data={data}
        onEdit={() => setEditing(true)}
        onClientChange={(next) => setData((current) => ({ ...current, client: { ...current.client, ...next } }))}
        goTab={goTab}
      />
    ),
    marcas: <BrandsTab data={data} reload={reload} />,
    usuarios: <UsersTab data={data} reload={reload} lastInvite={lastInvite} setLastInvite={setLastInvite} />,
    projetos: <ProjectsTab data={data} reload={reload} />,
    equipe: <AccessTab data={data} reload={reload} />,
    financeiro: <FinanceTab client={client} />,
  }[tab];

  return (
    <div className="crm-page">
      <PageHeader
        back={{ to: "/admin/clientes", label: "Clientes e marcas" }}
        eyebrow={client.legalName || "Cliente"}
        title={client.name}
        meta={
          <>
            <StatusBadge kind="client" value={client.status} />
            <span>{count(data.brands.filter((b) => b.status === "active").length, "marca", "marcas")}</span>
            <span>Cliente desde {formatDate(client.createdAt)}</span>
          </>
        }
        actions={
          <>
            {permissions.canEditSensitive && (
              <Menu
                label="Alterar status do cliente"
                trigger={<Button iconRight={ChevronDown}>Status</Button>}
                items={STATUS_ACTIONS.map((option) => ({
                  label: option.label,
                  description: option.description,
                  icon: option.value === client.status ? "check" : undefined,
                  disabled: option.value === client.status,
                  onSelect: () =>
                    option.value === "active" ? changeStatus("active").catch((e) => toast.error(e)) : setStatusConfirm(option.value),
                }))}
              />
            )}
            {permissions.canEdit && (
              <Button variant="primary" icon={Pencil} onClick={() => setEditing(true)}>
                Editar dados
              </Button>
            )}
          </>
        }
      />

      {client.status !== "active" && (
        <p className={`crm-banner crm-banner--${client.status}`} role="note">
          {client.status === "paused"
            ? "Cliente pausado: projetos e acessos continuam disponíveis, mas o atendimento está em pausa."
            : "Cliente arquivado: não aparece nos formulários de novos projetos. O histórico e os arquivos continuam preservados."}
        </p>
      )}

      <Tabs aria-label="Seções do cliente" items={tabs} value={tab} onChange={goTab} className="crm-tabs">
        {content}
      </Tabs>

      <ClientFormDrawer
        open={editing}
        onClose={() => setEditing(false)}
        client={client}
        canEditSensitive={permissions.canEditSensitive}
        onSaved={(next) => setData((current) => ({ ...current, client: { ...current.client, ...next } }))}
      />
      <ConfirmDialog
        open={Boolean(statusConfirm)}
        onClose={() => setStatusConfirm(null)}
        tone={statusView === "archived" ? "danger" : "default"}
        title={statusView === "archived" ? `Arquivar ${client.name}?` : `Pausar ${client.name}?`}
        description={
          statusView === "archived"
            ? "O cliente sai dos formulários de novos projetos. Marcas, arquivos, projetos e histórico são preservados. Para bloquear o portal, desative as pessoas na aba Usuários."
            : "O cliente continua com acesso ao portal. Use para contratos ou atendimentos em pausa."
        }
        confirmLabel={statusView === "archived" ? "Arquivar cliente" : "Pausar cliente"}
        onConfirm={() => changeStatus(statusConfirm)}
      />
    </div>
  );
}
