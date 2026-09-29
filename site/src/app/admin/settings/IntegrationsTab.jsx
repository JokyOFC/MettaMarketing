import { useState } from "react";
import { Clapperboard, CreditCard, Globe, HardDrive, Mail, RefreshCw, Send } from "lucide-react";
import { api } from "../../api/client.js";
import {
  Badge,
  Button,
  CopyButton,
  ErrorState,
  Skeleton,
  formatBytes,
  formatNumber,
  plural,
  useApi,
  useToast,
} from "../../ui/index.js";

const Env = ({ children }) => <code className="hub-env">{children}</code>;

function IntegrationCard({ icon: CardIcon, title, status, children, guidance, actions, index }) {
  return (
    <article className="hub-int ui-enter" style={{ "--i": index }} aria-labelledby={`hub-int-${index}`}>
      <header className="hub-int__head">
        <span className="hub-int__icon" aria-hidden="true">
          <CardIcon size={19} strokeWidth={1.4} />
        </span>
        <h3 id={`hub-int-${index}`} className="hub-int__title">
          {title}
        </h3>
        {status}
      </header>
      {children && <dl className="hub-facts hub-facts--compact">{children}</dl>}
      {guidance && <div className="hub-int__guide">{guidance}</div>}
      {actions && <div className="hub-int__actions">{actions}</div>}
    </article>
  );
}

const Fact = ({ label, children }) => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

