# Metta Marketing

Site institucional multipágina em React 19, Vite e React Router, e a plataforma da Metta: área do cliente (`/painel`) e painel administrativo (`/admin`), com backend Node.js em `server/`.

## Executar

A plataforma usa MySQL 8.0.23 ou mais novo. Coloque `DATABASE_URL=mysql://usuario:senha@127.0.0.1:3306/metta` no `.env` (o usuário precisa poder criar os bancos `metta` e `metta_test_*`, usados pelos testes).

```sh
npm install
npm run dev        # site e interface (Vite, porta 5173)
npm run dev:api    # API da plataforma (porta 8787); o Vite encaminha /api e /dl para ela
npm run seed:dev   # contas de desenvolvimento e um cliente de exemplo (nunca em produção)
```

```sh
npm test           # testes do servidor (node:test), inclusive o teste de aceitação
node e2e/flows.mjs --base http://127.0.0.1:5173            # fluxos de ponta a ponta na interface
node e2e/flows.mjs --base http://127.0.0.1:5173 --mobile   # os mesmos fluxos no celular (390 px)
npm run build
npm start          # produção: um processo Node serve dist/, a API e os arquivos privados
```

A saída de produção está em `dist`. O build gera um HTML por página (`sobre.html`, `planos.html`…) e também `404.html`, `sitemap.xml` e `robots.txt`. Assim, `/sobre` funciona no acesso direto em qualquer hospedagem com URLs limpas. O site institucional continua podendo ser publicado como estático (o `.htaccess` incluído atende Apache e LiteSpeed), mas **a área do cliente e o painel precisam do servidor Node** (`npm start`), atrás de HTTPS.

## Plataforma (área do cliente e painel da Metta)

Documentação: [docs/PLATFORM.md](./docs/PLATFORM.md) (arquitetura, papéis, autorização, estados, ZIPs, integrações), [docs/API.md](./docs/API.md) (contrato HTTP) e [docs/FRONTEND.md](./docs/FRONTEND.md) (rotas e componentes compartilhados).

- **Papéis:** administrador, gestor, designer/editor, financeiro e cliente, com acesso mínimo. Clientes só veem as próprias marcas e o que foi liberado.
- **Materiais:** envio por arrastar e soltar com progresso real, versões, rascunho, revisão interna, resumo antes de liberar, controle de download, kits, arquivo e histórico completo.
- **Minha marca:** logos em fundo claro, escuro e quadriculado, paleta com cópia de HEX, tipografia respeitando licenças, manual, editáveis e kit completo em ZIP.
- **Conteúdo:** grade, lista e calendário; carrosséis, vídeos com capa, legenda para copiar, comentários, aprovação por versão e pedidos de ajuste. Aprovado, entregue, agendado e publicado são estados distintos; publicação só é marcada manualmente.
- **Downloads:** individual, seleção, categoria, kit de marca, carrossel em ordem e pacote de projeto. ZIPs são gerados em segundo plano, com pastas organizadas e progresso real. Links temporários assinados; a autorização é verificada de novo em cada prévia, download e ZIP.
- **Contratos (AssinaVelox):** ao adquirir um plano ou um serviço avulso (como a identidade visual), a Metta gera o contrato a partir de um modelo versionado, envia pela API da AssinaVelox e acompanha as assinaturas. O cliente assina dentro da plataforma (widget embutido) ou pelo e-mail; o PDF final e a página de evidências ficam guardados. Nas cobranças criadas pela equipe, o pagamento pode esperar a assinatura (Configurações › Contratos).
- **Compra pelo site:** os botões "Comprar" de `/planos` levam ao cadastro (ou login) e a uma página de confirmação com o preço do catálogo; o cliente paga no Mercado Pago (Checkout Pro para a identidade visual, assinatura mensal para os planos) e, com o pagamento confirmado, o contrato vai sozinho para ele assinar. Cada botão é ligado a um serviço em Planos e serviços.
- **Painel da Metta:** visão geral com números reais, clientes e marcas, equipe e permissões, planos e serviços, pedidos e assinaturas, financeiro e Mercado Pago, briefings, projetos e tarefas, biblioteca, conteúdo e calendário, aprovações, relatórios, notificações e configurações.

### Configuração de produção

