import {
  BarChart3,
  Bell,
  CalendarDays,
  CheckCheck,
  ClipboardList,
  FolderKanban,
  FolderOpen,
  History,
  House,
  Landmark,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Library,
  Receipt,
  Settings2,
  Shapes,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";

// Sidebar structure per area. `match` lists extra path prefixes that keep an
// item active; `index` items match only their exact path. `countKey` reads a
// badge from the shell's nav counts. Hidden entries only name topbar crumbs.
export const CLIENT_NAV = [
  {
    label: "Sua marca",
    items: [
      { to: "/painel", label: "Início", icon: House, index: true },
      { to: "/painel/marca", label: "Minha marca", icon: Shapes },
      { to: "/painel/conteudo", label: "Conteúdo", icon: LayoutGrid, countKey: "approvals", countLabel: "aguardando sua aprovação" },
      { to: "/painel/arquivos", label: "Arquivos", icon: FolderOpen },
    ],
  },
  {
    label: "Acompanhamento",
    items: [
      { to: "/painel/projetos", label: "Projetos", icon: FolderKanban },
      { to: "/painel/briefings", label: "Briefings", icon: ClipboardList },
      { to: "/painel/financeiro", label: "Financeiro", icon: Wallet },
      { to: "/painel/historico", label: "Histórico", icon: History },
    ],
  },
];

export const CLIENT_HIDDEN = [
  { to: "/painel/notificacoes", label: "Notificações" },
  { to: "/painel/conta", label: "Conta" },
];

// The 14 modules in the owner's order; items without the capability disappear.
export const ADMIN_NAV = [
  {
    label: "Gestão",
    items: [
      { to: "/admin", label: "Visão geral", icon: LayoutDashboard, index: true },
      { to: "/admin/clientes", label: "Clientes e marcas", icon: Users, cap: "clients.view" },
      { to: "/admin/equipe", label: "Equipe e permissões", icon: UserCog, cap: "team.view" },
    ],
  },
  {
    label: "Comercial",
    items: [
      { to: "/admin/planos", label: "Planos e serviços", icon: Layers, cap: "services.view" },
      { to: "/admin/pedidos", label: "Pedidos e assinaturas", icon: Receipt, cap: "orders.view" },
      { to: "/admin/financeiro", label: "Financeiro", icon: Landmark, cap: "finance.view" },
    ],
  },
  {
    label: "Produção",
    items: [
      { to: "/admin/briefings", label: "Briefings", icon: ClipboardList, cap: "briefings.view" },
      { to: "/admin/projetos", label: "Projetos e tarefas", icon: FolderKanban, cap: "projects.view" },
      {
        to: "/admin/biblioteca",
        label: "Biblioteca de arquivos",
        icon: Library,
        cap: "materials.view",
        match: ["/admin/marcas", "/admin/kits"],
      },
      { to: "/admin/conteudo", label: "Conteúdo e calendário", icon: CalendarDays, cap: "content.view" },
      {
        to: "/admin/aprovacoes",
        label: "Aprovações e ajustes",
        icon: CheckCheck,
        cap: "approvals.view",
        countKey: "approvals",
        countLabel: "com ajustes solicitados",
      },
    ],
  },
  {
    label: "Acompanhamento",
    items: [
      {
        to: "/admin/relatorios",
        label: "Relatórios",
        icon: BarChart3,
        cap: ["reports.view", "reports.finance"],
      },
      { to: "/admin/historico", label: "Histórico", icon: History, cap: "activity.view" },
      { to: "/admin/notificacoes", label: "Notificações", icon: Bell },
      {
        to: "/admin/configuracoes",
        label: "Configurações",
        icon: Settings2,
        cap: ["settings.manage", "categories.manage"],
      },
    ],
  },
];

export const ADMIN_HIDDEN = [
  { to: "/admin/conta", label: "Conta" },
  { to: "/admin/ui", label: "Kit visual" },
];

export function navFor(area, can) {
  const groups = area === "client" ? CLIENT_NAV : ADMIN_NAV;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.cap || can(item.cap)),
    }))
    .filter((group) => group.items.length);
}

const matches = (pathname, prefix) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

// Longest matching prefix wins, so /admin/biblioteca/enviar stays on Biblioteca.
export function activeItem(pathname, groups, hidden = []) {
  let best = null;
  let bestLength = -1;
  const items = [...groups.flatMap((group) => group.items), ...hidden];
  for (const item of items) {
    const prefixes = item.index ? [] : [item.to, ...(item.match || [])];
    if (item.index && pathname === item.to && item.to.length > bestLength) {
      best = item;
      bestLength = item.to.length;
    }
    for (const prefix of prefixes)
      if (matches(pathname, prefix) && prefix.length > bestLength) {
        best = item;
        bestLength = prefix.length;
      }
  }
  return best;
}
