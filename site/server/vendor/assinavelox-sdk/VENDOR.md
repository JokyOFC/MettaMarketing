# SDK Node.js da AssinaVelox (cópia local)

Cópia do build `sdks/node/dist` do repositório da AssinaVelox, sem alterações.
O SDK não tem dependências e fala com a API REST v1 (`/api/v1`).

- Origem: `AssinaVelox-back/sdks/node/dist` (commit `3479e29`), SDK `1.0.0`, API `1.0.0`.
- Especificação: `SPEC_SHA256 = a569628f9193…` (conferido com `python tools/sdkgen/sdkgen.py check`).
- Uso na Metta: `server/services/assinavelox.js` (cliente, erros e webhooks).

Para atualizar, gere o SDK no repositório da AssinaVelox (`python tools/sdkgen/sdkgen.py generate`
e `cd sdks/node && npx tsc -p tsconfig.json`) e copie de novo `dist/*.js` e `dist/*.d.ts` para esta
pasta. Não edite os arquivos daqui: eles são gerados.
