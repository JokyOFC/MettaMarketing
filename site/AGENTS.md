# Continuidade do projeto Metta

Antes de alterar a interface, leia `DESIGN_SYSTEM.md`.

- Preserve React + Vite e reutilize os componentes em `src/components`.
- A fonte visual é `src/tokens.css`; não crie paletas concorrentes em novas telas.
- Reutilize `src/Logo.jsx`. O corte diagonal do m é intencional e deve ser preservado.
- Conteúdos comerciais compartilhados ficam em `src/data/brand.js`.
- A área do cliente (`/painel`) e o painel da Metta (`/admin`) são um produto real com backend em `server/`. Leia `docs/PLATFORM.md` (arquitetura, papéis, regras de autorização, estados), `docs/API.md` e `docs/FRONTEND.md` antes de mexer neles.
- Toda rota do servidor verifica sessão, capacidade e escopo com `server/lib/access.js`; IDs fora do escopo respondem 404. Clientes nunca recebem notas internas, comentários internos, rascunhos nem chaves de armazenamento. A separação é feita na API, não só na interface.
- Arquivos ficam em armazenamento privado e só saem por link temporário, com autorização verificada a cada prévia, download e ZIP. Download nunca conta como aprovação.
- Nunca persistir senhas em texto (hash scrypt) nem inventar números: telas de dados mostram só o que existe no banco.
- Contas de desenvolvimento ficam em `server/scripts/seed-dev.js` e nunca rodam em produção.
- Conclua com `npm test`, `npm run build` e, para fluxos de interface, `node e2e/flows.mjs` (desktop e `--mobile`) com os servidores de desenvolvimento no ar.
- Respeite mobile, teclado e `prefers-reduced-motion`.
- Teste os fluxos modificados e conclua com `npm run build`.