// Honest status of what the server has configured; the fix is always an
// environment variable plus a restart, so the guidance names them.
export default function IntegrationsTab({ onOpenEmails }) {
  const toast = useToast();
  const { data, error, loading, refreshing, reload } = useApi("/settings/integrations");
  const [testing, setTesting] = useState(false);

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await api.post("/settings/email/test");
      if (res.status === "sent") toast.success({ title: "E-mail de teste enviado", message: "Confira sua caixa de entrada." });
      else toast.error({ title: "O servidor SMTP recusou o envio", message: res.error || "Revise as credenciais de e-mail." });
      reload().catch(() => {});
    } catch (err) {
      toast.error(err);
    } finally {
      setTesting(false);
    }
  };

  if (loading)
    return (
      <div className="hub-int-grid" aria-busy="true">
        <span className="ui-sr-only" role="status">
          Carregando integrações
        </span>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={220} radius={4} />
        ))}
      </div>
    );
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;

  const { email, mercadopago, storage, ffmpeg, outbox, appUrl } = data;
  const pending = outbox.notConfigured + outbox.failed;

  return (
    <div className="hub-stack">
      <div className="hub-toolbar">
        <p className="ui-meta">
          Credenciais ficam só no servidor e nunca aparecem aqui. Depois de mudar uma variável de ambiente, reinicie o servidor.
        </p>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => reload().catch(() => {})} loading={refreshing}>
          Atualizar
        </Button>
      </div>

      <div className="hub-int-grid">
        <IntegrationCard
          index={0}
          icon={Mail}
          title="E-mail"
          status={email.configured ? <Badge tone="olive" dot>Configurado</Badge> : <Badge tone="amber" dot>Não configurado</Badge>}
          guidance={
            email.configured ? (
              <p>Avisos, convites e redefinições de senha saem pelo servidor SMTP configurado. Use o teste para confirmar a entrega.</p>
            ) : (
              <>
                <p>
                  Defina <Env>SMTP_URL</Env> (ou <Env>SMTP_HOST</Env>, <Env>SMTP_PORT</Env>, <Env>SMTP_USER</Env>,{" "}
                  <Env>SMTP_PASS</Env> e <Env>SMTP_SECURE</Env>) e <Env>MAIL_FROM</Env> no ambiente do servidor.
                </p>
                <p>
                  Enquanto isso, nenhum e-mail é enviado: as mensagens ficam registradas como “Não enviado — e-mail não
                  configurado” e os links de convite podem ser repassados pela equipe.
                </p>
              </>
            )
          }
          actions={
            <>
              {email.configured && (
                <Button size="sm" icon={Send} onClick={sendTest} loading={testing}>
                  Enviar e-mail de teste
                </Button>
              )}
              {pending > 0 && (
                <Button size="sm" variant="ghost" onClick={onOpenEmails}>
                  Ver e-mails pendentes
                </Button>
              )}
            </>
          }
        >
          <Fact label="Remetente">{email.from || "—"}</Fact>
          {email.configured && <Fact label="Servidor">{email.host || (email.via === "url" ? "Definido por SMTP_URL" : "Transporte personalizado")}</Fact>}
          <Fact label="Pendências">
            {pending
              ? [
                  outbox.notConfigured && plural(outbox.notConfigured, "não enviado", "não enviados"),
                  outbox.failed && plural(outbox.failed, "com falha", "com falha"),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Nenhuma"}
          </Fact>
        </IntegrationCard>

        <IntegrationCard
          index={1}
          icon={CreditCard}
          title="Mercado Pago"
          status={
            !mercadopago.configured ? (
              <Badge dot>Não configurado</Badge>
            ) : mercadopago.mode === "test" ? (
              <Badge tone="amber" dot>
                Modo de teste
              </Badge>
            ) : (
              <Badge tone="olive" dot>
                Produção
              </Badge>
            )
          }
          guidance={
            <>
              <p>
                {mercadopago.configured
                  ? mercadopago.mode === "test"
                    ? "As cobranças usam credenciais de teste: nenhum pagamento real é processado."
                    : "Cobranças e assinaturas usam as credenciais de produção."
                  : "Sem credenciais, a plataforma não gera cobranças e o financeiro mostra que a integração não está configurada."}
              </p>
              <p>
                Credenciais: <Env>MP_ACCESS_TOKEN</Env> (as de teste começam com <Env>TEST-</Env>) e{" "}
                <Env>MP_WEBHOOK_SECRET</Env>. No painel do Mercado Pago, cadastre a URL de notificações abaixo.
              </p>
            </>
          }
        >
          <Fact label="Assinatura do webhook">{mercadopago.webhookSecret ? "Configurada" : "Não configurada"}</Fact>
          <Fact label="URL de notificações">
            <span className="hub-copyline">
              <span className="hub-copyline__text">{mercadopago.webhookUrl}</span>
              <CopyButton text={mercadopago.webhookUrl} iconOnly label="Copiar URL de notificações" />
            </span>
          </Fact>
        </IntegrationCard>

        <IntegrationCard
          index={2}
          icon={HardDrive}
          title="Armazenamento"
          status={<Badge tone="olive" dot>Privado</Badge>}
          guidance={
            <p>
              Os arquivos ficam em <Env>DATA_DIR/storage</Env>, fora da pasta pública, e só são entregues depois de checar a
              permissão de quem pede. Inclua <Env>DATA_DIR</Env> (banco de dados e arquivos) no backup do servidor.
            </p>
          }
        >
          <Fact label="Espaço usado">{storage.usedBytes === null ? "Não foi possível medir" : formatBytes(storage.usedBytes)}</Fact>
          <Fact label="Arquivos guardados">
            {storage.files === null ? "—" : `${formatNumber(storage.files)} (inclui prévias e ZIPs temporários)`}
          </Fact>
        </IntegrationCard>

        <IntegrationCard
          index={3}
          icon={Clapperboard}
          title="Prévias de vídeo"
          status={ffmpeg.available ? <Badge tone="olive" dot>ffmpeg disponível</Badge> : <Badge tone="amber" dot>ffmpeg ausente</Badge>}
          guidance={
            ffmpeg.available ? (
              <p>Capas e dados dos vídeos (duração e dimensões) são gerados automaticamente no envio.</p>
            ) : (
              <p>
                Instale o ffmpeg no servidor ou defina <Env>FFMPEG_PATH</Env> e <Env>FFPROBE_PATH</Env>. Sem ele, vídeos são
                enviados e baixados normalmente, mas não ganham capa automática: a equipe pode enviar uma capa.
              </p>
            )
          }
        >
          <Fact label="Leitura de vídeos (ffprobe)">{ffmpeg.ffprobe ? "Disponível" : "Indisponível"}</Fact>
        </IntegrationCard>

        <IntegrationCard
          index={4}
          icon={Globe}
          title="Endereço da plataforma"
          status={/^https:\/\//.test(appUrl) ? <Badge tone="olive" dot>HTTPS</Badge> : <Badge tone="amber" dot>Sem HTTPS</Badge>}
          guidance={
            <p>
              Usado nos links dos e-mails e no retorno dos pagamentos. Defina <Env>APP_URL</Env> com o endereço público,
              começando com https://.
            </p>
          }
        >
          <Fact label="APP_URL">
            <span className="hub-copyline">
              <span className="hub-copyline__text">{appUrl}</span>
              <CopyButton text={appUrl} iconOnly label="Copiar endereço" />
            </span>
          </Fact>
        </IntegrationCard>
      </div>
    </div>
  );
}
