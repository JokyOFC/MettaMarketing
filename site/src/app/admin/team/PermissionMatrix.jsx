import { useState } from "react";
import { Check, Minus } from "lucide-react";
import { ErrorState, Field, Select, SkeletonRows, useApi, useIsNarrow } from "../../ui/index.js";
import { cx } from "../clients/crmShared.jsx";
import "../clients/crm.css";

export const ROLE_ORDER = ["admin", "manager", "designer", "finance", "client"];

// What each role reaches (data scope), in the owner's words.
export const ROLE_SCOPES = {
  admin: { title: "Administrador", text: "Controle completo: todos os clientes, a equipe, o comercial e as configurações." },
  manager: {
    title: "Gestor",
    text: "Gerencia somente os clientes liberados para ele: marcas, projetos, arquivos, liberação ao cliente e aprovações. Não cria clientes, não gerencia a equipe e não vê o financeiro.",
  },
  designer: {
    title: "Designer/editor",
    text: "Produz e envia materiais dos projetos em que está. Consulta as marcas desses projetos, mas não libera nada ao cliente.",
  },
  finance: {
    title: "Financeiro",
    text: "Planos, pedidos, assinaturas e pagamentos de todos os clientes. Sem acesso a arquivos, projetos ou conteúdo.",
  },
  client: {
    title: "Cliente",
    text: "Acessa somente as próprias marcas e os materiais liberados: vê, comenta, aprova e baixa.",
  },
};

export const CAPABILITY_GROUPS = [
  {
    title: "Clientes e marcas",
    items: [
      ["clients.view", "Ver clientes", "Gestor: só os liberados · designer: dados básicos dos clientes dos seus projetos"],
      ["clients.create", "Cadastrar clientes"],
      ["clients.edit", "Alterar nome, razão social, CNPJ e status do cliente"],
      ["brands.edit", "Criar marcas, editar contatos e convidar pessoas do cliente"],
    ],
  },
  {
    title: "Equipe",
    items: [
      ["team.view", "Ver a equipe e os papéis"],
      ["team.manage", "Convidar pessoas, mudar papéis e liberar clientes a gestores"],
    ],
  },
  {
    title: "Comercial",
    items: [
      ["services.view", "Ver planos e serviços"],
      ["services.manage", "Editar planos e serviços"],
      ["orders.view", "Ver pedidos e assinaturas"],
      ["orders.manage", "Criar e cancelar cobranças"],
      ["finance.view", "Ver o financeiro e o Mercado Pago"],
      ["reports.finance", "Relatórios financeiros"],
    ],
  },
  {
    title: "Projetos",
    items: [
      ["projects.view", "Ver projetos", "Designer: somente os projetos em que está"],
      ["projects.manage", "Abrir projetos e atribuir a equipe"],
      ["tasks.manage", "Criar, atribuir e mover tarefas"],
    ],
  },
  {
    title: "Arquivos e entregas",
    items: [
      ["materials.view", "Ver a biblioteca de arquivos"],
      ["materials.upload", "Enviar arquivos e novas versões"],
      ["materials.edit", "Editar título, categoria e dados dos materiais"],
      ["materials.release", "Liberar materiais ao cliente"],
      ["materials.archive", "Arquivar materiais"],
    ],
  },
  {
    title: "Conteúdo e aprovações",
    items: [
      ["content.view", "Ver a central de conteúdo"],
      ["content.manage", "Criar e editar publicações"],
      ["content.publication", "Marcar publicações como agendadas ou publicadas"],
      ["approvals.view", "Acompanhar aprovações e ajustes solicitados"],
      ["comments.internal", "Ler e escrever notas internas da equipe"],
    ],
  },
  {
    title: "Briefings",
    items: [
      ["briefings.view", "Ver briefings"],
      ["briefings.manage", "Criar, enviar e revisar briefings"],
    ],
  },
  {
    title: "Relatórios e configurações",
    items: [
      ["reports.view", "Relatórios de entregas, aprovações e downloads"],
      ["activity.view", "Histórico de atividades", "Designer: somente o que envolve seus projetos"],
      ["categories.manage", "Criar e organizar categorias"],
      ["settings.manage", "Configurações e integrações"],
    ],
  },
  {
    title: "Área do cliente",
    items: [["portal.access", "Entrar na área do cliente (marca exclusiva do papel Cliente)"]],
  },
];

