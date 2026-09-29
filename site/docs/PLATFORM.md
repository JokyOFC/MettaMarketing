# Plataforma Metta — arquitetura e regras

Documento canônico da área do cliente e do painel administrativo. Complementa
`DESIGN_SYSTEM.md` (identidade) e `docs/API.md` (contrato HTTP). O esquema do banco
está em `server/db/migrations/001_init.sql`.

## 1. Visão geral

- **Frontend:** o mesmo app React 19 + Vite + React Router do site. O produto vive em
  `src/app/`. Área do cliente em `/painel/*`; painel da Metta em `/admin/*`.
- **Backend:** Node.js 22+ (ESM), Express 5, em `server/`. Banco MySQL 8.0.23+ via `mysql2`
  (pool, acesso assíncrono; `DATABASE_URL`), regras em §4.1. Arquivos em armazenamento
  privado (`DATA_DIR/storage`), nunca servidos como estáticos.
- **Desenvolvimento:** `npm run dev` (Vite, porta 5173) + `npm run dev:api` (API, porta 8787).
  O Vite faz proxy de `/api` e `/dl` para a API.
- **Produção:** `npm run build && npm start`. O processo Node serve `dist/`, a API e o
  fallback SPA de `/painel/*` e `/admin/*`. O site institucional continua gerando HTML
  estático por rota.
- **Testes:** `npm test` (node:test) sobe a API em porta efêmera com `DATA_DIR`
  temporário e um banco MySQL próprio por servidor de teste (`metta_test_*`, criado e
  apagado pelos testes) no servidor de `TEST_DATABASE_URL` ou `DATABASE_URL`.

### Estrutura

```
server/
  index.js            entrada: carrega config, migra, inicia workers, escuta
  app.js              monta middlewares e routers (createApp({config}) para testes)
  config.js           variáveis de ambiente e padrões
  db/                 connection.js (pool mysql2 + transações), migrate.js, migrations/, seed.js
  lib/                núcleo compartilhado (ver §4)
  routes/             um router por domínio (ver §9, dono de cada arquivo)
  services/           regras de domínio reutilizáveis entre routers
  jobs/               filas em processo: renditions (prévias), zips, emails
  scripts/            create-admin.js, seed-dev.js
  test/               helpers.js + *.test.js
src/app/
  api/                client.js, upload.js, downloads.js
  auth/               AuthProvider, RequireAuth, páginas de acesso
  ui/                 kit visual + app.css + status.js + format.js
  shell/              AppShell (sidebar, topbar, notificações, menu mobile)
  shared/             visualizadores compartilhados (material, carrossel, vídeo, comentários)
  client/             páginas da área do cliente
  admin/              páginas do painel da Metta
  routes.jsx          rotas de /painel e /admin
```

## 2. Papéis e permissões (menor acesso necessário)

| Papel      | Escopo de dados                                                        |
| ---------- | ---------------------------------------------------------------------- |
| `admin`    | Tudo.                                                                  |
| `manager`  | Clientes em `staff_client_access` e tudo abaixo deles.                 |
| `designer` | Projetos em `project_members`; leitura das marcas desses projetos e de todos os materiais dessas marcas (para usar logos e referências); escrita só nos materiais dos seus projetos ou criados/atribuídos a ele (`created_by`/`owner_id`). |
| `finance`  | Dados comerciais de todos os clientes (planos, pedidos, assinaturas, pagamentos). Sem arquivos. |
| `client`   | Somente o próprio `client_id`, suas marcas e o que foi **liberado**.  |

Capacidades (`server/lib/permissions.js`, espelhadas no frontend por `/api/auth/me`):

```
clients.view  clients.create  clients.edit  brands.edit
team.view  team.manage  categories.manage  settings.manage
services.view  services.manage  orders.view  orders.manage  finance.view
projects.view  projects.manage  tasks.manage
materials.view  materials.upload  materials.edit  materials.release  materials.archive
content.view  content.manage  content.publication
approvals.view  comments.internal
briefings.view  briefings.manage
reports.view  reports.finance  activity.view
portal.access
```

- admin: todas, exceto `portal.access` (marca exclusiva do cliente).
- manager: clients.view, brands.edit, team.view, services.view, projects.*, tasks.manage,
  materials.*, content.*, approvals.view, comments.internal, briefings.*, reports.view,
  activity.view. **Não** cria clientes (clients.create é só do admin), não gerencia equipe,
  não vê financeiro.
- designer: clients.view (básico, escopo dos projetos), projects.view, tasks.manage,
  materials.view, materials.upload, materials.edit, content.view, content.manage,
  comments.internal, briefings.view, activity.view (escopo). **Não** libera ao cliente.
- finance: clients.view, services.view, services.manage, orders.view, orders.manage,
  finance.view, reports.finance.