Copie `.env.example` para `.env` e ajuste. Obrigatórios: `NODE_ENV=production`, `APP_URL` (endereço público, HTTPS), `APP_SECRET` e `DATABASE_URL` (MySQL 8.0.23+, ex.: `mysql://metta:senha@127.0.0.1:3306/metta`; as tabelas são criadas na primeira subida). `DATA_DIR` guarda os arquivos privados: faça backup dele **e** do banco (`mysqldump --single-transaction`). E-mail (SMTP) e Mercado Pago (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`) são opcionais; sem eles a interface informa "não configurado" e nada é simulado. O webhook do Mercado Pago deve apontar para `APP_URL/api/webhooks/mercadopago`.

Contratos: defina `ASSINAVELOX_API_URL` (produção: `https://app.assinavelox.com.br/api/v1`) e `ASSINAVELOX_TOKEN` (chave criada na AssinaVelox com as permissões listadas no `.env.example`). Na AssinaVelox, cadastre o endereço da plataforma (`APP_URL`) em API e integrações › Widget de assinatura. Depois, em Configurações › Contratos: conecte as notificações, defina quem assina pela Metta e o foro, e revise e salve os modelos de contrato — o primeiro envio só é liberado depois dessa revisão.

O primeiro administrador é criado com `npm run create-admin -- --email pessoa@empresa.com --name "Nome"`; o comando imprime um link de convite para a própria pessoa definir a senha. Demais pessoas (equipe e clientes) são convidadas pelo painel.

### Contas de desenvolvimento

`npm run seed:dev` cria administrador, gestor, designer, financeiro e um cliente de exemplo ("Aurora Pagamentos"). Os e-mails e senhas de teste estão em `server/scripts/seed-dev.js`. O script se recusa a rodar com `NODE_ENV=production`.

## SEO

Títulos, descrições, canonical, Open Graph, Twitter e dados estruturados (JSON-LD) de cada rota ficam em `src/data/seo.js`, incluindo o domínio (`SITE_URL`). O mesmo arquivo alimenta o build (`vite.config.js`, HTML estático por página) e a navegação no navegador (`src/components/Seo.jsx`). Login, cadastro, painel e 404 são `noindex`. Ao criar uma página, registre a rota em `seo.js`. A imagem de compartilhamento (`public/og-image.jpg`, 1200 × 630), o logo em PNG e o `apple-touch-icon.png` foram renderizados a partir da hero, das fontes e do SVG da marca.

## Páginas

Início (`/`), A Metta (`/sobre`), Soluções (`/solucoes`), Método (`/metodo`), Planos (`/planos`) e Contato (`/contato`). A página inicial tem seis seções de tela cheia, com scroll por etapas, navegação por teclado e indicadores laterais. Em telas pequenas, conteúdo longo pode ser lido dentro da seção antes de avançar.

Login (`/login`), cadastro pelo site (`/cadastro`, a pessoa já entra na área do cliente), primeiro acesso por convite (`/convite/:token`), recuperação de senha (`/recuperar-senha`), área do cliente (`/painel/*`) e painel da Metta (`/admin/*`) pertencem à plataforma descrita acima. O cadastro pode ser fechado em Configurações › Organização; fechado, `/cadastro` explica que o acesso é por convite. O formulário comercial do site prepara uma mensagem `mailto:`; o usuário envia pelo próprio aplicativo de e-mail.

## Estilo e continuidade

Leia **[DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)** antes de criar novas páginas ou peças.

- `AGENTS.md`: orientações para futuras alterações.
- `src/tokens.css`: tokens visuais consumidos pelo projeto.
- `design/tokens.json`: versão portável dos tokens.
- `src/Logo.jsx` e `public/brand/metta-logo.svg`: logo reutilizável, com o corte diagonal do m.
- `src/components/SiteChrome.jsx`: cabeçalho, rodapé e estruturas de página.
- `design/PageTemplate.jsx`: ponto de partida para novas páginas.
- `src/data/brand.js`: contato, planos e método compartilhados.

## Hero e abertura

O hero é uma cena cinematográfica em loop gerada no Higgsfield a partir da imagem original (`src/components/HeroScene.jsx`). A câmera faz uma paralaxe lenta e volta ao enquadramento da foto. A imagem WebP responsiva continua como primeira pintura e como fallback para movimento reduzido, Save-Data e autoplay bloqueado. O parallax de rolagem vale para os dois. O botão “Pausar cena”, na base da hero, desliga o vídeo e lembra a escolha no navegador. O carregamento inicial restaura o desenho animado da logo e a assinatura. A navegação institucional mantém a cortina breve em `src/components/PageTransition.jsx`; login, cadastro e painel não usam abertura.

## Fontes e imagens

Raleway, Manrope e Cormorant Garamond, instaladas localmente via Fontsource. A marca é um desenho SVG reconstruído a partir das referências fornecidas; não foi recebido um arquivo vetorial oficial.

As imagens principais foram criadas no Higgsfield. A versão atual tem 3840 × 2160 px (job `0c6ce012-b2ef-4c09-a427-7102d15ae84c`) e é entregue em duas resoluções WebP. O vídeo da hero veio do job `944efc5b-dadd-4046-a8f3-41416e9e3e2c` (Kling 3.0, 4K, 10 s), com essa imagem como quadro inicial e final. Em `public/video` ele está em 1920 × 1080, 2560 × 1440 e em um recorte vertical de 1080 × 1920 para celulares, cada um em WebM (VP9) e MP4 (H.264), sem áudio e com o último quadro removido para o loop não repetir imagem. A imagem institucional foi extraída diretamente da capa do PDF em 1672 × 941 px.

## Origem do conteúdo

A apresentação comercial fornecida embasou posicionamento, serviços, metodologia, planos e valores. O CNPJ fornecido embasou razão social, cidade, identificação da empresa e contatos comerciais. CPF e dados residenciais pessoais não foram incluídos no site. Os materiais não continham cases comprovados; nenhum cliente, depoimento ou resultado comercial foi inventado.

## Publicação

O site continua disponível na prévia local. Não houve publicação remota: o recurso Sites ficou indisponível durante a primeira construção. O identificador de prévia registrado foi preservado em `.openai/hosting.json`.
