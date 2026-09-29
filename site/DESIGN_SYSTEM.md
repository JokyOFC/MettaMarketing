# Metta — sistema de identidade e interface

Este é o guia canônico para estender o projeto em sites, páginas, painéis, apresentações e outras peças. Preserve o caráter editorial, a clareza e o ritmo da marca. A sofisticação vem de proporção, espaço e intenção.

## 1. Essência

**Estratégias que conectam sua fintech aos clientes.**

A Metta trabalha estratégia, conteúdo e gestão, com atenção ao universo das fintechs. Sua comunicação deve transmitir confiança, proximidade e visão de negócio. Use frases claras e concretas. Não invente clientes, cases, depoimentos, certificações ou métricas comerciais.

## 2. Marca

- Componente compartilhado: `src/Logo.jsx`.
- Versão independente: `public/brand/metta-logo.svg`.
- A marca foi reconstruída a partir das referências fornecidas; não equivale a um arquivo vetorial oficial recebido da empresa.
- Nunca substitua o desenho pela palavra “metta” em uma fonte, mesmo que parecida.
- Preserve as proporções `612 × 216`, a espessura dos traços, o desenho aberto do “a” e a barra compartilhada dos dois “t”.
- **Detalhe crítico do “m”:** o pequeno segmento superior termina em diagonal, acompanhando a subida da curva. O corte é um vazio real. Não use um retângulo solto e não pinte a separação com uma cor de fundo fixa.
- O fragmento é a forma `M4.75 52H11.25V66L4.75 74Z`, em `currentColor`, sem contorno. O corpo principal não contém o antigo traço `M8 52V68`.
- Reserve uma área livre ao redor equivalente à altura de “MARKETING”.
- Para cabeçalhos, use 122–150 px de largura; no painel, 115–150 px; na abertura, até 380 px.
- Em fundos escuros, use marfim. Em fundos claros, use oliva. Não aplique gradientes, deformação, sombras pesadas ou glow ao logotipo.
- Ao colocar a marca em um link, dê ao link um nome acessível; o SVG decorativo permanece `aria-hidden`.

## 3. Cores

| Token                | Valor                | Função                                |
| -------------------- | -------------------- | ------------------------------------- |
| `--metta-olive-950`  | `#121a0e`            | Rodapé e superfícies mais profundas   |
| `--metta-olive-900`  | `#182013`            | Abertura, contatos e fundos escuros   |
| `--metta-olive-800`  | `#202619`            | Cor principal, navegação e botões     |
| `--metta-olive-700`  | `#303827`            | Destaques e plano Estratégia          |
| `--metta-paper`      | `#ede9df`            | Fundo editorial principal             |
| `--metta-paper-deep` | `#e3e0d5`            | Alternância entre seções              |
| `--metta-surface`    | `#f4f1e9`            | Cards e superfícies do painel         |
| `--metta-ink`        | `#252a20`            | Texto principal em fundo claro        |
| `--metta-muted`      | `#646858`            | Texto secundário em fundo claro       |
| `--metta-sage`       | `#aeb99a`            | Detalhes e texto secundário no escuro |
| `--metta-line`       | `rgba(42,49,31,.22)` | Divisórias e bordas claras            |

Fonte de implementação: `src/tokens.css`. Intercâmbio entre ferramentas: `design/tokens.json`. A paleta é terrosa, com alto contraste entre áreas claras e escuras. Cores de estado do painel devem ser discretas e acompanhadas por texto; não usar cor como único significado.

## 4. Tipografia

