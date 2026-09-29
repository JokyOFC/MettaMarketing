import { useMemo, useState } from "react";
import { Checkbox, ErrorState, SearchInput, SkeletonRows, StatusBadge, useApi } from "../../ui/index.js";
import { cx } from "../clients/crmShared.jsx";
import "../clients/crm.css";

// Checkbox list of clients (for a manager's access). value: client ids.
export default function ClientChecklist({ value = [], onChange, disabled = false, clients: given }) {
  const remote = useApi(given ? null : "/clients");
  const clients = given ?? remote.data?.items ?? [];
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(value), [value]);
  const visible = clients.filter((client) => {
    if (!query) return true;
    const text = `${client.name} ${client.legalName ?? ""} ${(client.brands ?? []).map((b) => b.name).join(" ")}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });

  if (!given && remote.loading) return <SkeletonRows rows={3} columns={2} label="Carregando clientes" />;
  if (!given && remote.error) return <ErrorState error={remote.error} onRetry={remote.reload} compact />;
  if (!clients.length) return <p className="crm-form__note">Nenhum cliente cadastrado ainda.</p>;

  const toggle = (id, on) => onChange(on ? [...value, id] : value.filter((item) => item !== id));
  const allVisible = visible.length > 0 && visible.every((c) => selected.has(c.id));

  return (
    <div className="crm-clientlist">
      <div className="crm-clientlist__tools">
        {clients.length > 6 && (
          <SearchInput value={query} onChange={setQuery} delay={0} size="sm" placeholder="Filtrar clientes" label="Filtrar clientes" />
        )}
        {!disabled && visible.length > 1 && (
          <button
            type="button"
            className="ui-btn ui-btn--link ui-btn--sm"
            onClick={() =>
              onChange(
                allVisible
                  ? value.filter((id) => !visible.some((c) => c.id === id))
                  : [...new Set([...value, ...visible.map((c) => c.id)])],
              )
            }
          >
            <span className="ui-btn__label">
              <span className="ui-btn__text">{query ? (allVisible ? "Desmarcar os listados" : "Marcar os listados") : allVisible ? "Desmarcar todos" : "Marcar todos"}</span>
            </span>
          </button>
        )}
      </div>
      <ul className="crm-clientlist__list">
        {visible.map((client) => (
          <li key={client.id} className={cx("crm-clientlist__row", selected.has(client.id) && "is-on")}>
            <Checkbox
              checked={selected.has(client.id)}
              disabled={disabled}
              onCheckedChange={(on) => toggle(client.id, on)}
              label={client.name}
              description={(client.brands ?? []).filter((b) => b.status === "active").map((b) => b.name).join(", ") || undefined}
            />
            {client.status !== "active" && <StatusBadge kind="client" value={client.status} size="sm" />}
          </li>
        ))}
        {!visible.length && <li className="crm-form__note">Nenhum cliente com “{query}”.</li>}
      </ul>
    </div>
  );
}
