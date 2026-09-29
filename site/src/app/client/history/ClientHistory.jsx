import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, History } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Segmented,
  SkeletonRows,
  formatDateTime,
  formatNumber,
  formatTime,
  useApi,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useBrand, usePageTitle } from "../../shell/index.js";
import { useAuth } from "../../auth/index.js";
import { ActionIcon, actorName, personalSummary } from "../../admin/activity/feed.jsx";
import { groupByDay } from "../../admin/overview/lib.js";
import "../../admin/overview/ov.css";

const cx = (...parts) => parts.filter(Boolean).join(" ");
const PAGE_SIZE = 30;

// Entity types behind each filter (the timeline itself shows everything the
// server marked as visible to the client).
const TYPES = [
  { value: "all", label: "Tudo" },
  { value: "deliveries", label: "Entregas", entityTypes: ["material", "version", "release", "kit", "file", "identity", "color", "font", "post"] },
  { value: "approvals", label: "Aprovações", entityTypes: ["approval", "comment", "review"] },
  { value: "briefings", label: "Briefings", entityTypes: ["briefing"] },
  { value: "payments", label: "Pagamentos", entityTypes: ["order", "payment", "subscription"] },
];

const EMPTY = {
  all: "Quando a Metta liberar materiais, você aprovar uma versão ou responder um briefing, tudo fica registrado aqui.",
  deliveries: "Materiais e novas versões liberados para você aparecem aqui.",
  approvals: "Suas aprovações e pedidos de ajuste aparecem aqui, com a versão de cada decisão.",
  briefings: "Briefings enviados e respondidos aparecem aqui.",
  payments: "Pagamentos confirmados e cobranças aparecem aqui.",
};

export default function ClientHistory() {
  usePageTitle("Histórico");
  const toast = useToast();
  const { user } = useAuth();
  const { brand, brandId, brands } = useBrand();
  const [type, setType] = useState("all");
  const entityTypes = TYPES.find((t) => t.value === type)?.entityTypes;
  const params = useMemo(
    () => ({ brandId: brands.length > 1 ? brandId : undefined, entityType: entityTypes?.join(","), pageSize: PAGE_SIZE }),
    [brands.length, brandId, entityTypes],
  );
  const key = JSON.stringify(params);
  const { data, error, loading, refreshing, reload } = useApi("/portal/activity", { params });

  const [extra, setExtra] = useState({ key, items: [], page: 1 });
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setExtra({ key, items: [], page: 1 }), [key]);
  const more = extra.key === key ? extra : { items: [], page: 1 };

  const items = useMemo(() => {
    const seen = new Set();
    return [...(data?.items ?? []), ...more.items].filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
  }, [data, more.items]);
  const groups = useMemo(() => groupByDay(items), [items]);
  const total = data?.total ?? 0;

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = more.page + 1;
      const page = await api.get("/portal/activity", { params: { ...params, page: next } });
      setExtra((current) => (current.key === key ? { key, items: [...current.items, ...page.items], page: next } : current));
    } catch (err) {
      toast.error(err);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="ov-page">
      <PageHeader
        eyebrow={brand ? `Marca ${brand.name}` : "Sua conta"}
        title="Histórico"
        accent="da marca"
        description="Materiais liberados, novas versões, aprovações, pedidos de ajuste, briefings e pagamentos, na ordem em que aconteceram."
      />

      <div className="ov-toolbar">
        <Segmented options={TYPES} value={type} onChange={setType} aria-label="Tipo de registro" size="sm" />
        {data && total > 0 && (
          <p className="ov-toolbar__count" aria-live="polite">
            {formatNumber(total)} {total === 1 ? "registro" : "registros"}
          </p>
        )}
      </div>

      {loading && <SkeletonRows rows={6} columns={2} media label="Carregando histórico" />}
      {error && !data && <ErrorState error={error} onRetry={() => reload().catch(() => {})} />}
      {data && !items.length && <EmptyState icon={History} title="Ainda não há registros aqui." description={EMPTY[type]} />}

      {items.length > 0 && (
        <div className={cx("ov-timeline", refreshing && "is-refreshing")}>
          {groups.map((group) => (
            <section key={group.key} className="ov-day" aria-labelledby={`ov-day-${group.key}`}>
              <h2 className="ov-day__title" id={`ov-day-${group.key}`}>
                {group.heading.title}
                <span className="ov-day__detail">{group.heading.detail}</span>
              </h2>
              <ol className="ov-tl">
                {group.items.map((item, index) => (
                  <li key={item.id} className="ov-tl__item ui-enter" style={{ "--i": Math.min(index, 8) }}>
                    <ActionIcon item={item} />
                    <div className="ov-tl__body">
                      <p className="ov-tl__text">{personalSummary(item, user?.id)}</p>
                      <p className="ov-tl__meta">
                        <time dateTime={item.createdAt} title={formatDateTime(item.createdAt)}>
                          {formatTime(item.createdAt)}
                        </time>
                        <span>{actorName(item)}</span>
                        {brands.length > 1 && item.brand?.name && <span>{item.brand.name}</span>}
                      </p>
                      {item.link && (
                        <Link to={item.link} className="ov-chip">
                          <span className="ui-truncate">{item.material?.title ?? item.linkLabel}</span>
                          <ArrowUpRight size={14} strokeWidth={1.4} aria-hidden="true" />
                          {item.material?.title && <span className="ui-sr-only">({item.linkLabel})</span>}
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {items.length < total && (
            <div className="ov-loadmore">
              <p className="ov-loadmore__count">
                Mostrando {formatNumber(items.length)} de {formatNumber(total)}
              </p>
              <Button onClick={loadMore} loading={loadingMore}>
                Carregar mais
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