function Mark({ on, role, label }) {
  return (
    <span className={cx("crm-matrix__mark", on && "is-on")} role="img" aria-label={`${ROLE_SCOPES[role].title}: ${on ? "sim" : "não"} — ${label}`}>
      {on ? <Check size={15} strokeWidth={1.8} aria-hidden="true" /> : <Minus size={14} strokeWidth={1.4} aria-hidden="true" />}
    </span>
  );
}

// Read-only role x capability matrix built from the server's own map
// (/api/team/roles), so what is shown is what the API enforces.
export default function PermissionMatrix() {
  const { data, error, loading, reload } = useApi("/team/roles");
  const narrow = useIsNarrow();
  const [role, setRole] = useState("manager");
  if (loading) return <SkeletonRows rows={8} columns={5} label="Carregando permissões" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const caps = new Map((data?.items ?? []).map((item) => [item.role, new Set(item.capabilities)]));
  const roles = ROLE_ORDER.filter((r) => caps.has(r));

  return (
    <div className="crm-perms">
      <div className="crm-rolecards">
        {roles.map((r, index) => (
          <article key={r} className="crm-rolecard-info ui-enter" style={{ "--i": index }}>
            <p className="crm-rolecard-info__index">{String(index + 1).padStart(2, "0")}</p>
            <h3 className="crm-rolecard-info__title">{ROLE_SCOPES[r].title}</h3>
            <p className="crm-rolecard-info__text">{ROLE_SCOPES[r].text}</p>
          </article>
        ))}
      </div>

      <p className="crm-perms__note">
        Menor acesso necessário: cada papel recebe só o que precisa. Além das permissões, o servidor confere o escopo de cada
        registro — um gestor sem acesso a um cliente, ou outro cliente, recebe “não encontrado”.
      </p>

      {narrow ? (
        <div className="crm-perms__mobile">
          <Field label="Ver permissões do papel">
            <Select options={roles.map((r) => ({ value: r, label: ROLE_SCOPES[r].title }))} value={role} onValueChange={setRole} />
          </Field>
          {CAPABILITY_GROUPS.map((group) => (
            <section key={group.title} className="crm-perms__group">
              <h4 className="crm-perms__grouptitle">{group.title}</h4>
              <ul>
                {group.items.map(([cap, label, note]) => {
                  const on = caps.get(role)?.has(cap);
                  return (
                    <li key={cap} className={cx("crm-perms__item", on && "is-on")}>
                      <Mark on={on} role={role} label={label} />
                      <span>
                        {label}
                        {note && on && <small>{note}</small>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="crm-matrix-wrap">
          <table className="crm-matrix">
            <caption className="ui-sr-only">Permissões por papel</caption>
            <thead>
              <tr>
                <th scope="col">Permissão</th>
                {roles.map((r) => (
                  <th key={r} scope="col">
                    {ROLE_SCOPES[r].title}
                  </th>
                ))}
              </tr>
            </thead>
            {CAPABILITY_GROUPS.map((group) => (
              <tbody key={group.title}>
                <tr className="crm-matrix__group">
                  <th scope="rowgroup" colSpan={roles.length + 1}>
                    {group.title}
                  </th>
                </tr>
                {group.items.map(([cap, label, note]) => (
                  <tr key={cap}>
                    <th scope="row">
                      {label}
                      {note && <small>{note}</small>}
                    </th>
                    {roles.map((r) => (
                      <td key={r}>
                        <Mark on={caps.get(r)?.has(cap)} role={r} label={label} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}
