import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, FileStack, Layers, Pencil, Plus, Power } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Menu,
  PageHeader,
  Segmented,
  SkeletonCards,
  StatusBadge,
  Switch,
  plural,
  useApi,
  useReducedMotion,
  useToast,
} from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import { api } from "../../api/client.js";
import { Amount, cx } from "../finance/common.jsx";
import ServiceDrawer from "./ServiceDrawer.jsx";
import "../finance/fin.css";

const KIND_OPTIONS = [
  { value: "all", label: "Todos" },
  { value: "subscription", label: "Assinaturas" },
  { value: "one_off", label: "Avulsos" },
];

// FLIP: cards glide to their new place after a reorder.
function useFlip(containerRef, keys) {
  const positions = useRef(new Map());
  const reduced = useReducedMotion();
  const signature = keys.join("|");
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const nodes = [...container.querySelectorAll("[data-flip]")];
    const next = new Map(nodes.map((node) => [node.dataset.flip, node.getBoundingClientRect()]));
    if (!reduced)
      for (const node of nodes) {
        const before = positions.current.get(node.dataset.flip);
        const after = next.get(node.dataset.flip);
        if (!before || !after) continue;
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (!dx && !dy) continue;
        node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: 260,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        });
      }
    positions.current = next;
  }, [signature, reduced, containerRef]);
}

function usageText(usage) {
  if (!usage) return null;
  const parts = [];
  if (usage.activeSubscriptions) parts.push(plural(usage.activeSubscriptions, "assinatura ativa", "assinaturas ativas"));
  if (usage.orders) parts.push(plural(usage.orders, "pedido", "pedidos"));
  return parts.length ? parts.join(" · ") : "Sem uso ainda";
}

