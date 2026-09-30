# Frontend do produto — contratos compartilhados

Complementa `docs/PLATFORM.md` e `docs/API.md`. Todo texto de interface em pt-BR.

## Rotas e donos

`src/app/routes.jsx` (Fundação) declara todas as rotas e importa cada página de
`src/app/pages.js`, que carrega cada componente sob demanda (`React.lazy`, um chunk por
página, com skeleton dentro do shell enquanto carrega). A Fundação cria cada
arquivo de página como stub (`export default function X() { return <PagePlaceholder … /> }`);
a fatia dona substitui o conteúdo **mantendo o caminho e o export default**.
`src/App.jsx` envia os caminhos do produto (`/login`, `/convite`, `/painel`, `/admin`…) para
`src/app/ProductApp.jsx`, também carregado sob demanda: o site institucional não baixa o
produto.

### Área do cliente (`/painel`, papel `client`)

| Rota | Arquivo (export default) | Fatia |
| ---- | ------------------------ | ----- |
| `/painel` | `client/overview/ClientOverview.jsx` | I |
| `/painel/marca` | `client/brand/BrandLibrary.jsx` | C |
| `/painel/arquivos` | `client/files/ClientFiles.jsx` | C |
| `/painel/conteudo` | `client/content/ContentHub.jsx` | D |
| `/painel/conteudo/:id` | `client/content/ContentDetail.jsx` | D |
| `/painel/projetos` | `client/projects/ClientProjects.jsx` | E |
| `/painel/briefings` | `client/briefings/ClientBriefings.jsx` | H |
| `/painel/briefings/:id` | `client/briefings/BriefingForm.jsx` | H |
| `/painel/financeiro` | `client/billing/ClientBilling.jsx` | G |
| `/painel/contratar/:slug` | `client/purchase/Purchase.jsx` (compra pelo site; sem sessão, `RequireAuth` leva a `/cadastro?next=…`) | G |
| `/painel/notificacoes` | `client/notifications/ClientNotifications.jsx` | H |
| `/painel/historico` | `client/history/ClientHistory.jsx` | I |
| `/painel/conta` | `client/account/Account.jsx` | H |

### Painel da Metta (`/admin`, papéis de equipe)

| Rota | Arquivo | Fatia | Capacidade |
| ---- | ------- | ----- | ---------- |
| `/admin` | `admin/overview/AdminOverview.jsx` | I | — |
| `/admin/clientes` | `admin/clients/ClientsList.jsx` | E | clients.view |
| `/admin/clientes/:id` | `admin/clients/ClientDetail.jsx` | E | clients.view |
| `/admin/equipe` | `admin/team/Team.jsx` | E | team.view |
| `/admin/planos` | `admin/services/Services.jsx` | G | services.view |
| `/admin/pedidos` | `admin/orders/Orders.jsx` | G | orders.view |
| `/admin/financeiro` | `admin/finance/Finance.jsx` | G | finance.view |
| `/admin/briefings` | `admin/briefings/Briefings.jsx` | H | briefings.view |
| `/admin/briefings/:id` | `admin/briefings/BriefingEditor.jsx` | H | briefings.view |
| `/admin/projetos` | `admin/projects/Projects.jsx` | E | projects.view |
| `/admin/projetos/:id` | `admin/projects/ProjectDetail.jsx` | E | projects.view |
| `/admin/biblioteca` | `admin/library/Library.jsx` | B | materials.view |
| `/admin/biblioteca/enviar` | `admin/library/UploadFlow.jsx` | B | materials.upload |
| `/admin/biblioteca/:id` | `admin/library/MaterialAdmin.jsx` | B | materials.view |
| `/admin/marcas/:id` | `admin/library/BrandIdentity.jsx` | B | materials.view |
| `/admin/kits` | `admin/library/Kits.jsx` | B | materials.view |
| `/admin/conteudo` | `admin/content/AdminContent.jsx` | D | content.view |
| `/admin/conteudo/novo` | `admin/content/PostEditor.jsx` | D | content.manage |
| `/admin/conteudo/:id` | `admin/content/AdminPostDetail.jsx` | D | content.view |
| `/admin/aprovacoes` | `admin/approvals/Approvals.jsx` | D | approvals.view |
| `/admin/relatorios` | `admin/reports/Reports.jsx` | I | reports.view ou reports.finance |
| `/admin/notificacoes` | `admin/notifications/AdminNotifications.jsx` | H | — |
| `/admin/configuracoes` | `admin/settings/Settings.jsx` | H | settings.manage ou categories.manage |
| `/admin/historico` | `admin/activity/ActivityLog.jsx` | I | activity.view |
| `/admin/conta` | `client/account/Account.jsx` (reuso) | H | — |

