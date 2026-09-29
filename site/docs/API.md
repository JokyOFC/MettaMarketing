# Contrato da API

Base `/api`. JSON em camelCase. Datas ISO-8601 (UTC); datas de calendário `AAAA-MM-DD`.
Toda requisição que altera estado envia `X-Metta-Request: 1` (o cliente de
`src/app/api/client.js` faz isso). Sessão por cookie `metta_sid`.

Erros: `{ "error": { "code": string, "message": string (pt-BR, para exibir), "fields"?: {campo: mensagem} } }`

| HTTP | code                          | Uso |
| ---- | ----------------------------- | --- |
| 400  | `bad_request`                 | Requisição malformada |
| 401  | `unauthenticated`             | Sem sessão / sessão expirada |
| 403  | `forbidden`                   | Vê o recurso mas não pode agir |
| 404  | `not_found`                   | Inexistente **ou fora do escopo** |
| 409  | `conflict`                    | Estado mudou (ex.: aprovar versão que não é a atual) |
| 410  | `expired`                     | Link temporário/ZIP expirado |
| 413  | `payload_too_large`           | Upload acima do limite |
| 415  | `unsupported_media`           | Extensão/assinatura não permitida |
| 422  | `validation`                  | Campos inválidos (`fields`) |
| 429  | `rate_limited`                | Muitas tentativas |
| 502  | `upstream_error`              | Falha de integração (Mercado Pago, SMTP) |
| 503  | `integration_not_configured`  | Integração sem credenciais |
| 500  | `internal`                    | Erro inesperado (mensagem genérica) |

Listas: `{ items: [...], total: number }`, com `?page=1&pageSize=50` (máx. 200) quando fizer sentido.

## Objetos

```ts
UserRef   = { id, name, role }
Me        = { id, name, email, role, status, jobTitle, notifyEmail,
              client: { id, name } | null,
              brands: BrandRef[],                     // cliente: suas marcas ativas; staff: []
              capabilities: string[] }
BrandRef  = { id, name, slug, clientId }
Category  = { id, slug, name, area: 'identity'|'content'|'other', folder, sortOrder, isSystem, archivedAt }

File = {
  id, role: 'original'|'final'|'editable'|'cover', position,
  name, ext, format /* 'PNG' */, mime, sizeBytes, width, height, durationMs, pages,
  mediaKind, previewStatus,
  previews: { thumb: url|null, preview: url|null, poster: url|null, stream: url|null },
  downloadable: boolean,          // já considera papel, download_enabled e licença de fonte
  createdAt
}
// previews apontam para /api/files/:id/preview/:kind e /api/files/:id/stream (vídeo/áudio/pdf, com Range)

Version = {
  id, number, status, caption, hashtags, notes, changeSummary,
  createdAt, createdBy: UserRef, releasedAt, decidedAt, decidedBy: UserRef|null,
  files: File[]                   // ordenados por role, position
}

Material = {
  id, kind: 'asset'|'post', title, description, tags: string[],
  brand: BrandRef, client: { id, name },
  project: { id, name } | null,
  category: Category,
  owner: UserRef | null,                   // staff; cliente recebe { name } da equipe responsável
  variant, previewBg, isPrimary, sortOrder,
  visibility,                              // cliente sempre 'released'
  downloadEnabled, editableIncluded, requiresApproval,
  approvalStatus, approvedVersionId,
  dueDate, releasedAt, deliveredAt, archivedAt, createdAt, updatedAt,
  version: VersionSummary,                 // staff: versão atual; cliente: versão liberada mais recente
  thumb: { fileId, url, width, height, mediaKind } | null,
  formats: string[],                       // formatos realmente existentes, ex. ['SVG','PNG','PDF']
  fileCount, totalBytes,
  post: { network, format, plannedDate, plannedTime, campaign: {id,name}|null,
          publicationStatus, scheduledAt, publishedAt, publishedUrl } | null,
  internalNotes                            // somente staff
}
VersionSummary = { id, number, status, releasedAt, createdAt }

MaterialDetail = Material & {
  versions: Version[],                     // cliente: apenas versões liberadas
  permissions: { canEdit, canRelease, canArchive, canApprove, canComment,
                 canCommentInternal, canDownload, canUploadVersion }
}

Comment = { id, materialId, versionId, versionNumber, parentId,
            author: { id, name, role, isClient }, body,
            visibility /* só staff */, kind, slidePosition, createdAt, editedAt, resolvedAt }

ZipJob = { id, label, filename, status: 'queued'|'running'|'ready'|'failed'|'expired',
           fileCount, totalBytes, processedBytes, progress /* 0..1 */, sizeBytes,
           error, createdAt, finishedAt, expiresAt }

Notification = { id, type, title, body, link, entityType, entityId, readAt, createdAt }
Activity     = { id, actor: UserRef|null, action, entityType, entityId, summary,
                 client:{id,name}|null, brand:{id,name}|null, materialId, data /* staff */,
                 visibility /* staff */, createdAt }
```

## Autenticação — Fundação (`routes/auth.js`)

