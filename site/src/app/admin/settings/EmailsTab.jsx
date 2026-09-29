import { useState } from "react";
import { Inbox, MailWarning, RotateCcw } from "lucide-react";
import { api } from "../../api/client.js";
import {
  Button,
  DataTable,
  Drawer,
  Pagination,
  Segmented,
  StatusBadge,
  formatDateTime,
  formatRelative,
  useApi,
  useToast,
} from "../../ui/index.js";

const PAGE_SIZE = 30;
const NOT_SENT = "Não enviado — e-mail não configurado";
const FILTERS = [
  { value: "", label: "Todos" },
  { value: "not_configured", label: "Não enviados" },
  { value: "failed", label: "Com falha" },
  { value: "sent", label: "Enviados" },
  { value: "queued", label: "Na fila" },
];

const statusLabel = (status) => (status === "not_configured" ? NOT_SENT : undefined);

export default function EmailsTab({ onOpenIntegrations }) {
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const [retrying, setRetrying] = useState(null);
  const { data, error, loading, refreshing, reload, setData } = useApi("/settings/outbox", {
    params: { status, page, pageSize: PAGE_SIZE },
  });
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const configured = data?.configured;

  const retry = async (email) => {
    setRetrying(email.id);
    try {
      const res = await api.post(`/settings/outbox/${email.id}/retry`);
      setData((d) => ({ ...d, items: d.items.map((item) => (item.id === email.id ? res.email : item)) }));
      if (open?.id === email.id) setOpen(res.email);
      if (res.email.status === "sent") toast.success(`E-mail reenviado para ${res.email.to}.`);
      else toast.error({ title: "O reenvio falhou", message: res.email.error || "O servidor SMTP não aceitou a mensagem." });
    } catch (err) {
      toast.error(err);
    } finally {
      setRetrying(null);
    }
  };

  const canRetry = (email) => configured && (email.status === "failed" || email.status === "not_configured");

  const columns = [
    {
      key: "to",
      header: "Destinatário",
      render: (row) => (
        <span className="hub-cell-title">
          <strong>{row.toUser?.name || row.to}</strong>
          {row.toUser?.name && <span className="ui-meta">{row.to}</span>}
        </span>
      ),
    },
    { key: "subject", header: "Assunto", primary: true, render: (row) => <span className="hub-subject">{row.subject}</span> },
    {
      key: "status",
      header: "Situação",
      render: (row) => <StatusBadge kind="email" value={row.status} label={statusLabel(row.status)} size="sm" />,
    },
    {
      key: "createdAt",
      header: "Data",
      nowrap: true,
      hideOnMobile: true,
      render: (row) => <span className="ui-meta" title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</span>,
    },
    {
      key: "actions",
      header: <span className="ui-sr-only">Ações</span>,
      actions: true,
      align: "end",
      render: (row) =>
        canRetry(row) ? (
          <Button size="sm" variant="ghost" icon={RotateCcw} loading={retrying === row.id} onClick={() => retry(row)}>
            Reenviar
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="hub-stack">
      {data && !configured && (
        <div className="hub-notice" role="note">
          <MailWarning size={16} strokeWidth={1.4} aria-hidden="true" />
          <p>
            O envio de e-mails não está configurado no servidor. As mensagens abaixo foram registradas, mas não enviadas.
            Convites e links de acesso podem ser repassados pela equipe enquanto isso.
          </p>
          <Button size="sm" variant="ghost" onClick={onOpenIntegrations}>
            Como configurar
          </Button>
        </div>
      )}

      <div className="hub-toolbar">
        <Segmented
          aria-label="Filtrar e-mails por situação"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          options={FILTERS.map((filter) => ({
            ...filter,
            label: data ? `${filter.label} (${filter.value ? counts[filter.value] ?? 0 : total})` : filter.label,
          }))}
          className="hub-seg-scroll"
        />
        <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => reload().catch(() => {})} loading={refreshing}>
          Atualizar
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        loading={loading}
        error={error}
        onRetry={reload}
        onRowClick={setOpen}
        rowLabel={(row) => row.subject}
        caption="E-mails enviados pela plataforma"
        empty={{
          icon: Inbox,
          title: status ? "Nenhum e-mail nesta situação" : "Nenhum e-mail registrado ainda",
          description: "Convites, avisos de entrega, aprovações e briefings aparecem aqui assim que a plataforma tenta enviá-los.",
        }}
      />
      {data && <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />}

      <Drawer
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        size="sm"
        eyebrow="E-mail"
        title={open?.subject}
        footer={
          open && canRetry(open) ? (
            <Button variant="primary" icon={RotateCcw} loading={retrying === open.id} onClick={() => retry(open)}>
              Reenviar agora
            </Button>
          ) : null
        }
      >
        {open && (
          <div className="hub-stack">
            <dl className="hub-facts">
              <div>
                <dt>Para</dt>
                <dd>
                  {open.toUser?.name ? `${open.toUser.name} · ` : ""}
                  {open.to}
                </dd>
              </div>
              <div>
                <dt>Situação</dt>
                <dd>
                  <StatusBadge kind="email" value={open.status} label={statusLabel(open.status)} size="sm" />
                </dd>
              </div>
              <div>
                <dt>Registrado</dt>
                <dd>{formatDateTime(open.createdAt)}</dd>
              </div>
              {open.sentAt && (
                <div>
                  <dt>Enviado</dt>
                  <dd>{formatDateTime(open.sentAt)}</dd>
                </div>
              )}
              <div>
                <dt>Tentativas</dt>
                <dd>{open.attempts}</dd>
              </div>
            </dl>
            {open.error && (
              <p className="ui-inline-error" role="note">
                <MailWarning size={16} strokeWidth={1.4} aria-hidden="true" />
                <span>{open.error}</span>
              </p>
            )}
            {open.excerpt && (
              <div>
                <p className="ui-eyebrow">Conteúdo</p>
                <p className="hub-excerpt">{open.excerpt}</p>
                <p className="ui-meta">Links de convite, de redefinição de senha e de download ficam ocultos por segurança.</p>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