- client: portal.access.

### Regras de autorização (inegociáveis)

1. Toda rota verifica a sessão e a capacidade **e** o escopo do registro. Use os helpers de
   `server/lib/access.js`; nunca confie em IDs vindos do cliente.
2. Registro fora do escopo responde **404** (`not_found`), não 403, para não revelar
   existência. 403 só quando o usuário vê o registro mas não pode executar a ação.
3. Download, geração de ZIP, prévia/miniatura e streaming de vídeo verificam autorização
   **a cada requisição**, inclusive no resgate do link temporário.
4. Cliente vê um material somente se: `brand.client_id = user.client_id`,
   `visibility = 'released'`, `archived_at IS NULL` e `released_version_id` não nulo.
   Versões visíveis ao cliente: `released_at IS NOT NULL`. Arquivos visíveis:
   `original`, `final`, `cover` e `editable` somente se `editable_included = 1`.
5. Cliente baixa somente se `download_enabled = 1`. Fonte (`media_kind = 'font'`) só é
   baixável se uma fonte da marca **liberada** (`brand_fonts.visibility = 'released'`) vinculada
   ao material estiver com `distribution = 'allowed'` (`font_distributable = 1`, recalculado por
   `syncFontDistribution` na liberação, ocultação, edição e remoção; arquivos novos seguem a
   mesma regra em `attachUploads` e nas cópias de versão — §4.1); caso contrário, mostrar
   referência/link oficial. Fonte em rascunho nunca libera arquivos.
6. Notas internas (`internal_notes`), comentários `visibility = 'internal'`, `storage_key`,
   dados de equipe, `visibility` de rascunho e histórico interno **nunca** aparecem em
   respostas para o papel `client`. A separação é feita no serializador do servidor
   (`server/lib/serialize.js` e serializadores de cada domínio), não na interface.
7. Arquivos enviados começam `visibility = 'draft'`. Só `materials.release` (admin/gestor)
   libera, sempre com resumo prévio (`POST /api/releases/preview`). O mesmo vale para a
   identidade da marca: cores, tipografias **e orientações de uso/tipografia** começam como
   rascunho da equipe (orientações: colunas `*_guidelines_draft`, `lib/guidelines.js`; o cliente
   recebe só `usage_guidelines`/`typography_guidelines`, o texto liberado) e chegam ao cliente
   por `POST /api/brands/:id/identity/release`, com resumo no diálogo "Liberar identidade".
   Depois de liberados, alterar o que o cliente vê (nome, códigos, uso, família, pesos, link
   oficial, licença, arquivos vinculados), ocultar ou remover cores e tipografias também exige
   `materials.release`; designers editam só rascunhos.
8. Download nunca altera status de aprovação. Aprovação registra quem, quando e qual
   versão (`approvals`). Nova versão liberada volta `approval_status` para `pending`.

### 2.5 Como uma pessoa ganha acesso

- **Convite** (equipe e clientes criados pela Metta): o acesso nasce `invited` e a pessoa
  define a senha pelo link `/convite/:token`.
- **Cadastro pelo site** (`/cadastro`, `routes/signup.js`), aberto enquanto
  `signupEnabled` estiver ligado em Configurações › Organização: a pessoa cria a empresa
  (`clients.source = 'signup'`, sem marcas nem gestores) e o próprio acesso (`client`,
  `pending`), com aceite LGPD (`users.terms_accepted_at`). O acesso só funciona depois do
  link `/confirmar-email/:token` (48 h, uso único; a página confere o link e ativa pelo
  botão, nunca ao abrir). Na confirmação, a pessoa entra e os administradores recebem o
  aviso `client.signed_up`; a equipe então cria marcas, gestores, pedidos ou planos.
- Proteções do cadastro: respostas iguais para e-mail novo ou já cadastrado (o dono de uma
  conta existente recebe um aviso de tentativa), campo-armadilha para robôs, limite por IP
  e reenvio de link no máximo a cada minuto. Sem SMTP, o link fica só na caixa de saída
  (Configurações › E-mails, com o link oculto) — em produção, configure o SMTP antes de
  abrir o cadastro.

## 3. Estados — não confundir

Um material tem três eixos independentes:

- **Visibilidade** (`materials.visibility`): `draft` → `internal_review` → `released`
  (+ `archived_at`).
- **Aprovação** (`materials.approval_status`, refletindo a versão liberada):
  `none` | `pending` | `changes_requested` | `approved`. Materiais com
  `requires_approval = 0` (ex.: logo final do kit) ficam `none`.
- **Publicação** (somente posts, `post_details.publication_status`):
  `not_scheduled` | `scheduled` | `published`. Marcado **manualmente** pela equipe, com
  autor e data. Sem integração com redes, nada é marcado como publicado automaticamente.