| Método | Caminho | Corpo / resposta |
| ------ | ------- | ---------------- |
| POST | `/api/auth/login` | `{email,password}` → `{user: Me}`; 401 `invalid_credentials` (mensagem genérica); 429 |
| POST | `/api/auth/logout` | 204 |
| GET | `/api/auth/me` | `{user: Me}` ou 401 |
| GET | `/api/auth/invite/:token` | `{email, name, purpose}` ou 410 |
| POST | `/api/auth/invite/accept` | `{token, password, name?}` → `{user: Me}` (senha ≥ 10 caracteres) |
| POST | `/api/auth/password/forgot` | `{email}` → 204 sempre |
| POST | `/api/auth/password/reset` | `{token, password}` → 204 |
| POST | `/api/auth/password/change` | `{currentPassword, newPassword}` → 204 (revoga outras sessões) |
| PATCH | `/api/auth/profile` | `{name?, jobTitle?, phone?, notifyEmail?}` → `{user: Me}` |
| GET | `/api/auth/sessions` | `{items:[{id, createdAt, lastSeenAt, userAgent, ip, current}]}` |
| DELETE | `/api/auth/sessions/:id` | 204 |

### Cadastro pelo site (`routes/signup.js`)

Sem sessão e sem confirmação por e-mail: o acesso já nasce ativo. Fechado pela equipe
(`signupEnabled = false` em `/api/settings`), `POST /api/auth/signup` responde 403 `signup_closed`.

| Método | Caminho | Corpo / resposta |
| ------ | ------- | ---------------- |
| GET | `/api/auth/signup` | `{enabled}` — se `/cadastro` mostra o formulário |
| POST | `/api/auth/signup` | `{name, email, company, phone?, document? (CPF/CNPJ), password, acceptTerms: true, website? (armadilha, vazio)}` → 201 `{user: Me}` e cookie de sessão. Cria o cliente (`source = 'signup'`) e o acesso `client` ativo, avisa os administradores (`client.signed_up`) e registra no histórico. 422 com campos (inclui `email` quando o e-mail já tem acesso); 400 se a armadilha vier preenchida; 429 (5 cadastros/hora por IP em produção) |

## Clientes, marcas, equipe, projetos — Fatia E

| Método | Caminho | Notas |
| ------ | ------- | ----- |
| GET | `/api/clients` | escopo; `?q&status` → `{items:[{id,name,legalName,status,brandCount,projectCount,userCount,createdAt}]}` |
| POST | `/api/clients` | admin; `{name, legalName?, document?, contactName?, contactEmail?, contactPhone?, internalNotes?, brand?: {name, description?}}` → `{client}` |
| GET | `/api/clients/:id` | `{client, brands, users, projects, managers}` |
| PATCH | `/api/clients/:id` | clients.edit (admin) / manager só campos não sensíveis |
| GET | `/api/clients/:id/users` · POST `/api/clients/:id/users` | convida usuário cliente `{name,email}` → cria `invited` + e-mail + `inviteUrl` na resposta **somente** quando o e-mail não está configurado (para a equipe repassar) |
| GET | `/api/brands` | escopo; `?clientId` → `{items: Brand[]}` |
| POST | `/api/clients/:id/brands` | `{name, description?}` |
| GET/PATCH | `/api/brands/:id` | `Brand = {id, clientId, client:{id,name}, name, slug, description, usageGuidelines, typographyGuidelines, status, internalNotes(staff), createdAt}` |
| GET | `/api/team/users` | team.view; `?role&status` → staff (sem clientes) |
| POST | `/api/team/users` | team.manage `{name,email,role,jobTitle?, clientIds?}` → convite |
| PATCH | `/api/team/users/:id` | `{name?, role?, status?, jobTitle?}` (não pode rebaixar o último admin) |
| PUT | `/api/team/users/:id/clients` | `{clientIds}` (staff_client_access) |
| POST | `/api/users/:id/invite` | reenviar convite (staff ou cliente, conforme permissão) |
| GET | `/api/projects` | escopo; `?brandId&clientId&status&mine=1` |
| POST | `/api/projects` | projects.manage `{brandId, name, description?, serviceId?, status?, startDate?, dueDate?, includesEditables?, memberIds?}` — notifica membros ("projeto atribuído") |
| GET/PATCH | `/api/projects/:id` | detalhe inclui `members`, `taskCounts`, `materialCounts`, `kits` |
| PUT | `/api/projects/:id/members` | `{members:[{userId, role}]}` — notifica novos membros |
| GET | `/api/projects/:id/tasks` · POST `/api/projects/:id/tasks` | |
| PATCH/DELETE | `/api/tasks/:id` | `{title?, description?, assigneeId?, status?, dueDate?, sortOrder?}` |
| GET | `/api/me/tasks` | tarefas atribuídas ao usuário |
| GET | `/api/portal/projects` | cliente: projetos das suas marcas com `{id,name,status,brand,startDate,dueDate,deliveredAt, materialCount, releasedCount, kits:[{id,name,kind}]}` |

## Materiais, uploads, liberação, kits, arquivos e ZIPs — Fatia A

