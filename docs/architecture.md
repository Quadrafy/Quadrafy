# Visão de arquitetura

## Visão geral

O Quadrafy usa um frontend multipágina sem etapa de build e um backend Node.js.
Cada contexto possui um HTML próprio (`index`, `login`, painel do jogador e
painel do clube). Os scripts `dashboard-player.js` e `dashboard-club.js`
consomem a API; `app.js`, `charts.js` e `styles.css` concentram recursos
compartilhados.

O backend entrega os arquivos estáticos, protege os dashboards antes de servir
o HTML e expõe a API em `/api/v1`. O contrato completo está em `openapi.yaml`.

## Autenticação e segurança

- `POST /auth/register` cria conta e sessão.
- `POST /auth/login` autentica e rotaciona a sessão.
- `GET /auth/me` retorna a conta atual.
- `POST /auth/logout` revoga a sessão.
- Senhas usam `scrypt` com salt individual.
- Cookies são `HttpOnly`, `SameSite=Lax` e `Secure` em produção.
- Requisições mutáveis validam a origem.
- Autorização é aplicada por papel e por propriedade do recurso.
- Operações sensíveis geram auditoria com `X-Request-Id`.

## Camadas

```text
HTML/CSS/JS
    │ fetch + cookie de sessão
    ▼
Roteador HTTP e validação (backend/src/app.js)
    │
    ├── serviços de domínio e análise
    ├── stores com escrita serializada
    └── uploads locais validados
            │
            ▼
backend/data/*.json + backend/data/uploads/
```

### Stores e serviços

- `UserStore`: identidade, credenciais, papel, perfil e nivelamento.
- `ClubStore`: arena, capa, contato, endereço e status público.
- `CourtStore`: quadras, fotos, preço, funcionamento, edição e exclusão.
- `BookingStore`: reservas, pagamentos, cancelamentos, times e posições.
- `RecurringBookingStore`: reservas fixas com tombstone de exclusão.
- `MatchMessageStore`: chat persistido e paginado por partida.
- `AuditLogStore`: trilha somente de acréscimo.
- `finance-analytics`: séries diárias, ocupação, pagamentos e comparação.

## Modelo de domínio

- `User`: identidade, papel e credenciais.
- `PlayerProfile`: foto, cidade, nível e preferências.
- `Club`: dados públicos e imagem de capa.
- `Court`: tipo, preço, horários, duração e foto.
- `Booking`: horário, estado, pagamento e visibilidade.
- `OpenMatch`: a mesma reserva pública, com dois times de duas posições.
- `RecurringBooking`: bloqueio semanal ou mensal da grade.
- `MatchMessage`: mensagem vinculada a participante e partida.

Uma partida aberta não duplica a reserva. `teams`, `teamIds` e
`participantIds` são projeções sincronizadas da mesma entidade. O financeiro
também é calculado a partir das reservas, sem armazenamento agregado duplicado.

## Concorrência e integridade

Reservas avulsas, recorrências e exclusão de quadra usam a fila compartilhada da
agenda para evitar dupla ocupação durante a escrita. O armazenamento JSON atende
um único processo; a garantia deverá migrar para transações e restrições no banco
quando houver múltiplas instâncias.

Uploads são validados por tipo declarado e assinatura binária, gravados em
arquivo temporário e renomeados atomicamente. A API só permite alterar imagens
do próprio jogador ou de clubes e quadras pertencentes ao gestor autenticado.

## Evolução recomendada

1. Migrar os stores JSON para PostgreSQL com transações.
2. Mover imagens para armazenamento de objetos com URLs assinadas de escrita.
3. Adicionar recuperação e verificação de e-mail e CNPJ.
4. Integrar pagamentos Pix/cartão e webhooks idempotentes.
5. Adicionar observabilidade centralizada, backups e testes de carga.