Navegação lateral do admin segue a ordem dos 14 módulos: Visão geral, Clientes e marcas,
Equipe e permissões, Planos e serviços, Pedidos e assinaturas, Financeiro, Briefings,
Projetos e tarefas, Biblioteca de arquivos, Conteúdo e calendário, Aprovações e ajustes,
Relatórios, Notificações, Configurações (+ Histórico dentro de Relatórios/Configurações).
Itens sem capacidade não aparecem.

## Fundação — o que as fatias podem importar

### `src/app/api/client.js`
```js
export class ApiError extends Error { status; code; fields }   // message já em pt-BR
export const api = { get(path, {params, signal}), post(path, body), patch, put, del }
// JSON; envia X-Metta-Request: 1; 401 dispara evento 'metta:unauthenticated'
export function qs(params)                                        // monta query string ignorando vazios
```
`api` também aceita `/api/materials`; `api.delete` = `api.del`. `ApiError` tem `status`,
`code` (use para decidir, nunca a mensagem), `fields`, `data` e `isNetwork`.
Códigos extras além da tabela da API: `network`, `download_disabled`, `font_license`.
### `src/app/api/upload.js`
```js
uploadFile(file, { onProgress(loaded, total), signal }) → Promise<Upload>   // XHR real para /api/uploads; recusa antes de enviar acima do limite
getUploadLimits() / useUploadLimits() → { maxUploadBytes, maxUploadMb, maxUploadLabel } | null   // GET /api/uploads/limits
```
### `src/app/api/downloads.js` + `DownloadCenter`
```js
useDownloads() → {
  downloadFile(fileId, {name}) ,        // pede /api/downloads/link e dispara o download; toast em erro claro
  downloadFiles(fileIds, {label, name}),// 1 arquivo: download direto; vários: ZIP {type:'selection'}
  startZip(scope, {label}),            // POST /api/zips, acompanha progresso na bandeja
  isDownloading(fileId), retryJob(id), dismissJob(id),
  jobs                                  // lista para a bandeja
}
<DownloadCenterProvider> (em downloads.js, montado pelo AppShell) exibe a bandeja fixa com
progresso real, "Baixar" quando pronto, erro com "Tentar de novo". O rótulo exibido após
recarregar a página é o `label` do servidor.
```
### `src/app/auth`
```js
useAuth() → { user, loading, error, expired, can(cap | cap[]), login(email,pw), logout(), refresh(), setUser(user) }
<RequireAuth area="client"|"admin" cap?>      // cap aceita lista (qualquer uma)
// roles.js: STAFF_ROLES, ROLE_LABELS, isStaff(user), areaOf(user), homeFor(user), roleLabel(role)
```
`user` = `Me` da API: `{id, name, email, role, status, jobTitle, phone, notifyEmail,
client: {id,name}|null, brands: [{id,name,slug,clientId}], capabilities}`. Staff tem
`client: null` e `brands: []`; admin tem todas as capacidades exceto `portal.access`.
### `src/app/shell`
```js
<AppShell area="client"|"admin">  // sidebar + topbar + <Outlet/>
useBrand() → { brands, brand, brandId, setBrandId }   // cliente: marca atual (lembrada em localStorage)
usePageTitle(title, {crumbs?})                         // document.title + trilha no topo
useShell() → { setNavCount(key, n), refreshCounts() } // atualizar badges após aprovar/ajustar
```
Badges do menu: equipe com `approvals.view` vê o total de `GET /api/approvals?status=changes_requested`;
cliente vê o total de `GET /api/approvals` (pendentes dele). O sino usa
`GET /api/notifications/unread-count` e `GET /api/notifications?pageSize=8`.
### `src/app/ui` (kit visual — importe de `src/app/ui/index.js`)
`Button` (variant: primary|secondary|ghost|danger|link; size sm|md; loading; icon),
`IconButton` (label obrigatório), `Icon` (reexport lucide com strokeWidth 1.4),
`Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `TagInput`, `DateInput`,
`Badge`, `StatusBadge` (`kind: 'visibility'|'approval'|'publication'|'project'|'task'|'order'|'subscription'|'briefing'|'zip'`, `value`),
`Tabs`, `Segmented` (grade/lista/calendário), `Card`, `Panel`, `PageHeader` (eyebrow, title,
accent, description, actions), `Stat` (label, value, hint, to), `Modal`, `Drawer`
(painel lateral), `ConfirmDialog`, `Menu` (dropdown acessível), `Tooltip`,
`useToast()` → `toast.success|error|info(msg)`, `Skeleton` (+ `SkeletonRows`, `SkeletonCards`),
`EmptyState` (icon, title, description, action), `ErrorState` (error, onRetry),
`DataTable` (columns, rows, rowKey, selectable, selected, onSelectedChange,
bulkActions, onRowClick, empty, loading; vira cartões < 760 px), `BulkBar`,
`FilterBar`, `SearchInput` (debounce), `Pagination`, `Avatar`, `ProgressBar`
(value 0..1, label), `CopyButton` (text, label, feedback "Copiado"), `Thumb`
(`file|thumb`, aspect, bg: light|dark|checker, fit, alt — skeleton enquanto carrega,
ícone por mediaKind quando não há prévia), `FileMeta` (nome · formato · tamanho ·
versão · data), `Checker` (fundo quadriculado), `Dropzone` (onFiles, accept, multiple),
`Breadcrumbs`, `Kbd`.
Hooks: `useApi(path | null, {params, deps})` → `{data, error, loading, reload, setData}`;
`useMutation(fn)` → `{run, loading, error}`; `useDebounced`, `useMediaQuery`,
`useReducedMotion`, `useSelection(ids)`.
Formatadores (`src/app/ui/format.js`): `formatBytes`, `formatDate`, `formatDateTime`,
`formatRelative`, `formatMoney(cents)`, `formatDuration(ms)`, `monthKey`.
Rótulos de estado: `src/app/ui/status.js` (`statusLabel(kind, value)`, `statusTone`).

Detalhes do kit implementado (valem sobre a lista acima):
- `Button` sem `variant` é `secondary`; use `variant="primary"` na ação principal.
- `icon` (e `<Icon icon>`) aceita componente lucide (`icon={Download}`), elemento ou nome de
  `ICONS` (`icon="download"`).
- Inputs nativos mantêm `onChange(event)` e aceitam `onValueChange(value)`; `Checkbox`/`Switch`
  têm `onCheckedChange(bool)`; `TagInput` chama `onChange(tags)`.
- `useApi` também devolve `refreshing`; `loading` só é true quando não há nada na tela.
  Trocar o caminho limpa os dados; trocar só `params` mantém o que está visível.
- `DataTable`: colunas com `primary`, `actions`, `hideOnMobile`, `mobileLabel`, `nowrap`,
  `align`; `bulkActions` = `[{label, icon, onClick(ids, rows, clear), tone}]` ou função;
  `selected` Set ou array; cabeçalho fixo só com `maxHeight`; `bare` dentro de `Panel`.
- `Card` com `onClick` vira `role="button"`; use `to` quando o card tiver outros botões.
- Extras exportados: `Spinner`, `FileGlyph`, `ToastProvider`, `useIsNarrow`, `useCopy`,
  `copyText`, `useLatest`, e em `status.js` `statusOptions`, `label`, `labelOptions`,
  `roleLabel`, `networkLabel`, `postFormatLabel`, `fileRoleLabel`, `mediaKindLabel`,
  `variantLabel`, `areaLabel`.
- Menus e tooltips usam a Popover API e diálogos usam `<dialog>.showModal()` (camada
  superior); toasts são portais no fim do `body` (dentro de `.app.ui-portal`).
  `.ui-page-enter` está disponível para a entrada de uma página.
- `BulkBar` fica **onde a página o coloca** (logo após a lista selecionável, para seguir a seleção na
  ordem de tabulação) e aparece na camada superior (Popover API). `Alt+Shift+L` (`BULK_SHORTCUT`) ou
  `<BulkJump count>` (botão “Ir para as ações em lote (N)” visível só com foco, depois do último item
  marcado) levam o foco à barra; Esc e “Limpar seleção” devolvem o foco ao item. A barra publica sua altura
  em `--ui-bulkbar-h` (toasts e a bandeja de downloads ficam acima). Barras próprias de uma página chamam
  `registerBulkBar(el)` para ganhar o atalho e o espaço (a biblioteca faz isso em `LibBulkBar`).
- `focusFirstInvalid(formRef.current, {reducedMotion})` (forms.jsx): chame logo após marcar os erros; espera
  um quadro, rola e foca o primeiro campo inválido (`aria-invalid` ou grupo `.is-invalid`) e devolve uma
  Promise com o campo.
- `useCopy()` → `{copy, copied, failed}`; `COPY_FAILED_MESSAGE` para o aviso de cópia manual. `CopyButton`
  já mostra o toast de erro.
- `useApi`: um caminho diferente nunca devolve os dados do caminho anterior (`resolveApiState`); caminho
  `null` mantém o último dado (drawers fechando não piscam vazios).
- `DataTable` reage à própria largura: colunas com `hideBelow` (px da tabela) saem primeiro, depois os
  cabeçalhos quebram linha e por fim vira cartões (`cards="auto"|"narrow"`). Colunas aceitam também
  `minWidth` e `numeric` (números à direita, numa linha). A coluna de ações fica fixa à direita.
- Shell: entre 900 e 1200 px a navegação lateral vira um trilho de ícones de 72 px (rótulos lidos por leitores
  de tela e mostrados como dica ao lado).
- `formatBytes` usa duas casas a partir de GB (“1,03 GB” nunca se confunde com o limite “1 GB”).

## Fatia D — componentes de revisão compartilhados (`src/app/shared/review/`)

Usados também pelas fatias B e C. Props estáveis:

```jsx
<MaterialViewer material={MaterialDetail} versionId? onVersionChange? compact? bulkDownload? afterPreview? />
  // bulkDownload={false} esconde o botão de ZIP quando a página já oferece o seu;
  // afterPreview é renderizado logo abaixo da prévia (ex.: decisão do cliente no celular)
  // prévia grande (imagem, SVG rasterizado, carrossel, vídeo com capa, PDF com capa ou cartão),
  // seletor de versões, seções "Prévia", "Original", "Final aprovado", "Editável" com
  // FileMeta e botões de download (respeita file.downloadable)