| Método | Caminho | Notas |
| ------ | ------- | ----- |
| POST | `/api/uploads` | multipart, campo `file` (1 arquivo por requisição para progresso individual) → `{upload:{id,name,ext,format,sizeBytes,mediaKind,width,height,createdAt}}`; 413/415/422 |
| DELETE | `/api/uploads/:id` | descarta upload não anexado |
| GET | `/api/materials` | staff: escopo; cliente: só liberados. `?brandId&projectId&categoryId&kind&visibility&approval&ownerId&tag&q&archived=1&sort=sortOrder|updated|due` → `{items: Material[], total}` |
| POST | `/api/materials` | materials.upload `{kind:'asset', brandId, projectId?, categoryId, title, description?, tags?, ownerId?, variant?, previewBg?, dueDate?, editableIncluded?, requiresApproval?, internalNotes?, files:[{uploadId, role, position}], notes?, changeSummary?}` → `{material: MaterialDetail}` (visibility `draft`, versão 1 `draft`) |
| GET | `/api/materials/:id` | `{material: MaterialDetail}` |
| PATCH | `/api/materials/:id` | metadados (`title, description, tags, categoryId, projectId, ownerId, variant, previewBg, dueDate, downloadEnabled, editableIncluded, requiresApproval, internalNotes, sortOrder`) |
| POST | `/api/materials/:id/versions` | nova versão `draft` `{files:[{uploadId, role, position}], copyFrom?: 'current', caption?, hashtags?, notes?, changeSummary?}`; histórico preservado |
| PATCH | `/api/versions/:id` | só versão `draft`/`internal_review`: `{caption?, hashtags?, notes?, changeSummary?, files?:[{id, position, role}]}` (reordenar slides) |
| POST | `/api/versions/:id/files` | `{files:[{uploadId, role, position}]}` (inclui `final` após aprovação) |
| DELETE | `/api/files/:id` | só em versão não liberada |
| POST | `/api/materials/:id/submit` | rascunho → revisão interna (notifica gestores) |
| POST | `/api/materials/:id/primary` | define principal da categoria/variante (troca o anterior) |
| POST | `/api/materials/reorder` | `{ids:[...]}` mesma marca+categoria |
| POST | `/api/materials/bulk` | `{ids, action:'archive'|'unarchive'|'submit'|'enable_download'|'disable_download'|'set_category'|'set_owner'|'set_project', value?}` → `{updated, skipped:[{id, reason}]}` |
| POST | `/api/materials/:id/archive` · `/unarchive` | |
| GET | `/api/materials/:id/history` | staff: tudo (`Activity[]` + versões + downloads); cliente: eventos `client` |
| POST | `/api/releases/preview` | materials.release `{materialIds, kitId?}` → `{client, brand, recipients:[{id,name,email,notifyEmail}], items:[{material, version, files, downloadEnabled, editableIncluded, isNewVersion, requiresApproval}], warnings:[string], blockers:[string]}` — todos da mesma marca |
| POST | `/api/releases` | `{materialIds, kitId?, downloadEnabled?: {[materialId]: boolean}, notifyEmail, notifyApp, message?}` → `{release, items}`; marca versão atual como liberada, anterior liberada vira `superseded`, `approval_status='pending'` se exigir aprovação, notifica cliente, registra histórico |
| GET | `/api/releases` | `?clientId&brandId` histórico de disponibilização |
| GET | `/api/kits` · POST `/api/kits` | `{brandId, projectId?, name, description?, kind, materialIds?}` |
| GET/PATCH/DELETE | `/api/kits/:id` | cliente vê só kits `released` com itens visíveis |
| PUT | `/api/kits/:id/items` | `{materialIds}` ordenados |
| POST | `/api/kits/:id/release` | libera o kit (e os materiais ainda não liberados, com o mesmo resumo de `/api/releases/preview`) |
| GET | `/api/files/:id/preview/:kind` | `thumb|preview|poster`; autorização a cada requisição; `Cache-Control: private, max-age=300` |
| GET | `/api/files/:id/stream` | vídeo/áudio/PDF inline para visualização, com Range; autorização a cada requisição |
| POST | `/api/downloads/link` | `{fileId}` → `{url:'/dl/<token>', expiresAt}` (403 `download_disabled`, 403 `font_license`) |
| GET | `/dl/:token` | resgata link (mesma sessão + nova checagem) → arquivo original com `Content-Disposition: attachment`; registra `download_events`; 410 expirado |
| POST | `/api/zips` | `{scope}` → `{job: ZipJob}` (202). `scope` = `{type:'selection', fileIds?:[], materialIds?:[]}` · `{type:'category', brandId, categoryId}` · `{type:'brand_kit', brandId}` · `{type:'carousel', materialId}` · `{type:'project', projectId}` · `{type:'kit', kitId}`; opcional `includeEditables` (padrão true) |
| GET | `/api/zips` | meus jobs recentes |
| GET | `/api/zips/:id` | `{job}` (só o dono) |
| POST | `/api/zips/:id/link` | `{url:'/dl/<token>', expiresAt}` quando `ready` |

## Biblioteca da marca — Fatia B (`routes/brandlib.js`)