- **Entrega**: `materials.delivered_at` (arquivos finais disponibilizados).

Rótulos oficiais (pt-BR) ficam em `src/app/ui/status.js`:

| Chave                       | Rótulo                    |
| --------------------------- | ------------------------- |
| visibility.draft            | Rascunho                  |
| visibility.internal_review  | Revisão interna           |
| visibility.released         | Liberado                  |
| approval.pending            | Aguardando aprovação      |
| approval.changes_requested  | Ajustes solicitados       |
| approval.approved           | Aprovado                  |
| publication.scheduled       | Agendado                  |
| publication.published       | Publicado                 |
| delivered                   | Entregue                  |
| archived                    | Arquivado                 |

Versões (`material_versions.status`): `draft`, `internal_review`, `released`,
`changes_requested`, `approved`, `superseded` (substituída por versão mais nova liberada).

## 4. Núcleo do servidor (`server/lib`)

| Arquivo          | Responsabilidade |
| ---------------- | ---------------- |
| `ids.js`         | `newId(prefix)` → `prefix_` + 16 chars base64url. Prefixos: usr cli brd prj tsk cmp cat upl mat ver fil col fnt kit cmt apr rel zip dle brf ntf eml ord sub pay whk ses svc. |
| `time.js`        | `now()` ISO, helpers de data. |
| `errors.js`      | `HttpError(status, code, message, fields?)`, atalhos `notFound()`, `forbidden()`, `badRequest()`, `conflict()`, `validation(fields)`; middleware de erro que responde `{error:{code,message,fields?}}` e nunca vaza stack em produção. |
| `validate.js`    | zod + `parse(schema, data)` → lança `validation` com campos em pt-BR. |
| `auth.js`        | hash scrypt (`scrypt$N$r$p$salt$hash`), sessões (cookie `metta_sid` httpOnly, SameSite=Lax, Secure em produção, 14 dias deslizantes, token guardado como sha256), tokens de convite/redefinição/confirmação de e-mail (`issueToken(ctx, userId, 'invite'|'reset'|'verify', ttlHours)`), rate limit de login (5 falhas por e-mail+IP desde o último sucesso + 30/15 min por IP), middleware `requireAuth`, `requireRole(...roles)`, `requireCap(...caps)` (passa com **qualquer** uma), `requireStaff`, `requireClient`. |
| `csrf.js`        | **Toda** requisição que altera estado (qualquer método fora GET/HEAD/OPTIONS, em qualquer caminho) exige header `X-Metta-Request: 1` e `Origin` compatível quando presente. Única exceção: `POST /api/webhooks/mercadopago` (casamento exato, sem diferenciar maiúsculas), que valida a assinatura. `app.js` responde 404 a prefixos `/API`, `/Dl`… (o roteamento do Express não diferencia maiúsculas) e aplica `Cache-Control: no-store` a `/api` e `/dl` em qualquer grafia. |
| `permissions.js` | Mapa papel → capacidades; `can(user, cap)`, `capabilitiesFor(role)`. |
| `access.js`      | Escopo (aceitam `req`): `getScope(req)`; `assertClient`, `assertBrand`, `assertProject`, `assertMaterial(req, id, {write})`, `assertVersion(req, id, {write})` (linha + `.material` não enumerável), `assertFile(req, id, {download, write})` (linha + `.version` e `.material`; `download` aplica 403 `download_disabled`/`font_license`) — retornam a linha ou lançam 404; `canWriteMaterial`, `clientCanSeeMaterial`, `clientCanSeeFile`, `downloadRule`; `scopeSql.clients|brands|projects|materials(req ou user, alias)` → `{sql, params}` para listas; `clientMaterialFilter`, `clientVersionFilter`, `clientFileFilter` com as regras do §2.4. |
| `audit.js`       | `logActivity(req | ctx, {action, entityType, entityId, clientId, brandId, projectId, materialId, summary, data, visibility})`. |
| `notify.js`      | `notify(req | ctx, userIds, {type, title, body, link, entityType, entityId, email, emailLines, actionLabel, includeSelf})` cria notificações (pula quem executou a ação, salvo `includeSelf`) e enfileira e-mails respeitando `notify_email`; destinatários: `clientUserIds(db, clientId)` (= `usersForClient`), `managerIdsForClient(db, clientId)`, `adminIds(db)`, `staffIdsForMaterial(db, material)`, `staffForBrand(db, brandId)`. |
| `mailer.js`      | SMTP via nodemailer quando configurado; senão grava no `email_outbox` como `not_configured` (visível em Configurações). Nunca finge envio. `send(msg)` grava e entrega (resolve com o resultado); `enqueue(msg)` grava na hora — dentro da transação em curso — e entrega depois do commit, sem esperar (avisos, links de senha). `isConfigured()`, `retry(id)`, `idle()`. Modelo HTML em `emails.js` (`renderEmail`). |
| `storage.js`     | `ctx.storage`: `putStream(readable, {maxBytes})`, `putBuffer(buffer)`, `putFile(path, {move})`, `put(buffer|readable)` → `{key,size,sha256}`; `createReadStream(key, {start,end})`, `stat`, `exists`, `remove`, `tmpPath()`, `usage()`. Driver local em `DATA_DIR/storage`. Chaves opacas; apagar só com `removeStorageIfUnreferenced` (§4 serviços), pois vários registros compartilham a mesma chave. |
| `signed.js`      | `ctx.signer`: links temporários HMAC-SHA256 (`APP_SECRET`): `sign({t:'file'|'zip', id, u:userId}, ttlSec=300)` → token; `issue(payload, ttl)` → `{token, url:'/dl/<token>', expiresAt}`; `verify(token)` → payload, `{expired:true,…}` ou null. O resgate exige a mesma sessão do `u` **e** nova checagem de acesso. |
| `media.js`       | Allowlist de extensões, `checkSignature`, `inspect` (sharp para imagem, ffprobe opcional), `sanitizeFilename`, `safeSegment` (pastas de ZIP), `formatLabel`, `COMPRESSED_EXTS`. |
| `serialize.js`   | Serializadores base (`serializeMe`, `serializeUser`, `serializeClient`, `serializeBrand`, `serializeCategory`, `serializeActivity`, `serializeNotification`, `userRef`, `personRef`, `brandRef`); `isStaff(req)`; removem campos internos para clientes. Arquivos, versões e materiais: `services/materials.js`. |
| `http.js`        | `contentDisposition(filename)` RFC 5987, `fileHeaders` (nosniff; `sandbox` exceto PDF inline; SVG/HTML/texto sempre como anexo), `sendStoredFile(req, res, storage, key, {mime, size, filename, disposition, cache})` com Range 206/416 (= `sendFileRange`). |
| `settings.js`    | `getSettings(db)`, `getSetting(db, key)`, `setSetting(db, key, value, userId)` (valores JSON). |
| `guidelines.js`  | Orientações da marca rascunho → liberado: `guidelineDraft(row)` (texto de trabalho e o que difere do liberado), `saveGuidelineDraft(db, row, {usage, typography}, {userId, at})` (grava só o rascunho) e `releaseGuidelines(db, row, {userId, at})` (usado pela liberação de identidade). |
| `validate.js`    | zod `z`, `parse(schema, data)`, `schemas.*`, `paginate(query)`, `queryBool`, `queryList`. |