<CarouselViewer files={File[]} initialIndex? onIndexChange? aspect? />   // teclado, swipe, contador "3/8"
<VideoPlayer file={File} poster? />
<CommentThread materialId versionId? versionNumber? canInternal versionReleased? internalVersionId?
               internalVersionNumber? subject? slides? refreshKey? />
  // abas "Com o cliente" / "Notas internas" para staff; versionReleased={false} avisa que a mensagem
  // fica guardada até a liberação; notas internas vão para internalVersionId quando informado;
  // subject ("esta publicação" | "este material") no texto vazio do cliente
<ZipButton run={() => Promise<ZipJob>}>   // mostra "Preparando ZIP… N%" com o job real e ignora cliques enquanto roda
<ApprovalPanel material={MaterialDetail} onDone(material) />  // cliente: aprovar versão / solicitar ajustes
<VersionHistory material={MaterialDetail} onSelect(versionId) />
<ApprovalTimeline materialId />
<CaptionBlock caption hashtags />   // copiar legenda / hashtags com feedback
```

## CSS

- Fundação: `src/app/ui/app.css` (tokens `--app-*`, reset do escopo `.app`, kit visual,
  shell, movimento e `prefers-reduced-motion`).
- Cada fatia cria **um** CSS próprio importado pelas suas páginas, com prefixo de classe:
  B `lib-`, C `mb-` (minha marca/arquivos), D `rv-` / `cnt-`, E `crm-`, G `fin-`,
  H `hub-`, I `ov-`. Não sobrescrever classes `ui-`/`app-`/`sh-`/`dl-`/`acc-` da Fundação.
  Importe o CSS da fatia **depois** de `ui/index.js`.
- Use os tokens `--app-*` (cores, `--app-focus`, `--app-danger`, tons `--app-tone-*`,
  espaços, raios, `--app-fast|base|slow`) em vez de hex soltos. Fontes carregadas: Raleway
  200/300, Manrope 400/500, Cormorant Garamond 400 itálico — nada de 600/700.
- A regra global de `prefers-reduced-motion` em `app.css` já zera animações e transições
  dentro de `.app`; animações infinitas só para indicadores de carregamento reais.
- `.sh-route` (conteúdo da página) anima com `backwards`, então `position: fixed` dentro da
  página (prévia ampliada, barra fixa) se posiciona pela janela.