| Método | Caminho | Notas |
| ------ | ------- | ----- |
| GET | `/api/brands/:id/library` | staff: tudo; cliente: só liberado. → `{brand, logos:{principal:[Material], secundaria:[], simbolo:[], clara:[], escura:[], monocromatica:[], outros:[]}, colors:[Color], fonts:[Font], manual:[Material], identity:[Material], sections:[{category, materials:[Material]}], editables:{count}, kits:[{id,name,kind,status}], counts:{files, formats:[...]} }` |
| POST | `/api/brands/:id/colors` | `{name, hex, rgb?, cmyk?, pantone?, role?, usage?}` (hex `#RRGGBB`) |
| PATCH/DELETE | `/api/colors/:id` | |
| POST | `/api/brands/:id/colors/reorder` | `{ids}` |
| POST | `/api/brands/:id/fonts` | `{family, role?, weights?, usage?, sourceUrl?, license?, distribution, materialId?}` |
| PATCH/DELETE | `/api/fonts/:id` | ao mudar `distribution`, atualiza `font_distributable` dos arquivos do material vinculado |
| POST | `/api/brands/:id/identity/release` | `{colorIds?, fontIds?, notify?}` libera cores/fontes/orientações |
| PATCH | `/api/brands/:id/guidelines` | `{usageGuidelines?, typographyGuidelines?}` |

`Color = {id, name, hex, rgb, cmyk, pantone, role, usage, sortOrder, visibility(staff)}`
`Font = {id, family, role, weights, usage, sourceUrl, license, distribution, files: File[] /* só se allowed ou staff */, visibility(staff)}`

## Conteúdo e revisão — Fatia D

| Método | Caminho | Notas |
| ------ | ------- | ----- |
| GET | `/api/content` | posts (`kind='post'`); `?brandId&from&to&campaignId&network&format&approval&publication&visibility&q&view=calendar` → `{items: Material[]}` |
| POST | `/api/content` | content.manage `{brandId, projectId?, categoryId?, title, network, format, plannedDate?, plannedTime?, campaignId?, caption?, hashtags?, notes?, internalNotes?, ownerId?, files:[{uploadId, role, position}]}` → `{material: MaterialDetail}`; categoria padrão pelo formato (carrossel/estático → posts-carrosseis, stories → stories, reels/vídeo → reels-videos) |
| PATCH | `/api/content/:id` | campos do post (rede, formato, data, campanha) |
| PATCH | `/api/content/:id/publication` | content.publication `{status:'not_scheduled'|'scheduled'|'published', scheduledAt?, publishedAt?, publishedUrl?}` — manual, registra autor |
| GET/POST | `/api/campaigns` · PATCH/DELETE `/api/campaigns/:id` | `?brandId` |
| GET | `/api/materials/:id/comments` | cliente: só `client`; staff: ambos com `visibility` |
| POST | `/api/materials/:id/comments` | `{body, versionId?, slidePosition?, visibility?, parentId?}` — cliente sempre `client` (ignora o enviado); `internal` exige comments.internal |
| PATCH | `/api/comments/:id` | autor edita corpo; staff resolve `{resolved:true}` |
| POST | `/api/materials/:id/approve` | **cliente** `{versionId, note?}` — 409 se `versionId` ≠ versão liberada atual ou já decidida; registra `approvals` (quem, quando, versão, IP), notifica equipe |
| POST | `/api/materials/:id/request-changes` | **cliente** `{versionId, body, slidePosition?}` → comentário `change_request` + decisão; notifica equipe |
| GET | `/api/approvals` | staff: fila `?status=pending|changes_requested|approved&brandId&clientId`; cliente: seus pendentes → `{items: Material[] & {lastDecision}}` |
| GET | `/api/materials/:id/approvals` | histórico de decisões `{items:[{id, versionId, versionNumber, decision, user:{id,name}, createdAt, comment}]}` |

## Comercial — Fatia G

| Método | Caminho | Notas |
| ------ | ------- | ----- |
| GET/POST | `/api/services` · PATCH `/api/services/:id` | catálogo (planos e serviços) |
| GET/POST | `/api/orders` · GET/PATCH `/api/orders/:id` | `{clientId, brandId?, serviceId?, description, amountCents, dueDate?}` |
| POST | `/api/orders/:id/checkout` | gera preferência MP → `{checkoutUrl}`; 503 sem credenciais; 502 falha MP |
| POST | `/api/orders/:id/cancel` | |
| GET/POST | `/api/subscriptions` · GET `/api/subscriptions/:id` | `{clientId, serviceId, payerEmail}` |
| POST | `/api/subscriptions/:id/checkout` · `/cancel` | preapproval MP |
| GET | `/api/payments` | `?clientId&status` |
| GET | `/api/finance/summary` | contagens/valores reais: pendentes, pagos no mês, assinaturas ativas, falhas |
| GET | `/api/finance/status` | `{mercadopago:{configured, mode:'test'|'production'|null}}` |
| GET | `/api/portal/billing` | cliente: pedidos, assinaturas e pagamentos próprios |
| POST | `/api/portal/orders/:id/pay` | cliente: obtém/gera link de pagamento de pedido próprio pendente |
| POST | `/api/webhooks/mercadopago` | sem sessão/CSRF; valida assinatura; idempotente; confirma via API |

## Briefings, notificações, configurações, categorias — Fatia H