Serviços de domínio compartilhados (`server/services`):

- `materials.js` — carregar material + versões + arquivos, criar versão a partir de uploads,
  regras de transição, `clientVisibleFiles`, montagem de caminhos de ZIP. Nomes exportados
  (contrato entre fatias): `MATERIAL_SELECT`, `listMaterials(req, filters, {page, pageSize})`,
  `loadMaterialRows(db, ids)`, `serializeMaterials(req, rows)`, `getMaterialDetail(req, id)`,
  `serializeVersion`, `serializeFile`, `isFileDownloadable`, `loadRenditions`,
  `visibleFilesForVersion(req, material, versionId)`, `clientVisibleFiles(material, files)`,
  `sortFiles`, `createMaterial(req, input)` → id, `createVersion(req, materialId, input)` → id
  (409 enquanto a versão atual for rascunho/revisão interna), `attachUploads(req, {materialId,
  versionId, files})`, `removeStorageIfUnreferenced(ctx, key)`, `zipEntries(req, rows,
  {layout, root, includeEditables})` e `zipFilename(marca, escopo, data)` (§5).
- `renditions.js` — gera `thumb` (480 px) e `preview` (1600 px) em WebP com sharp para
  imagens e SVG (rasterizado — SVG enviado por usuário nunca é servido inline), `poster`
  de vídeo via ffmpeg quando disponível. Sem ffmpeg: `preview_status = 'unsupported'` e a
  equipe pode enviar uma capa (`role = 'cover'`). PDF: sem conversão; mostra cartão do
  documento ou capa enviada.
- `zips.js` — fila em processo; progresso real por bytes; `store` para formatos já
  comprimidos; expira em 24 h; jobs em execução num reinício viram `failed` com mensagem.

### 4.1 Banco de dados (MySQL)