function ServiceCard({ service, index, manage, first, last, busy, onEdit, onToggle, onMove }) {
  const items = service.items ?? [];
  return (
    <Card
      as="article"
      padding="none"
      index={index}
      className={cx("fin-svc", !service.active && "is-inactive")}
      data-flip={service.id}
      aria-label={service.name}
    >
      <div className="fin-svc__head">
        <div className="fin-svc__badges">
          <StatusBadge kind="service" value={service.kind} size="sm" />
          {!service.active && (
            <Badge size="sm" tone="outline">
              Inativo
            </Badge>
          )}
        </div>
        {manage && (
          <Menu
            label={`Ações de ${service.name}`}
            items={[
              { label: "Editar", icon: Pencil, onSelect: () => onEdit(service) },
              { label: service.active ? "Desativar" : "Ativar", icon: Power, onSelect: () => onToggle(service) },
              { divider: true },
              { label: "Mover para antes", icon: ArrowUp, disabled: first, onSelect: () => onMove(service, -1) },
              { label: "Mover para depois", icon: ArrowDown, disabled: last, onSelect: () => onMove(service, 1) },
            ]}
          />
        )}
      </div>

      <div className="fin-svc__body">
        <h2 className="fin-svc__name">{service.name}</h2>
        <Amount cents={service.priceCents} size="lg" per={service.kind === "subscription" ? "mês" : undefined} />
        {service.description && <p className="fin-svc__desc">{service.description}</p>}
      </div>

      <div className="fin-svc__items">
        {items.length ? (
          <ul>
            {items.map((item, i) => (
              <li key={`${item}-${i}`}>
                <Check size={14} strokeWidth={1.6} aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fin-quiet">Nenhum item listado.{manage ? " Edite para descrever o que está incluído." : ""}</p>
        )}
      </div>

      <div className="fin-svc__foot">
        <div className="fin-svc__meta">
          {service.includesEditables && (
            <Badge size="sm" tone="olive" icon={FileStack}>
              Editáveis incluídos
            </Badge>
          )}
          <span className="fin-svc__usage">{usageText(service.usage)}</span>
        </div>
        {manage && (
          <div className="fin-svc__actions">
            <Switch
              label="Ativo"
              checked={service.active}
              disabled={busy}
              onCheckedChange={() => onToggle(service)}
            />
            <Button size="sm" variant="ghost" icon={Pencil} onClick={() => onEdit(service)}>
              Editar
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function Services() {
  usePageTitle("Planos e serviços");
  const { can } = useAuth();
  const manage = can("services.manage");
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi("/services");
  const [kind, setKind] = useState("all");
  const [showInactive, setShowInactive] = useState(true);
  const [editing, setEditing] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const gridRef = useRef(null);

  const all = useMemo(() => data?.items ?? [], [data]);
  const visible = all.filter((s) => (kind === "all" || s.kind === kind) && (showInactive || s.active));
  useFlip(gridRef, visible.map((s) => s.id));

  const counts = {
    subscription: all.filter((s) => s.kind === "subscription" && s.active).length,
    one_off: all.filter((s) => s.kind === "one_off" && s.active).length,
  };

  const replace = (service) =>
    setData((current) => ({ ...current, items: (current?.items ?? []).map((s) => (s.id === service.id ? service : s)) }));

  const toggle = async (service) => {
    setBusyId(service.id);
    replace({ ...service, active: !service.active });
    try {
      const res = await api.patch(`/services/${service.id}`, { active: !service.active });
      replace(res.service);
      toast.success(res.service.active ? `${service.name} ativado` : `${service.name} desativado`);
    } catch (err) {
      replace(service);
      toast.error(err);
    } finally {
      setBusyId(null);
    }
  };

  const move = async (service, delta) => {
    const ids = all.map((s) => s.id);
    // Move within what is on screen, keeping hidden cards where they are.
    const shown = visible.map((s) => s.id);
    const at = shown.indexOf(service.id);
    const target = shown[at + delta];
    if (!target) return;
    const from = ids.indexOf(service.id);
    const to = ids.indexOf(target);
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, service.id);
    const previous = data;
    const byId = new Map(all.map((s) => [s.id, s]));
    setData((current) => ({ ...current, items: next.map((id) => byId.get(id)) }));
    try {
      const res = await api.post("/services/reorder", { ids: next });
      setData((current) => ({ ...current, items: res.items }));
    } catch (err) {
      setData(previous);
      toast.error(err);
    }
  };

  const saved = (service, created) => {
    setEditing(null);
    if (created) setData((current) => ({ ...current, items: [...(current?.items ?? []), service] }));
    else replace(service);
    toast.success(created ? "Serviço criado" : "Alterações salvas");
  };

  return (
    <div className="fin-page">
      <PageHeader
        eyebrow="Comercial"
        title="Planos e"
        accent="serviços"
        description="O catálogo usado em pedidos, assinaturas e projetos. Nada é cobrado a partir daqui: cobranças nascem de um pedido ou de uma assinatura."
        actions={
          manage && (
            <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
              Novo serviço
            </Button>
          )
        }
        meta={
          data && (
            <>
              <span>{plural(counts.subscription, "plano mensal ativo", "planos mensais ativos")}</span>
              <span aria-hidden="true">·</span>
              <span>{plural(counts.one_off, "serviço avulso ativo", "serviços avulsos ativos")}</span>
            </>
          )
        }
      />

      <div className="fin-toolbar">
        <Segmented aria-label="Tipo de serviço" options={KIND_OPTIONS} value={kind} onChange={setKind} />
        <Switch label="Mostrar inativos" className="fin-toolbar__switch" checked={showInactive} onCheckedChange={setShowInactive} />
      </div>

      {loading ? (
        <SkeletonCards count={4} aspect={16 / 7} minWidth={300} lines={3} label="Carregando catálogo" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !all.length ? (
        <EmptyState
          icon={Layers}
          title="Nenhum serviço no catálogo"
          description="Cadastre o primeiro plano mensal ou serviço avulso para usá-lo em pedidos, assinaturas e projetos."
          action={
            manage && (
              <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
                Novo serviço
              </Button>
            )
          }
        />
      ) : !visible.length ? (
        <EmptyState
          compact
          icon={Layers}
          title="Nada neste filtro"
          description="Troque o tipo ou mostre também os serviços inativos."
        />
      ) : (
        <div className="fin-svc-grid" ref={gridRef}>
          {visible.map((service, index) => (
            <ServiceCard
              key={service.id}
              service={service}
              index={index}
              manage={manage}
              first={index === 0}
              last={index === visible.length - 1}
              busy={busyId === service.id}
              onEdit={setEditing}
              onToggle={toggle}
              onMove={move}
            />
          ))}
        </div>
      )}

      {manage && (
        <ServiceDrawer
          open={Boolean(editing)}
          service={editing?.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