| Método | Caminho | Notas |
| ------ | ------- | ----- |
| GET/POST | `/api/briefings` · GET/PATCH/DELETE `/api/briefings/:id` | `questions: [{id, label, help?, type:'text'|'textarea'|'choice'|'multi'|'date'|'url', options?, required}]`; cliente só vê enviados das próprias marcas |
| POST | `/api/briefings/:id/send` | draft → awaiting_client, notifica cliente |
| PUT | `/api/briefings/:id/answers` | cliente `{answers, submit:boolean}`; valida obrigatórias ao enviar |
| POST | `/api/briefings/:id/review` · `/reopen` | staff |
| GET | `/api/briefing-templates` | modelos embutidos (identidade visual, conteúdo mensal, campanha) |
| GET | `/api/notifications` | `?unread=1&page` → `{items, total, unread}` |
| GET | `/api/notifications/unread-count` | `{unread}` |
| POST | `/api/notifications/:id/read` · `/api/notifications/read-all` | |
| GET/POST | `/api/categories` · PATCH `/api/categories/:id` | criar/renomear/arquivar/reordenar (categories.manage); sistema não pode ser removida |
| GET/PATCH | `/api/settings` | admin: `{orgName, supportEmail, defaultNotifyEmail, zipRetentionHours, ...}` |
| GET | `/api/settings/integrations` | `{email:{configured, from}, mercadopago:{configured, mode}, storage:{driver, usedBytes, files}, ffmpeg:{available}, outbox:{notConfigured, failed}}` |
| GET | `/api/settings/outbox` | admin: e-mails recentes e status |

## Visão geral, relatórios e histórico — Fatia I

| Método | Caminho | Notas |
| ------ | ------- | ----- |
| GET | `/api/admin/overview` | números reais no escopo: `{projectsInProgress, upcomingDeliveries:[...], pendingApprovals, changesRequested, briefingsAwaiting, paymentsPending, activeSubscriptions, recentActivity:[Activity], myTasks:[...]}` — itens financeiros só com finance.view |
| GET | `/api/portal/overview` | cliente: `{brands, pendingApprovals:[Material], recentReleases:[...], briefingsToFill:[...], upcoming:[Material], billing:{pendingOrders}, recentActivity:[Activity]}` |
| GET | `/api/reports/deliveries` | `?from&to&clientId&brandId&format=csv` |
| GET | `/api/reports/approvals` | tempo até aprovação, rodadas de ajuste |
| GET | `/api/reports/downloads` | downloads por cliente/material |
| GET | `/api/reports/finance` | reports.finance |
| GET | `/api/activity` | staff: `?clientId&brandId&projectId&materialId&actorId&action&entityType&from&to&page` |
| GET | `/api/portal/activity` | cliente: apenas `visibility='client'` do próprio cliente |

## Adições e desvios registrados pelas fatias

Consolidado na integração a partir dos relatórios das fatias. Vale sobre as tabelas acima
quando houver diferença.

### Materiais, liberação, arquivos e ZIPs (Fatia A)

- Extras: `GET /api/versions/:id`, `GET /api/uploads/:id`, `POST /api/materials/:id/deliver`
  (materials.release; publica finais anexados após a liberação, marca `deliveredAt`, avisa o cliente),
  `POST /api/kits/:id/release/preview`.
- `GET /api/materials` sem `page`/`pageSize` devolve todos os resultados; `sort` aceita também
  `created|planned|title|released`.
- `POST /api/materials/bulk` → `{updated: number, updatedIds, skipped}`.
- Criar/editar versão e anexar arquivos → `{version, material}` (+ `fileIds` ao anexar).
- `POST /api/releases` → `{release, items, materials}`; o preview também traz `kit`, `counts` e, por item,
  `alreadyReleased`, `warnings`, `fileCount`; arquivos com `clientVisible`/`clientDownloadable`.
  `downloadEnabled` aceita um booleano para todos ou um mapa por material. Liberar sem nada novo → 409 (exceto kit).
- Finais anexados a uma versão já liberada ficam ocultos (`published: false`, só staff) até `/deliver`;
  o detalhe traz `pendingDeliveryCount` e `permissions.canDeliver`.
- Histórico: staff recebe `{items, activity, versions, releases, downloads}` (download sempre `isApproval: false`);
  cliente recebe `{items}`.
- ZIP: seleção com arquivo não baixável → 403 (não é pulado); pacote vazio → 404; pedido idêntico reaproveita o job;
  mais de 4 jobs ativos por pessoa → 429. Download de ZIP grava uma linha em `download_events` com `material_id`
  nulo e o escopo em JSON (o uso por material fica em `zip_jobs.entries`). Retenção: configuração `zipRetentionHours`.
- Stream de PDF para cliente segue a regra de download (`previews.stream` nulo quando não pode baixar).
- `GET /dl/:token` resgatado por outra sessão: 404 quando a pessoa não vê o registro (ex.: outro cliente), 403 quando
  vê mas o link é de outra pessoa (colega do mesmo cliente, equipe). Token inválido/adulterado → 404; expirado → 410;
  sem sessão → 401.