- **Raleway 200/300:** títulos amplos, leves, com respiro. Não usar para textos longos ou controles pequenos.
- **Manrope 400/500:** corpo, navegação, campos, números operacionais e controles.
- **Cormorant Garamond itálica 400:** ênfase editorial, uma frase curta por título, ou índices de etapas.
- Fontes são locais, fornecidas por `@fontsource`; não dependem de serviços de fontes externos.
- Títulos principais: 48–90 px no desktop, aproximadamente 40–48 px no mobile, com `clamp`.
- Títulos de painel: 28–40 px. Títulos de cards: 18–24 px. Números de indicadores usam algarismos alinhados (`lining-nums`).
- Corpo editorial: 14–17 px; informações operacionais: 12–15 px. Metadados menores precisam continuar legíveis; não use o tamanho de uma etiqueta para instruções importantes.
- Tracking de títulos: `-.03em` a `-.05em`; entrelinha de títulos: 1.1–1.2. Texto de corpo: entrelinha 1.65–1.85.
- Etiquetas de seção: caixa alta, tracking de `.15em` a `.23em`, frequentemente antecedidas de uma linha fina.

## 5. Composição

- Use grids simples, assimétricos quando isso ajudar a hierarquia, e grandes áreas de respiro.
- Gutter editorial: 7–8.2% da viewport; painéis operacionais podem usar 3–5%.
- Ritmo de espaçamento: 8, 16, 24, 32, 48 e 64 px.
- Bordas de 1 px e opacidade discreta. Cards retangulares, sem cantos excessivamente arredondados.
- Botões primários em formato de cápsula; inputs com cantos de 4 px. Evite transformar todo bloco em uma cápsula.
- Combine um título leve com um destaque itálico. Não coloque todos os títulos em itálico.
- Interfaces funcionais devem começar com a tarefa: login com formulário, painel com atividades e conteúdo. Não repetir a hero de marketing dentro do produto.

## 6. Imagens

- Arquitetura, luz natural, textura de parede, madeira, sombras diagonais e objetos discretos.
- Preserve áreas escuras para texto. Evite bancos de imagem genéricos de equipes sorrindo, cores saturadas ou imagens futuristas artificiais.
- Hero: cena cinematográfica em loop (`public/video/hero-*.webm|mp4`), gerada no Higgsfield (Kling 3.0, 4K) a partir da própria imagem original, usada como quadro inicial e final. A câmera faz uma paralaxe lenta e volta exatamente ao enquadramento da foto. As sombras das folhas se movem e a luz respira. O componente é `src/components/HeroScene.jsx`.
- A imagem original `public/images/hero.webp` (1920 px) e `hero-4k.webp` (3840 px) continua sendo a primeira pintura e o fallback para movimento reduzido, Save-Data e autoplay bloqueado. O vídeo entra por fade sobre ela, sem salto.
- Não trocar por uma recriação 3D que redesenhe a cena: a direção aprovada anima a foto original, com fidelidade de objetos, cores e composição. Qualquer novo vídeo precisa começar e terminar no quadro original, manter escura a área do texto à esquerda e não conter cortes.
- Institucional: `public/images/brand-original.webp`, extraída do PDF em 1672 × 941 px.
- Não reutilize a antiga imagem de 640 px em áreas grandes. Ela perdeu definição na primeira versão.
- Não sobreponha uma segunda logo sobre uma imagem que já contém a marca.
- Imagens decorativas usam `alt=""`; imagens relevantes recebem descrição sucinta. Preserve a proporção e verifique o recorte em celular.

## 7. Movimento

