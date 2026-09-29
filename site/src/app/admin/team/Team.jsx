import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { KeyRound, Pencil, RotateCcw, ShieldCheck, UserCog, UserMinus, UserPlus, Users, X } from "lucide-react";
import { api } from "../../api/client.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  FilterBar,
  Field,
  IconButton,
  Input,
  Menu,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  StatusBadge,
  Tabs,
  formatDate,
  formatRelative,
  useApi,
  useIsNarrow,
  useToast,
} from "../../ui/index.js";
import { InviteResult, PersonCell, clean, inviteText, useForm, useSticky } from "../clients/crmShared.jsx";
import AccessEditor from "./AccessEditor.jsx";
import InviteStaffDrawer, { RoleChoice } from "./InviteStaffDrawer.jsx";
import PermissionMatrix, { ROLE_SCOPES } from "./PermissionMatrix.jsx";
import "../clients/crm.css";

const ROLE_FILTERS = [
  { value: "", label: "Todos os papéis" },
  { value: "admin", label: "Administradores" },
  { value: "manager", label: "Gestores" },
  { value: "designer", label: "Designers/editores" },
  { value: "finance", label: "Financeiro" },
];
const STATUS_FILTERS = [
  { value: "", label: "Todos os status" },
  { value: "active", label: "Ativos" },
  { value: "invited", label: "Convite pendente" },
  { value: "disabled", label: "Desativados" },
];

function AccessCell({ person }) {
  if (person.access.kind === "all")
    return <span className="crm-accesscell">{person.role === "finance" ? "Todos (somente comercial)" : "Todos os clientes"}</span>;
  const clients = person.access.clients;
  if (!clients.length)
    return <span className="crm-accesscell ui-muted">{person.role === "manager" ? "Nenhum cliente liberado" : "Sem projetos atribuídos"}</span>;
  const shown = clients.slice(0, 2);
  return (
    <span className="crm-accesscell" title={clients.map((c) => c.name).join(", ")}>
      {person.role === "designer" && <span className="ui-meta">Via projetos: </span>}
      <span className="crm-chips">
        {shown.map((client) => (
          <span key={client.id} className="crm-chip">
            {client.name}
          </span>
        ))}
        {clients.length > shown.length && <span className="crm-chip crm-chip--more">+{clients.length - shown.length}</span>}
      </span>
    </span>
  );
}