- **Versão:** MySQL 8.0.23 ou mais novo (colunas `INVISIBLE`, `JSON_TABLE`, `CHECK`,
  `DEFAULT (expressão)` e `INSERT … AS alias ON DUPLICATE KEY UPDATE`). Conexão por
  `DATABASE_URL=mysql://usuario:senha@host:3306/banco` (`?ssl=true` para TLS) e
  `DB_POOL_SIZE` (padrão 10). Na primeira subida o banco é criado se o usuário puder; as
  migrações (`server/db/migrations/*.sql`) rodam sozinhas na inicialização. DDL no MySQL
  não é transacional: uma migração que falhe no meio precisa de conferência manual.
- **API (`ctx.db`):** tudo é assíncrono — `await db.get/all/run(sql, [params])`
  (`run` → `{changes, lastInsertRowid}`, `changes` conta linhas encontradas), `db.exec`,
  `await db.tx(async () => …)`. Parâmetros só posicionais (`?`); objetos precisam de
  `JSON.stringify`. Uma lista `IN ()` vazia vale como conjunto vazio (como no SQLite).
- **Transações:** as de nível superior rodam uma por vez no processo (equivalente ao
  `BEGIN IMMEDIATE` do SQLite), com `SAVEPOINT` para as aninhadas e nova tentativa em
  deadlock. Qualquer `db.*` chamado dentro de `db.tx`, mesmo por funções auxiliares, usa a
  conexão da transação. `db.afterCommit(fn)` roda depois do commit (descartado no
  rollback); `ctx.jobs.enqueue` chamado dentro de uma transação só começa depois do
  commit; e-mails de aviso usam `ctx.mailer.enqueue` (gravados na transação, entregues
  depois).
- **Esquema:** tabelas InnoDB `utf8mb4_bin` (comparação e ordem exatas, como o app
  espera); `users.email` e `login_attempts.email` comparam sem diferenciar maiúsculas
  (`utf8mb4_0900_as_ci`). Buscas de texto usam `LIKE ? COLLATE utf8mb4_0900_ai_ci`
  (ignoram maiúsculas e acentos) e listas por nome ordenam com a mesma collation.
  Datas são texto ISO-8601 UTC. `seq` (AUTO_INCREMENT invisível) desempata ordens por
  criação. `settings.name` e `brand_colors/brand_fonts.usage_notes` evitam palavras
  reservadas do MySQL.
- **Regras que o MySQL não expressa** ficam no código: um contrato vivo por pedido ou
  assinatura (verificado dentro da transação de criação), papel `client` ⇔ `client_id` e
  a licença de fontes em arquivos novos (`attachUploads` e cópias de versão). Não há
  gatilhos (hospedagens compartilhadas costumam recusar `CREATE TRIGGER`).
- **Backup:** banco (`mysqldump --single-transaction`) **e** `DATA_DIR/storage` — um não
  serve sem o outro.

## 5. Estrutura dos ZIPs

- Raiz: nome da marca (sanitizado).
- Área identidade: `Marca/Identidade visual/<pasta da categoria>/<FORMATO>/<arquivo>`,
  por exemplo `Metta/Identidade visual/Logos/PNG/logo-principal.png`. Editáveis:
  `Marca/Identidade visual/<pasta>/Editáveis/<arquivo>`.
- Área conteúdo, posts: `Marca/Conteúdo/<AAAA-MM>/<Campanha ou "Sem campanha">/<título>/NN-<arquivo>`
  (NN = posição do slide, dois dígitos). Mês = `planned_date` ou `released_at`.
- Área conteúdo, outros: `Marca/Conteúdo/<pasta da categoria>/<arquivo>`.
- Outras áreas: `Marca/Materiais/<pasta da categoria>/<arquivo>`.
- Carrossel isolado: `Marca - <título>/NN-<arquivo>` na ordem dos slides.
- Pacote de projeto: `Marca - <Projeto>/` com a mesma estrutura por área.
- Arquivos incluídos por material: finais (`final`) se existirem, senão originais
  (`original`) da versão visível; editáveis quando incluídos no serviço. Capas não entram.
- Colisões de nome recebem ` (2)`, ` (3)`… Nomes de ZIP:
  `<marca>-<escopo>-AAAA-MM-DD.zip` (um material só: `<marca>-<título>-AAAA-MM-DD.zip`).
- Datas de nome de ZIP e pastas de mês usam o dia no fuso de São Paulo (`localDay()`), não UTC:
  um post liberado às 23h30 do último dia do mês fica na pasta daquele mês.
- Implementação: `zipEntries(req, rows, {layout: 'library'|'carousel', root, includeEditables})`
  em `services/materials.js` recebe linhas já autorizadas (`loadMaterialRows` depois dos
  `assert*`/`scopeSql`) e devolve `{fileId, materialId, versionId, storageKey, path, sizeBytes,
  ext, role, store}` em ordem estável (categoria, data, ordem manual). Versão usada: cliente, a
  liberada; equipe, a atual. Para clientes, só entram arquivos baixáveis (`download_enabled`,
  licença de fonte). `root` padrão = nome da marca; carrossel e pacote de projeto passam
  `"<Marca> - <título|projeto>"`. `store: true` para formatos já comprimidos.
  `zipFilename(marca, escopo)` gera o nome do arquivo.