- Curva principal: `cubic-bezier(.22,1,.36,1)`.
- Estados pequenos: 220 ms; controles e expansões: 450–650 ms; revelações: 900–1250 ms.
- A abertura pertence ao roteador (`src/components/PageTransition.jsx`), com desenho animado dos traços da logo, assinatura, eixo e linha de carregamento na entrada direta. Nas navegações internas, manter a cortina breve com logo completo. Não montar um loader dentro de cada página.
- Na entrada direta por uma página institucional, aguardar fontes e imagem, com mínimo de 1.9 s e limite de 5 s, seguidos pela saída original de 1.15 s. Nas trocas internas, cobrir a página anterior em 480 ms, trocar o conteúdo sob a cortina e revelar em 760 ms. Não simular porcentagem de download.
- Login, cadastro e painel não recebem abertura nem cortina. Respeitar histórico, links com modificadores e preferências de movimento reduzido.
- O cabeçalho sobre a hero e sobre a seção de contato da home é transparente, sem blur. Nas demais superfícies, manter contraste com fundo sólido; o menu mobile aberto mantém fundo oliva.
- No fim da home, quando o rodapé entra na tela, o cabeçalho sobe e some (fica `inert`). Assim, o conteúdo do contato nunca passa por baixo dele. Ao rolar de volta, ele reaparece.
- O método usa título e etapas alinhados verticalmente no centro. O rodapé completo fica depois da seção de contato, com logo, assinatura, retorno ao topo e informações legais.
- A página inicial usa seis seções de `100dvh`, encaixe de scroll e avanço controlado. Um gesto não deve atravessar várias seções por inércia.
- Telas menores podem rolar o conteúdo dentro da seção até seu fim antes de avançar. Nunca cortar conteúdo para obedecer à altura da viewport.
- Setas, Page Up/Down, espaço, toque, indicador de seção e navegação por links precisam continuar utilizáveis.
- Páginas editoriais internas e o painel usam rolagem de leitura convencional; o scroll por etapas é a experiência de apresentação da home.
- Parallax com baixa amplitude; não competir com o texto. O painel privilegia respostas rápidas e previsíveis.
- Respeitar `prefers-reduced-motion`: desativar intro, parallax, animações, o vídeo da hero e scroll suave. Não esconder conteúdo nesse modo.
- O vídeo da hero só começa a baixar depois da foto e só toca depois da abertura. Ele fica mudo e pausa fora da tela ou com a aba oculta. O botão “Pausar cena”, na base da hero, desliga o vídeo e volta à foto (critério WCAG 2.2.2). A escolha fica salva no navegador. O botão não aparece quando o vídeo está desativado.
- Seleção do arquivo: o recorte vertical só vale para celular em pé (até 760 px e proporção de até 2:3). Tablets e telas maiores recebem o 16:9, com o mesmo `object-position` da foto. Ao girar o aparelho, o arquivo é trocado.
- Não animar blur em textos de leitura. Não usar animação contínua sem propósito.

## 8. Componentes reutilizáveis

| Arquivo                          | Responsabilidade                                                  |
| -------------------------------- | ----------------------------------------------------------------- |
| `src/Logo.jsx`                   | Desenho vetorial e recorte do m                                   |
| `src/tokens.css`                 | Tokens semânticos de identidade                                   |
| `src/components/SiteChrome.jsx`  | Cabeçalho, navegação, rodapé, estrutura de página, títulos e seta |
| `src/components/SectionSnap.jsx` | Scroll da home e indicador de seções                              |
| `src/data/brand.js`              | Contato, planos e etapas do método                                |
| `src/app/ui/`                    | Kit visual do produto (`app.css`, componentes, estados, formatos) |
| `src/app/shell/`                 | Estrutura da área do cliente e do painel (sidebar, topo, menus)   |
| `src/app/shared/review/`         | Visualizadores de material, carrossel, vídeo, comentários, aprovação |
| `src/style.css`                  | Base editorial original                                           |
| `src/refinement.css`             | Marca, abertura e refinamentos de movimento                       |
| `src/pages.css`                  | Páginas, telas de acesso e breakpoints do site                    |

Importe `Logo`, `PageFrame`, `PageHeading`, `SiteHeader`, `SiteFooter` e `Arrow` em vez de redesenhá-los em cada tela. O exemplo `design/PageTemplate.jsx` mostra a estrutura mínima de uma nova página.

## 9. Rotas e navegação

- `/`: apresentação em seis telas.
- `/sobre`: essência, visão e valores.
- `/solucoes`: estratégia, conteúdo e gestão.
- `/metodo`: etapas e entregas do processo.
- `/planos`: comparação completa e perguntas frequentes.
- `/contato`: canais e composição local de e-mail.
- `/login`: acesso real (sessão no servidor). `/cadastro`: explica o acesso por convite. `/convite/:token`, `/recuperar-senha`, `/redefinir-senha/:token`: primeiro acesso e senha.
- `/painel/*`: área do cliente (início, minha marca, conteúdo, arquivos, projetos, briefings, financeiro, histórico, notificações, conta).
- `/admin/*`: painel da Metta, com os 14 módulos. Rotas e donos em `docs/FRONTEND.md`.
- O build escreve um HTML por página com as tags de SEO da rota, além de `404.html` (que também carrega o app). Em Apache ou LiteSpeed, `public/.htaccess` serve `/sobre` a partir de `sobre.html`. Toda rota nova precisa de título e descrição em `src/data/seo.js`; acesso, área do cliente e painel ficam `noindex`.