- Kit liberado não é apagado (409); arquive com `PATCH {status:'archived'}`.

### Biblioteca da marca (Fatia B)

- `GET /api/brands/:id/library` também traz `categories`, `counts.materials`, `editables.materialCount` e `material`
  em cada fonte; `sections` lista todas as categorias de identidade.
- `POST /api/brands/:id/identity/release`: sem `colorIds`/`fontIds` libera todos os rascunhos; aceita `guidelines`,
  `notify`, `notifyEmail`, `message`. As orientações têm rascunho e liberação (ver "Correções da revisão").

### Conteúdo e revisão (Fatia D)

- Extras: `GET /api/content/:id`, `GET /api/content/options` (marcas, projetos, campanhas, responsáveis e meses no
  escopo), `POST /api/content/bulk-publication` (só agenda/desagenda; nunca "publicado" em lote).
- `PATCH /api/content/:id` também aceita título, responsável, notas internas e descrição; legenda/hashtags/notas só
  em versão rascunho ou revisão interna (senão 409).
- `GET /api/content`: `sort=planned_desc`; `view=calendar` devolve também `undated`; itens com `slides`, `mediaKind`,
  `durationMs`, `frame`.
- Publicação: agendar/publicar exige material liberado (409); publicado exige `confirm: true` e data não futura.
- Decisões: aprovar vale com status pendente ou após ajustes; pedir ajustes só enquanto pendente (segundo pedido → 409).
  `GET /api/materials/:id/approvals` também traz `releases`; IP e navegador só para staff. Fila com `reviewVersion`,
  `lastDecision`, `lastChangeRequest`, `since`. Comentários de equipe chegam ao cliente como `{name, isClient:false}`;
  todo comentário traz `mine`.

### Clientes, equipe e projetos (Fatia E)

- Extras: `PATCH /api/clients/:id/users/:userId` (desativar/reativar), `POST /api/clients/:id/managers` e
  `DELETE /api/clients/:id/managers/:userId`, `GET /api/team/roles`, `GET /api/projects/options?brandId`.
- `POST /api/clients` aceita `user` e `managerIds` → `{client, brand, user, emailStatus, inviteUrl?}`.
- Detalhe do projeto traz `tasks`, `materials`, `activity`, `permissions`. Portal: contagens só de liberados, mais
  `approvedCount`, `pendingCount`, `changesRequestedCount`, `finalizedCount`, `hasDownloads`.
- Novos usuários recebem `notifyEmail` conforme a configuração `defaultNotifyEmail`.

### Comercial (Fatia G)

- Extras: `GET /api/commerce/options`, `POST /api/services/reorder`, `POST /api/orders/:id/send` e
  `/api/subscriptions/:id/send`, `POST /api/orders/:id/sync` e `/api/subscriptions/:id/sync`,
  `GET /api/finance/webhooks`.
- `GET /api/orders?status=` aceita também `open` (aguardando pagamento ou com falha) e `overdue`.

### Briefings, notificações, categorias e configurações (Fatia H)

- Briefings trazem `progress` e `permissions`; a lista traz `counts` por status e `status` aceita lista separada por
  vírgula. `PUT …/answers` → `{briefing, savedAt}`; reenviar um briefing enviado manda lembrete (`reminder: true`);
  apagar só rascunho/sem resposta (409); mudar perguntas após resposta → 409.
- Categorias: lista só ativas (`?archived=1` para staff incluir arquivadas; `?area=`); admin recebe `materialCount`;
  `POST /api/categories/reorder {ids}`; slug nunca muda.
- `GET/PATCH /api/settings` → `{settings: {...}}`; extras `POST /api/settings/outbox/:id/retry` e
  `POST /api/settings/email/test`.
- Notificações: página padrão 30; ler uma → `{notification, unread}`; ler todas → `{updated, unread}`.

### Visão geral, relatórios e histórico (Fatia I)

- Extras: `GET /api/activity/facets`, `GET /api/reports/filters`.
- Visão geral também traz `upcomingCount`, `overdueCount`, `awaitingRelease`, totais em centavos e `myTasksTotal`;
  blocos que o papel não vê chegam como `null`. Atividades trazem `material` e `link`/`linkLabel`.
- Relatórios agrupam por dia/semana/mês automaticamente (fuso de São Paulo, UTC−3); o de downloads conta só clientes
  por padrão (`audience`). Exportar CSV registra `report.exported`/`activity.exported` (somente equipe).

## Correções da revisão (valem sobre o que estiver acima)

### Segurança e núcleo

- CSRF (`X-Metta-Request` + `Origin`) vale para **toda** requisição que altera estado, em qualquer caixa do
  caminho; a única exceção é `POST /api/webhooks/mercadopago`. Rotas são sensíveis a maiúsculas: `/API/...`,
  `/Dl/...` → 404 com `Cache-Control: no-store`.
- `POST /api/webhooks/mercadopago`: assinatura é verificada antes de gravar. Sem assinatura válida → 401 e só
  metadados são guardados (sem payload); mais de 20 por IP em 10 min → 429 `rate_limited` sem gravar nada.
  Retenção: últimas 200 rejeitadas (máx. 30 dias); assinadas processadas por 365 dias.