## 6. Integrações

- **E-mail:** `SMTP_URL` ou `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS`, `MAIL_FROM`.
  Sem configuração, e-mails ficam no outbox como `not_configured` e a interface diz isso.
- **Mercado Pago:** `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_API_BASE` (padrão
  `https://api.mercadopago.com`, sobrescrito nos testes). Pagamento avulso via
  Checkout Pro (`/checkout/preferences`), assinatura via `/preapproval`. Webhook em
  `POST /api/webhooks/mercadopago` valida `x-signature` **antes de gravar** e **consulta a API**
  para confirmar o status antes de alterar qualquer pedido. Notificações sem assinatura válida
  ficam no log (`webhook_events`) só como metadados, sem payload, até 20 por IP a cada 10 min
  (acima disso: 429, nada gravado); o log mantém as 200 rejeições mais recentes (e nenhuma com
  mais de 30 dias) e entregas assinadas já processadas por 365 dias (`pruneWebhookEvents`).
  Sem credenciais, o módulo mostra "Mercado Pago não configurado" e não gera cobranças.
- **AssinaVelox (contratos):** `ASSINAVELOX_API_URL` (termina em `/api/v1`), `ASSINAVELOX_TOKEN`,
  opcionalmente `ASSINAVELOX_WEBHOOK_SECRET`, `ASSINAVELOX_SYNC_MINUTES` (padrão 5) e
  `ASSINAVELOX_TIMEOUT_MS`. Detalhes em §6.1.
- **URLs:** `APP_URL` (links de e-mail e retorno do checkout). `APP_SECRET` obrigatório em
  produção (em desenvolvimento é gerado e salvo em `DATA_DIR/.secret`).
- **Limites:** `MAX_UPLOAD_MB` (padrão 1024).
- **Build servido:** `DIST_DIR` (padrão `dist/`). O servidor responde `/painel/*`, `/admin/*`,
  `/convite/:token`, `/redefinir-senha/:token` e `/confirmar-email/:token` com o HTML da seção
  (status 200).

### 6.1 Contratos com a AssinaVelox

Quando um cliente adquire um **plano mensal** (assinatura) ou um **serviço avulso** como a
identidade visual (pedido), a Metta gera o contrato e o envia para assinatura na AssinaVelox.

- **Modelos versionados** (`contract_template_versions`, um por tipo: `subscription` e
  `one_off`). Marcação simples (`# cláusula`, `- item`, `**negrito**`, `{{variável}}`; `{{itens}}`
  sozinho vira a lista de itens do serviço), sem HTML nem código. O modelo inicial vem com a
  plataforma e **precisa ser revisado e salvo** por alguém da Metta (Configurações › Contratos)
  antes do primeiro envio. Variáveis desconhecidas são recusadas.
- **PDF da Metta** (`services/contractPdf.js`, pdf-lib + fontkit): Raleway, Manrope e Cormorant
  embutidas, logo vetorial, bloco de assinaturas na última página. O canto inferior direito de
  cada página fica livre para as rubricas automáticas da AssinaVelox. O PDF enviado é guardado
  (`document_key`); mudar o modelo depois nunca altera um contrato já gerado.
- **Envio em segundo plano** (`jobs/contracts.js`, fila `contracts.send`): cria o envelope, envia o
  PDF, espera o processamento, define os participantes (contratante primeiro, depois a Metta,
  ordem sequencial), posiciona assinatura e data de cada um e envia. Criações usam
  `Idempotency-Key` e cada etapa confere o estado do envelope, então tentar de novo depois de
  uma falha nunca duplica nada. Falha → `failed` com a mensagem em pt-BR e "Tentar de novo".
- **Estado sempre pela API:** webhooks (`POST /api/webhooks/assinavelox`, HMAC-SHA256 sobre
  `"{timestamp}.{corpo}"`, janela de 5 min, conferido **antes** de gravar; entregas duplicadas
  ignoradas pelo `X-AssinaVelox-Delivery-Id`) só dizem qual contrato reler. A releitura
  (`GET /envelopes/{id}`) atualiza participantes e status; na conclusão, o PDF final e a página de
  evidências vão para o armazenamento privado. Uma consulta periódica (`ASSINAVELOX_SYNC_MINUTES`)
  cobre notificações perdidas e instalações sem endereço HTTPS público.