function EditPersonModal({ person: current, onClose, onSaved }) {
  const person = useSticky(current);
  const toast = useToast();
  const form = useForm({ name: "", jobTitle: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (person) form.reset({ name: person.name, jobTitle: person.jobTitle ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id]);
  const submit = async (event) => {
    event.preventDefault();
    if (!form.values.name.trim()) return form.setErrors({ name: "Informe o nome." });
    setSaving(true);
    try {
      const res = await api.patch(`/team/users/${person.id}`, { name: form.values.name.trim(), jobTitle: clean(form.values.jobTitle) });
      toast.success("Dados salvos.");
      onSaved(res.user);
      onClose();
    } catch (error) {
      if (!form.fail(error)) toast.error(error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={Boolean(current)}
      onClose={saving ? undefined : onClose}
      size="sm"
      eyebrow="Equipe"
      title={`Editar ${person?.name ?? ""}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="crm-edit-person" loading={saving}>
            Salvar
          </Button>
        </>
      }
    >
      <form ref={form.ref} id="crm-edit-person" className="crm-form" onSubmit={submit} noValidate>
        <Field label="Nome" required error={form.fieldError("name")}>
          <Input {...form.bind("name")} data-autofocus />
        </Field>
        <Field label="Cargo" optional error={form.fieldError("jobTitle")}>
          <Input {...form.bind("jobTitle")} />
        </Field>
      </form>
    </Modal>
  );
}

function RoleModal({ person: current, onClose, onSaved }) {
  const person = useSticky(current);
  const toast = useToast();
  const [role, setRole] = useState(person?.role ?? "designer");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setRole(person?.role ?? "designer");
    setError(null);
  }, [person?.id, person?.role]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch(`/team/users/${person.id}`, { role });
      toast.success(`${person.name} agora é ${ROLE_SCOPES[role].title}.`);
      onSaved(res.user);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };
  const changed = person && role !== person.role;
  return (
    <Modal
      open={Boolean(current)}
      onClose={saving ? undefined : onClose}
      size="md"
      eyebrow="Alterar papel"
      title={person?.name}
      description="O papel muda o que a pessoa pode fazer a partir da próxima ação. Tudo fica registrado no histórico."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!changed}>
            {changed ? `Mudar para ${ROLE_SCOPES[role].title}` : "Escolha outro papel"}
          </Button>
        </>
      }
    >
      {person && <RoleChoice value={role} onChange={setRole} name={`role-${person.id}`} />}
      {changed && person.role === "manager" && (
        <p className="crm-banner crm-banner--paused">Ao deixar de ser gestor, {person.name} perde o acesso por cliente que tinha hoje.</p>
      )}
      {changed && role === "manager" && (
        <p className="crm-form__note">Depois da mudança, libere os clientes na aba “Acesso por cliente”.</p>
      )}
      {error && (
        <p className="ui-inline-error" role="alert">
          <span>{error.message}</span>
        </p>
      )}
    </Modal>
  );
}

export default function Team() {
  usePageTitle("Equipe e permissões");
  const toast = useToast();
  const narrow = useIsNarrow();
  const [params, setParams] = useSearchParams();
  const tab = ["pessoas", "acesso", "permissoes"].includes(params.get("aba")) ? params.get("aba") : "pessoas";
  const q = params.get("q") ?? "";
  const role = params.get("papel") ?? "";
  const status = params.get("status") ?? "";
  const { data, error, loading, reload, setData } = useApi("/team/users");
  const people = useMemo(() => data?.items ?? [], [data]);
  const canManage = Boolean(data?.permissions?.canManage);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [roleFor, setRoleFor] = useState(null);
  const [statusFor, setStatusFor] = useState(null);
  const statusView = useSticky(statusFor);
  const [lastInvite, setLastInvite] = useState(null);
  const [busy, setBusy] = useState(null);
  const [accessManager, setAccessManager] = useState(null);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const replacePerson = (user) =>
    setData((current) => (current ? { ...current, items: current.items.map((item) => (item.id === user.id ? { ...item, ...user } : item)) } : current));

  const rows = people.filter((person) => {
    if (role && person.role !== role) return false;
    if (status && person.status !== status) return false;
    if (q) {
      const text = `${person.name} ${person.email} ${person.jobTitle ?? ""}`.toLowerCase();
      if (!text.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const resend = async (person) => {
    setBusy(person.id);
    try {
      const res = await api.post(`/users/${person.id}/invite`);
      setLastInvite({ name: person.name, email: person.email, inviteUrl: res.inviteUrl, emailStatus: res.emailStatus });
      if (!res.inviteUrl) toast.success(`Convite reenviado para ${person.email}.`);
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const changeStatus = async (person, next) => {
    const res = await api.patch(`/team/users/${person.id}`, { status: next });
    replacePerson(res.user);
    toast.success(next === "disabled" ? `Acesso de ${person.name} desativado.` : `Acesso de ${person.name} reativado.`);
  };

  const columns = [
    {
      key: "name",
      header: "Pessoa",
      primary: true,
      sortable: true,
      sortValue: (p) => p.name,
      render: (p) => (
        <PersonCell
          name={p.name}
          email={p.email}
          detail={p.jobTitle}
          muted={p.status === "disabled"}
          badge={
            p.isSelf && (
              <Badge tone="outline" size="sm">
                Você
              </Badge>
            )
          }
        />
      ),
    },
    {
      key: "role",
      header: "Papel",
      nowrap: true,
      sortable: true,
      sortValue: (p) => ["admin", "manager", "designer", "finance"].indexOf(p.role),
      render: (p) => <StatusBadge kind="role" value={p.role} size="sm" />,
    },
    {
      key: "status",
      header: "Status",
      render: (p) => (
        <span className="crm-statuscell">
          <StatusBadge kind="user" value={p.status} size="sm" />
          {p.status === "invited" && <span className="ui-meta">{inviteText(p)}</span>}
        </span>
      ),
    },
    { key: "access", header: "Clientes", render: (p) => <AccessCell person={p} /> },
    {
      key: "lastLoginAt",
      header: "Último acesso",
      nowrap: true,
      sortable: true,
      hideOnMobile: true,
      render: (p) =>
        p.lastLoginAt ? <span title={formatDate(p.lastLoginAt)}>{formatRelative(p.lastLoginAt)}</span> : <span className="ui-muted">Nunca</span>,
    },
    canManage && {
      key: "actions",
      header: "Ações",
      actions: true,
      render: (p) => (
        <Menu
          label={`Ações de ${p.name}`}
          items={[
            { label: "Editar nome e cargo", icon: Pencil, onSelect: () => setEditing(p) },
            {
              label: "Alterar papel",
              icon: UserCog,
              disabled: p.isSelf,
              description: p.isSelf ? "Você não pode alterar o próprio papel" : undefined,
              onSelect: () => setRoleFor(p),
            },
            p.role === "manager" && {
              label: "Acesso a clientes",
              icon: ShieldCheck,
              onSelect: () => {
                setAccessManager(p.id);
                setParam("aba", "acesso");
              },
            },
            p.status === "invited" && {
              label: busy === p.id ? "Reenviando…" : "Reenviar convite",
              icon: RotateCcw,
              description: "Gera um novo link; o anterior deixa de valer",
              disabled: busy === p.id,
              onSelect: () => resend(p),
            },
            { divider: true },
            p.status === "disabled"
              ? { label: "Reativar acesso", icon: UserPlus, onSelect: () => setStatusFor({ person: p, next: "active" }) }
              : {
                  label: "Desativar acesso",
                  icon: UserMinus,
                  danger: true,
                  disabled: p.isSelf,
                  description: p.isSelf ? "Você não pode desativar o próprio acesso" : undefined,
                  onSelect: () => setStatusFor({ person: p, next: "disabled" }),
                },
          ]}
        />
      ),
    },
  ].filter(Boolean);

  const counts = {
    total: people.filter((p) => p.status !== "disabled").length,
    managers: people.filter((p) => p.role === "manager" && p.status !== "disabled").length,
  };

  const peopleTab = (
    <>
      <FilterBar
        search={<SearchInput value={q} onChange={(v) => setParam("q", v.trim())} placeholder="Buscar por nome, e-mail ou cargo" label="Buscar na equipe" />}
        activeCount={(role ? 1 : 0) + (status ? 1 : 0)}
        onClear={() => {
          const next = new URLSearchParams(params);
          next.delete("papel");
          next.delete("status");
          setParams(next, { replace: true });
        }}
        summary={data ? `${rows.length} de ${people.length} ${people.length === 1 ? "pessoa" : "pessoas"}` : null}
      >
        <Select aria-label="Filtrar por papel" size="sm" options={ROLE_FILTERS} value={role} onValueChange={(v) => setParam("papel", v)} />
        <Select aria-label="Filtrar por status" size="sm" options={STATUS_FILTERS} value={status} onValueChange={(v) => setParam("status", v)} />
      </FilterBar>
      {lastInvite && (
        <div className="crm-invite-wrap">
          <InviteResult result={lastInvite} name={lastInvite.name} email={lastInvite.email} />
          <IconButton label="Fechar aviso" icon={X} variant="ghost" size="sm" onClick={() => setLastInvite(null)} className="crm-invite-close" />
        </div>
      )}
      <DataTable
        caption="Equipe"
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={reload}
        rowLabel={(p) => p.name}
        rowClassName={(p) => (p.status === "disabled" ? "crm-row--muted" : undefined)}
        empty={
          people.length
            ? { icon: Users, title: "Ninguém com estes filtros", description: "Ajuste a busca, o papel ou o status." }
            : {
                icon: Users,
                title: "A equipe ainda está vazia",
                description: "Convide gestores, designers e o financeiro. Cada papel recebe só o acesso de que precisa.",
                action: canManage && (
                  <Button variant="primary" size="sm" icon={UserPlus} onClick={() => setInviting(true)}>
                    Convidar pessoa
                  </Button>
                ),
              }
        }
      />
    </>
  );

  const tabs = [
    { value: "pessoas", label: "Pessoas", count: data ? counts.total : undefined, content: peopleTab },
    {
      value: "acesso",
      label: narrow ? "Acesso" : "Acesso por cliente",
      count: data ? counts.managers : undefined,
      content: data ? (
        <AccessEditor people={people} canManage={canManage} onSaved={reload} managerId={accessManager} onManagerChange={setAccessManager} />
      ) : null,
    },
    { value: "permissoes", label: narrow ? "Papéis" : "Permissões por papel", content: <PermissionMatrix /> },
  ];

  return (
    <div className="crm-page">
      <PageHeader
        eyebrow="Gestão"
        title="Equipe e"
        accent="permissões"
        description="Quem faz parte da Metta, o papel de cada pessoa e quais clientes ela alcança. Menor acesso necessário, sempre."
        actions={
          canManage && (
            <Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)}>
              Convidar pessoa
            </Button>
          )
        }
      />
      {data && !data.email?.configured && canManage && (
        <p className="crm-banner crm-banner--note" role="note">
          <KeyRound size={16} strokeWidth={1.4} aria-hidden="true" />
          O envio de e-mails não está configurado: ao convidar, o link aparece aqui para você repassar com segurança.
        </p>
      )}
      <Tabs aria-label="Seções da equipe" items={tabs} value={tab} onChange={(v) => setParam("aba", v === "pessoas" ? "" : v)} className="crm-tabs" />

      {canManage && (
        <InviteStaffDrawer
          open={inviting}
          onClose={() => setInviting(false)}
          onInvited={() => reload()}
        />
      )}
      <EditPersonModal person={editing} onClose={() => setEditing(null)} onSaved={replacePerson} />
      <RoleModal person={roleFor} onClose={() => setRoleFor(null)} onSaved={() => reload()} />
      <ConfirmDialog
        open={Boolean(statusFor)}
        onClose={() => setStatusFor(null)}
        tone={statusView?.next === "disabled" ? "danger" : "default"}
        title={statusView?.next === "disabled" ? `Desativar o acesso de ${statusView?.person.name}?` : `Reativar o acesso de ${statusView?.person.name ?? ""}?`}
        description={
          statusView?.next === "disabled"
            ? "A sessão é encerrada na hora e os links de convite deixam de valer. Projetos e histórico continuam preservados."
            : "A pessoa volta a entrar com a mesma senha. Se ainda não tinha ativado o acesso, o convite volta a ficar pendente."
        }
        confirmLabel={statusView?.next === "disabled" ? "Desativar acesso" : "Reativar acesso"}
        icon={statusView?.next === "disabled" ? UserMinus : UserPlus}
        onConfirm={() => changeStatus(statusFor.person, statusFor.next)}
      />
    </div>
  );
}