- `GET /api/clients?q=`: para designers, a busca considera só nome, razão social e marcas do seu escopo
  (nunca documento ou contato).

### Identidade da marca (orientações com rascunho e liberação)

- `PATCH /api/brands/:id/guidelines`, os campos de orientação de `PATCH /api/brands/:id` e a criação de marca
  gravam só o **rascunho**. O cliente recebe `usageGuidelines`/`typographyGuidelines` liberados; a equipe recebe
  também `usageGuidelinesDraft`, `typographyGuidelinesDraft`, `hasUnreleasedGuidelines`, `guidelinesDraftAt`,
  `guidelinesReleasedAt`.
- `POST /api/brands/:id/identity/release` (materials.release) publica o rascunho quando ele difere do liberado
  (`guidelines: false` para não publicar) → `{released:{colors, fonts, guidelines}, recipients, brand, colors, fonts}`;
  `recipients` é 0 quando nenhum aviso foi marcado.
- Cor ou fonte já liberada: designer recebe 403 ao mudar o que o cliente vê (reenviar os mesmos valores é aceito).
- Arquivo de fonte só é baixável quando uma fonte **liberada** vinculada permite distribuição (sincronizado ao
  liberar, ocultar, editar ou apagar; trigger `material_files_font_licence` na migração 010).

### Materiais, liberação, arquivos e ZIPs

- Responsável (`ownerId` em `POST/PATCH /api/materials`, `set_owner` em lote, `POST/PATCH /api/content`):
  só admin, gestor com acesso ao cliente ou designer em projeto da marca → senão 422
  `{ownerId: 'Escolha alguém da equipe com acesso a este cliente.'}` (no lote, vai para `skipped`).
- Nova versão com `copyFrom: 'current'` não copia arquivos finais. O preview de liberação traz por item
  `inheritedFinalCount` e `missingProject` (com aviso) e, no topo, `emailConfigured`. Finais herdados de outra
  versão ficam ocultos ao cliente até nova entrega.
- `POST /api/releases`, `POST /api/kits/:id/release` e `POST /api/materials/:id/deliver` respondem também
  `emailConfigured`, `appRecipients` e `emailRecipients` (quem de fato foi avisado).
- `POST /api/materials/:id/deliver` aceita `{mode: 'originals', notifyApp, notifyEmail, message}` para materiais
  entregues como arquivos originais (marca `deliveredAt`); 409 só quando não há o que entregar ou já foi entregue.
  O detalhe (staff) traz `deliverableWithoutFinals`.
- `GET /api/materials?unassigned=1`: materiais sem projeto ou serviço.
- Ligar/desligar download grava **uma** entrada de histórico, com o nome de quem fez
  (ex.: “Gil Gestor bloqueou o download de “X”.”).
- `POST /api/downloads/link` → 404 “O arquivo não está mais disponível no armazenamento.” quando o arquivo
  sumiu; download que falha não é registrado em `download_events`.
- `POST /api/zips` aceita `label` (até 80 caracteres) para seleções; nomes: um material → “Título · N arquivos”
  e `<marca>-<título>-<data>.zip`; uma categoria → “Categoria · N arquivos”. Reaproveitamento de job considera
  escopo e nome. Datas de ZIP e pastas de mês usam o fuso de São Paulo.
- `POST /api/zips/:id/link` refaz as checagens do `/dl`: se o conteúdo mudou ou sumiu → 410 com o motivo e o
  job passa a `expired` (motivo em `error`).
- Upload acima do limite → 413 imediato com `maxBytes`. `GET /api/uploads/limits` (materials.upload) →
  `{maxUploadBytes, maxUploadMb, maxUploadLabel}`.

### Conteúdo e revisão

- `GET /api/content?delivered=1|0` filtra lista e calendário por entrega.
- `GET /api/content/options`: cada responsável traz `brandIds` (`null` para admin).
- Data prevista e horário são lidos no fuso de São Paulo (−03:00), inclusive no agendamento em lote.
- Comentário de equipe sem `versionId`: “Com o cliente” vai para a versão liberada (a atual só se nada foi
  liberado); nota interna vai para a versão atual. O cliente só é avisado (app, e-mail e histórico visível) quando
  a versão do comentário e o material estão liberados. Aviso de comentário em arquivo abre
  `/painel/arquivos?material=<id>#comentarios`.

### Clientes, projetos e briefings

- `POST /api/projects`, `PUT /api/projects/:id/members` e `POST /api/briefings/:id/send` respondem também
  `notified`, `emailConfigured` e `emailRecipients`.

### Visão geral, relatórios e histórico

- `GET /api/activity` inclui downloads (somente equipe; gestor só dos seus clientes): `entityType: 'download'`,
  `action: 'download.file'|'download.zip'`, `data.approval: false`, `isApproval: false`, `note`; filtráveis
  pelo tipo e presentes no CSV (“Download — não equivale a aprovação.”).
- `GET /api/admin/overview`: `paymentsFailed`; pedidos recusados contam como em aberto. Itens de
  `upcomingDeliveries` podem ser posts (`type: 'post'`, `dateKind: 'due'|'planned'`,
  `post: {plannedDate, plannedTime}`, `status.publication`); aprovados ou sem necessidade de aprovação saem da lista.