- **Notificações:** a Metta conecta as notificações em Configurações › Contratos
  (`POST /webhook-subscriptions` da AssinaVelox; o segredo devolvido uma única vez é guardado
  cifrado com uma chave derivada de `APP_SECRET`). Alternativa: cadastrar o endpoint à mão na
  AssinaVelox e definir `ASSINAVELOX_WEBHOOK_SECRET`.
- **Assinatura dentro da plataforma:** sessão embutida da AssinaVelox para a pessoa certa (e-mail
  da sessão igual ao do signatário) e na vez dela. O host do protocolo `postMessage` é nosso
  (`src/app/shared/contracts/EmbeddedSigning.jsx`): o iframe abre sem o fragmento `#t=`, o token
  vai por mensagem só para a origem da AssinaVelox e é esquecido; mensagens só da origem, do
  nosso iframe, `v=1` e mesma sessão. O aviso `completed` do widget é só uma dica: o servidor
  confirma na API. A origem da plataforma (`APP_URL`) precisa estar cadastrada na AssinaVelox
  (API e integrações › Widget de assinatura). O convite por e-mail continua valendo.
- **Pagamento depois da assinatura** (configurável, padrão ligado, só com a integração
  configurada): o cliente não abre o checkout do pedido nem vê o link de autorização da
  assinatura até o contrato ficar `completed`. A equipe pode **dispensar** o contrato de um item
  (com motivo, no histórico), por exemplo quando foi assinado fora da plataforma.
- **Vocabulário honesto:** a AssinaVelox registra **aceite eletrônico com evidências**; a
  plataforma mostra o rótulo que a própria AssinaVelox devolve (`signature_status_label`) e diz
  "Concluído", nunca "assinatura digital" genérica.
- **Isolamento:** contratos seguem o escopo de clientes (equipe com `orders.view`); clientes só
  veem os seus, depois de enviados. Arquivos saem por `/api/contracts/:id/files/:tipo` com
  checagem a cada requisição.
- **SDK:** cópia do SDK Node da AssinaVelox em `server/vendor/assinavelox-sdk` (ver `VENDOR.md`).

## 7. Experiência visual do produto

Segue `DESIGN_SYSTEM.md`, adaptado à produtividade.

- Tokens em `src/tokens.css`; o produto acrescenta tokens `--app-*` em `src/app/ui/app.css`
  derivados deles. Não criar paletas concorrentes.
- Raiz `.app` isola o produto dos estilos editoriais (ex.: `h2` do site é enorme).
- Títulos de página do painel: Raleway 300, 28–40 px; títulos de card 18–24 px;
  Manrope 400/500 para interface, 12–15 px; Cormorant itálico só em destaques
  pontuais (uma palavra do título, índices, números de etapa).
- Linhas de 1 px, cards retangulares (raio 2–6 px), botões primários em cápsula,
  inputs com raio 4 px. Ícones `lucide-react` com `strokeWidth={1.4}`, 16–20 px.
- Sidebar oliva profunda; conteúdo em off-white. Estados discretos, sempre com texto.
- Prévias de logo em fundo claro, escuro e quadriculado (transparência).
- Miniaturas com proporção real (`aspect-ratio` a partir de width/height).
- Movimento: 150–300 ms (`--app-fast: 150ms`, `--app-base: 220ms`, `--app-slow: 300ms`),
  curva `var(--metta-ease)`. Entrada discreta de cards (stagger ≤ 40 ms, no máximo 8 itens),
  hover sutil, modais/painéis laterais fluidos, feedback de cópia, confirmação visual ao
  aprovar/salvar, skeletons somente em carregamentos reais. Sem loading de tela cheia a
  cada ação, sem animação contínua, sem parallax em tabelas.
- `prefers-reduced-motion: reduce` desliga transformações e transições longas.
- Tudo funciona por teclado e toque; nada depende de hover. Alvos de toque ≥ 44 px no
  celular. Tabelas viram cartões em telas estreitas.
- Nada de números inventados: estados vazios explicam o próximo passo.

## 8. Ambiente de desenvolvimento

- MySQL local: `DATABASE_URL=mysql://usuario:senha@127.0.0.1:3306/metta` no `site/.env`.
  O mesmo usuário precisa criar e apagar bancos `metta_test_*` para `npm test`
  (ou use `TEST_DATABASE_URL` com outro usuário). Os testes leem só essas duas chaves do
  `.env`; o resto (AssinaVelox, SMTP…) nunca vaza para eles.
- `npm run seed:dev` cria contas de teste (senhas em `server/scripts/seed-dev.js`,
  somente fora de produção) e dados mínimos para testar os fluxos.
- API em outra porta (ex.: 8787 ocupada): `PORT=0` (ou outra) na API e
  `METTA_API_URL=http://127.0.0.1:<porta>` ao iniciar o Vite, que passa a fazer proxy para ela.