## 10. Plataforma, dados e segurança

A área do cliente e o painel são um produto real, com backend em `server/`. As regras completas estão em `docs/PLATFORM.md`.

- Autenticação no servidor: sessão em cookie httpOnly, senhas com hash scrypt, convites e redefinição por link de uso único. O frontend nunca guarda senhas nem tokens.
- Cada papel vê o mínimo necessário. Clientes só veem as próprias marcas e o que a equipe liberou; IDs de outro cliente respondem como inexistentes.
- Arquivos enviados começam privados. Liberar exige resumo prévio (cliente, materiais, permissões) e pode notificar por e-mail e na plataforma.
- Notas e comentários internos ficam separados na API, não só na interface.
- Aprovado, entregue, agendado e publicado são estados distintos. Publicação só é marcada manualmente pela equipe. Download nunca conta como aprovação.
- Telas de dados mostram apenas números reais. Estados vazios explicam o próximo passo.
- Sem SMTP ou Mercado Pago configurados, a interface diz "não configurado"; nada é simulado.
- Contas de desenvolvimento (`server/scripts/seed-dev.js`) nunca rodam em produção.
- CPF e dados pessoais dos documentos societários não pertencem ao site.

### Movimento no produto

- Painel e área do cliente usam movimentos curtos, de 150 a 300 ms (`--app-fast`, `--app-base`, `--app-slow`), com a curva da marca.
- Transição discreta entre telas, entrada de cards em sequência curta, abertura fluida de menus, modais e painéis laterais, feedback ao copiar, confirmação ao aprovar ou salvar, progresso real de upload e de ZIP, skeletons só em carregamentos reais.
- Sem loading de tela inteira a cada ação, animações contínuas ou parallax em tabelas. `prefers-reduced-motion` desliga transformações e animações.

## 11. Aplicação fora do site

Para apresentações e documentos, use a mesma paleta, hierarquia de título leve + destaque itálico, linhas finas e espaço generoso. Use `public/brand/metta-logo.svg` sem deformar. Para peças estáticas, substitua movimento por uma sequência clara de leitura. Em tabelas e dashboards, priorize Manrope, contraste e alinhamento; não imite a escala de uma hero em dados operacionais.

## 12. Checklist de continuidade

1. Leia este guia e confira os tokens e componentes existentes.
2. Use conteúdo verdadeiro ou identifique exemplos claramente.
3. Preserve a marca, inclusive o corte diagonal do m.
4. Valide desktop e mobile, foco, estados vazios, erros e `reduced-motion`.
5. Confira que nenhum conteúdo foi cortado nas seções de tela cheia.
6. Execute `npm run build` e teste os fluxos alterados.
7. Atualize este guia se a decisão visual mudar de forma intencional.

## Atualização comercial

- Público: fintechs e bancos digitais. Hero: “PESSOAS MUDAM. MARCAS TAMBÉM.” / “A comunicação precisa acompanhar esse movimento.”
- Identidade visual: oferta independente de R$ 2.000 no banner junto aos planos. Não inventar entregáveis ou prazos.
- CTA dos planos: “Comprar este plano”. No site, o botão ainda informa disponibilidade futura (`src/components/Commercial.jsx`). Cobranças reais nascem no painel da Metta (pedidos e assinaturas) e são pagas pelo cliente via Mercado Pago na área do cliente; nunca informar pagamento concluído antes da confirmação do Mercado Pago.
- Reunião estratégica mensal - via call.
- Contato público por WhatsApp com ícone; omitir cidade/endereço da interface e do SEO, inclusive JSON-LD.
