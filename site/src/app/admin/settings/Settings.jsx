import { useSearchParams } from "react-router-dom";
import { Building2, FileSignature, Mail, Plug, Shapes } from "lucide-react";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import { PageHeader, Tabs } from "../../ui/index.js";
import CategoriesTab from "./CategoriesTab.jsx";
import ContractsTab from "./ContractsTab.jsx";
import EmailsTab from "./EmailsTab.jsx";
import IntegrationsTab from "./IntegrationsTab.jsx";
import OrganizationTab from "./OrganizationTab.jsx";
import "../briefings/hub.css";

const TABS = [
  { value: "categorias", label: "Categorias", icon: Shapes, cap: "categories.manage" },
  { value: "integracoes", label: "Integrações", icon: Plug, cap: "settings.manage" },
  { value: "contratos", label: "Contratos", icon: FileSignature, cap: "settings.manage" },
  { value: "organizacao", label: "Organização", icon: Building2, cap: "settings.manage" },
  { value: "emails", label: "E-mails", icon: Mail, cap: "settings.manage" },
];

export default function Settings() {
  usePageTitle("Configurações");
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((tab) => can(tab.cap));
  const requested = params.get("aba");
  const active = tabs.find((tab) => tab.value === requested)?.value ?? tabs[0]?.value;

  const go = (value) => {
    const next = new URLSearchParams(params);
    next.set("aba", value);
    next.delete("status");
    setParams(next, { replace: true });
  };

  const content = {
    categorias: <CategoriesTab />,
    integracoes: <IntegrationsTab onOpenEmails={() => go("emails")} />,
    contratos: <ContractsTab />,
    organizacao: <OrganizationTab />,
    emails: <EmailsTab onOpenIntegrations={() => go("integracoes")} />,
  }[active];

  return (
    <div className="hub-page">
      <PageHeader
        eyebrow="Plataforma"
        title="Configurações"
        description="Categorias dos materiais, integrações do servidor, dados da organização e o registro de e-mails enviados."
      />
      <Tabs items={tabs} value={active} onChange={go} aria-label="Seções das configurações" className="hub-tabs hub-settings-tabs">
        <div key={active} className="ui-page-enter">
          {content}
        </div>
      </Tabs>
    </div>
  );
}