- `GET /api/portal/overview`: `billing.failedOrders` e `billing.failedAmountCents`.
- `GET /api/reports/downloads`: ZIP conta uma vez para cada material dentro dele; linhas de ZIP trazem
  `materialCount`.

## Contratos (AssinaVelox)

Contratos de aquisição (plano mensal = assinatura; serviço avulso como identidade visual =
pedido), assinados pela AssinaVelox. Regras em `docs/PLATFORM.md` §6.1.

```ts
Contract = {
  id, code /* CT-XXXXXXXX */, kind: 'subscription'|'one_off', kindLabel, title,
  status: 'sending'|'sent'|'completed'|'refused'|'expired'|'canceled'|'failed', statusLabel,
  providerStatusLabel, signatureStatusLabel /* rótulo da AssinaVelox */, displayCode /* AV-000123 */,
  verificationCode, orderId, subscriptionId, client: {id,name}, brand: {id,name}|null,
  signers: [{ role: 'client'|'metta', name, email?, status, statusLabel, signedAt, turn, isYou }],
  refusalReason, files: { original, signed, evidence } /* booleans */,
  sentAt, expiresAt, completedAt, refusedAt, expiredAt, canceledAt, createdAt, updatedAt,
  // somente equipe:
  envelopeId, step, error, attempts, cancelReason, lastSyncedAt, documentPages, createdBy
}
```

Pedidos e assinaturas ganham `contract` (resumo acima; clientes só veem depois do envio),
`contractRequired`, `contractSatisfied`, `contractWaiver` (equipe) e, para clientes,
`payBlockedReason`. `canPay` do pedido e `checkoutUrl` da assinatura respeitam o contrato.

| Método | Caminho | Notas |
| ------ | ------- | ----- |
| GET | `/api/contracts/status` | orders.view ou settings.manage → `{configured, ready, requiredBeforePayment, expiresInDays, signer, issues[], templates[{kind,version,reviewed}], webhookReceiving}` |
| GET | `/api/contracts` | orders.view; `?clientId&orderId&subscriptionId&status=open|<status>&page` |
| POST | `/api/contracts/preview` | orders.manage; mesmo corpo de `POST /api/contracts` → PDF com a faixa “Pré-visualização” (POST para que nome e e-mail de quem assina não fiquem em URLs) |
| POST | `/api/contracts` | orders.manage `{orderId|subscriptionId, brandId?, signer:{userId}|{name,email}, expiresInDays?}` → 202 `{contract}` (status `sending`; o envio roda em segundo plano). 503 sem AssinaVelox; 409 sem representante/foro, com modelo não revisado, item encerrado ou contrato em andamento |
| GET | `/api/contracts/:id` | detalhe + `timeline` |
| POST | `/api/contracts/:id/retry` | só `failed` → 202 |
| POST | `/api/contracts/:id/sync` | relê o envelope na AssinaVelox |
| POST | `/api/contracts/:id/cancel` | `{reason?}` → cancela na AssinaVelox e avisa o cliente; `{contract, warning}` |
| POST | `/api/contracts/:id/sign-session` | representante da Metta (e-mail igual ao configurado), na vez dele → `{url, sessionId, widgetOrigin, expiresAt}` |
| GET | `/api/contracts/:id/files/:kind` | `original|signed|evidence`; equipe no escopo ou cliente dono; `?download=1` para anexo |
| POST | `/api/contracts/waive` · `/unwaive` | orders.manage `{orderId|subscriptionId, reason}` |
| GET/PATCH | `/api/contracts/settings` | settings.manage: `{settings{signerName, signerEmail, signerRole, companyName, companyDocument, forum, noticeDays, expiresInDays, requiredBeforePayment}, issues, integration, templates, variables}` |
| PUT | `/api/contracts/templates/:kind` | `{title, body}` → nova versão (422 com variáveis desconhecidas) |
| POST | `/api/contracts/templates/:kind/preview` | `{title?, body?}` → PDF de exemplo (texto ainda não salvo) |
| POST | `/api/contracts/integration/test` | lista 1 envelope na AssinaVelox → `{ok, ms}` |
| POST/DELETE | `/api/contracts/integration/webhook` | conecta/remove a assinatura REST Hook (exige `APP_URL` HTTPS público) |
| GET | `/api/portal/contracts` · `/api/portal/contracts/:id` | cliente: os seus, a partir do envio |
| POST | `/api/portal/contracts/:id/sign-session` | cliente signatário, na vez dele → `{url, sessionId, widgetOrigin, expiresAt}`; outra pessoa do cliente → 403 |
| POST | `/api/portal/contracts/:id/refresh` | relê o envelope (limite de 1 a cada 3 s) |
| POST | `/api/webhooks/assinavelox` | sem sessão/CSRF; valida `X-AssinaVelox-Signature` + `X-AssinaVelox-Timestamp` antes de gravar; 204 |
| POST | `/api/portal/orders/:id/pay` | 409 `contract_required` enquanto o contrato não estiver concluído (quando exigido) |

`/api/portal/overview` ganha `contracts.awaitingSignature`.
