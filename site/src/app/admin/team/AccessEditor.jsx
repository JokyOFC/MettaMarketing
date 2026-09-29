import { useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../../api/client.js";
import { Avatar, Button, EmptyState, Field, Select, StatusBadge, useIsNarrow, useToast } from "../../ui/index.js";
import { cx } from "../clients/crmShared.jsx";
import ClientChecklist from "./ClientChecklist.jsx";
import "../clients/crm.css";

const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

// Client access per manager: pick a manager, tick the clients they manage.
export default function AccessEditor({ people, canManage, onSaved, managerId: requested, onManagerChange }) {
  const toast = useToast();
  const narrow = useIsNarrow();
  const managers = useMemo(() => people.filter((person) => person.role === "manager"), [people]);
  const [localId, setLocalId] = useState(null);
  const managerId = managers.some((m) => m.id === requested) ? requested : managers.some((m) => m.id === localId) ? localId : managers[0]?.id;
  const manager = managers.find((m) => m.id === managerId);
  const original = useMemo(() => manager?.access.clients.map((c) => c.id) ?? [], [manager]);
  const [draft, setDraft] = useState(original);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(original), [original]);
  const dirty = !sameSet(draft, original);

  const choose = (id) => {
    setLocalId(id);
    onManagerChange?.(id);
  };

  if (!managers.length)
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Nenhum gestor na equipe"
        description="Gestores recebem acesso por cliente. Convide um gestor para distribuir o atendimento; administradores já veem todos os clientes."
      />
    );

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put(`/team/users/${manager.id}/clients`, { clientIds: draft });
      toast.success(
        `Acesso de ${manager.name} atualizado${res.added.length ? `: ${res.added.length} ${res.added.length === 1 ? "cliente adicionado" : "clientes adicionados"}` : ""}${res.removed.length ? `${res.added.length ? "," : ":"} ${res.removed.length} ${res.removed.length === 1 ? "removido" : "removidos"}` : ""}.`,
      );
      onSaved?.();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="crm-accessgrid">
      {narrow ? (
        <Field label="Gestor">
          <Select value={managerId} onValueChange={choose} options={managers.map((m) => ({ value: m.id, label: `${m.name} · ${m.access.clients.length}` }))} />
        </Field>
      ) : (
        <ul className="crm-accessgrid__people" aria-label="Gestores">
          {managers.map((person) => (
            <li key={person.id}>
              <button
                type="button"
                className={cx("crm-accessperson", person.id === managerId && "is-on")}
                aria-current={person.id === managerId ? "true" : undefined}
                onClick={() => choose(person.id)}
              >
                <Avatar name={person.name} size={32} decorative />
                <span className="crm-accessperson__text">
                  <span className="crm-accessperson__name">{person.name}</span>
                  <span className="crm-accessperson__meta">
                    {person.access.clients.length} {person.access.clients.length === 1 ? "cliente" : "clientes"}
                    {person.status !== "active" && ` · ${person.status === "invited" ? "convite pendente" : "desativado"}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {manager && (
        <section className="crm-accessgrid__panel ui-panel ui-card--pad-md" aria-label={`Clientes de ${manager.name}`}>
          <header className="crm-accessgrid__head">
            <div>
              <p className="ui-eyebrow">Acesso por cliente</p>
              <h3 className="crm-accessgrid__title">{manager.name}</h3>
            </div>
            {manager.status !== "active" && <StatusBadge kind="user" value={manager.status} size="sm" />}
          </header>
          {canManage ? (
            <>
              <ClientChecklist value={draft} onChange={setDraft} disabled={manager.status === "disabled"} />
              <footer className="crm-accessgrid__foot">
                <span className="ui-meta">
                  {draft.length} {draft.length === 1 ? "cliente selecionado" : "clientes selecionados"}
                  {dirty && " · alterações não salvas"}
                </span>
                <div className="ui-cluster">
                  <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setDraft(original)}>
                    Descartar
                  </Button>
                  <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={save}>
                    Salvar acesso
                  </Button>
                </div>
              </footer>
            </>
          ) : manager.access.clients.length ? (
            <ul className="crm-chips crm-chips--wrap">
              {manager.access.clients.map((client) => (
                <li key={client.id} className="crm-chip">
                  {client.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="ui-muted">Sem clientes liberados.</p>
          )}
        </section>
      )}
    </div>
  );
}