- Critérios de aceite pela interface real (Chrome headless via CDP, sem dependências):
  `node e2e/flows.mjs --base http://127.0.0.1:5173 [--mobile] [--reduced] [--shots <pasta>]`
  com os dois servidores de desenvolvimento no ar e `seed:dev` aplicado. Cada execução cria
  o próprio cliente, marca, projeto e materiais (nomes com carimbo de hora). Por padrão
  nenhuma senha é digitada: as sessões são criadas no banco de desenvolvimento
  (`DATABASE_URL` do `.env`; só MySQL local é aceito) e revogadas
  no fim (`--auth ui` usa o formulário de login e o convite). Falha em erro de console,
  resposta 4xx/5xx inesperada ou rolagem horizontal. Detalhes no topo de `e2e/flows.mjs`.
- Cadastro pelo site: `node e2e/signup.mjs --base http://127.0.0.1:5173 [--mobile] [--shots <pasta>]`
  preenche `/cadastro`, confere a mensagem de e-mail pendente no login, abre o link de
  confirmação lido da caixa de saída do banco de desenvolvimento, chega ao painel e confere o
  aviso e a marcação "Cadastro pelo site" no painel da Metta.
- Contratos com uma AssinaVelox real (local ou homologação):
  `node e2e/contracts.mjs --base http://127.0.0.1:5173 --av-log <laravel.log da AssinaVelox> [--mobile] [--shots <pasta>]`.
  A API precisa apontar para essa instância (`ASSINAVELOX_API_URL`, `ASSINAVELOX_TOKEN`), que deve
  rodar com `MAIL_MAILER=log` (os códigos de confirmação são lidos do log) e aceitar as origens
  `http://127.0.0.1:5173` e `http://localhost:5173` no widget. O script envia o contrato de um pedido
  da Aurora, assina como cliente e como Metta dentro do widget, baixa o PDF assinado e confere que o
  pagamento foi liberado. Instâncias locais não recebem webhooks (exigem HTTPS público), então o
  status chega pela sincronização periódica (`ASSINAVELOX_SYNC_MINUTES=1` ajuda nos testes).
- `npm run create-admin -- --email ... --name ...` cria o primeiro administrador em
  produção e imprime um link de convite (a senha é definida pela própria pessoa).

## 9. Divisão de propriedade (implementação paralela)

Cada fatia é dona exclusiva dos arquivos listados. Arquivos de outra fatia só podem ser
**importados**, nunca editados; necessidades cruzadas vão para o relatório final.

| Fatia | Servidor | Frontend |
| ----- | -------- | -------- |
| F — Fundação | `server/{index,app,config}.js`, `server/db/*`, `server/lib/*`, `routes/auth.js`, `test/helpers.js`, `test/{auth,access,zip-layout}.test.js`, `scripts/*` | `src/app/{api,auth,ui,shell}/*`, `src/app/routes.jsx`, `src/app/pages.js` (stubs), `src/App.jsx`, `src/pages/AuthPages.jsx`, `vite.config.js`, `package.json` |
| A — Materiais e entregas (backend) | `routes/{uploads,materials,releases,kits,files,zips}.js`, `services/{materials,renditions,zips}.js`, `jobs/*`, `test/{materials,downloads,isolation}.test.js` | — |
| B — Biblioteca administrativa | `routes/brandlib.js`, `test/brandlib.test.js` | `src/app/admin/library/*` |
| C — Minha marca e arquivos (cliente) | — | `src/app/client/brand/*`, `src/app/client/files/*` |
| D — Conteúdo, revisão e aprovação | `routes/{content,reviews}.js`, `test/{content,reviews}.test.js` | `src/app/shared/review/*`, `src/app/client/content/*`, `src/app/admin/content/*`, `src/app/admin/approvals/*` |
| E — Clientes, equipe e projetos | `routes/{clients,team,projects}.js`, `test/{clients,projects}.test.js` | `src/app/admin/{clients,team,projects}/*`, `src/app/client/projects/*` |
| G — Comercial e Mercado Pago | `routes/{commerce,webhooks}.js`, `services/mercadopago.js`, `test/commerce.test.js` | `src/app/admin/{services,orders,finance}/*`, `src/app/client/billing/*` |
| H — Briefings, notificações e configurações | `routes/{briefings,notifications,settings,categories}.js`, `test/{briefings,settings}.test.js` | `src/app/admin/{briefings,notifications,settings}/*`, `src/app/client/{briefings,notifications,account}/*` |
| I — Visão geral, relatórios e histórico | `routes/{overview,reports,activity}.js`, `test/overview.test.js` | `src/app/admin/{overview,reports,activity}/*`, `src/app/client/{overview,history}/*` |
