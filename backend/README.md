# Backend Quadrafy

Servidor Node.js sem pacotes npm de runtime. Ele entrega o frontend multipágina
e expõe a API versionada em `/api/v1`.

## Execução

```powershell
npm start
```

O endereço padrão é `http://localhost:4173`. Os comandos de verificação são:

```powershell
npm test
npm run check
```

O projeto não lê `.env` automaticamente. Exporte as variáveis no ambiente antes
de iniciar o processo.

| Variável | Padrão | Finalidade |
| --- | --- | --- |
| `PORT` | `4173` | Porta HTTP. |
| `NODE_ENV` | `development` | Use `production` para cookie seguro e HSTS. |
| `SESSION_TTL_HOURS` | `168` | Validade da sessão em horas. |
| `DATA_DIR` | `backend/data` | Diretório dos JSONs e uploads persistidos. |
| `ANTHROPIC_API_KEY` | vazio | Habilita a avaliação de nível pela Anthropic. |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Modelo de nivelamento. |
| `ANTHROPIC_BASE_URL` | API oficial | URL compatível com Messages API. |
| `ANTHROPIC_TIMEOUT_MS` | `8000` | Timeout da chamada externa em milissegundos. |

## Recursos principais

- autenticação por sessão para os papéis `player` e `club`;
- senhas com `scrypt`, validação de origem, autorização por papel e rate limit;
- perfis de jogador e clube com imagens locais persistidas;
- quadras com edição completa, duração de 60/90 minutos e exclusão confirmada;
- reservas privadas, partidas abertas com times e reservas recorrentes;
- chat restrito aos participantes;
- confirmação local de pagamento e análises financeiras;
- auditoria correlacionada por `X-Request-Id`.

## Rotas principais

Todas as rotas de painel exigem sessão e o papel correspondente.

| Método e rota | Resultado |
| --- | --- |
| `POST /api/v1/uploads/image` | Persiste uma imagem autorizada de jogador, clube ou quadra. |
| `GET /api/v1/player/profile` | Retorna o perfil completo do jogador autenticado. |
| `PATCH /api/v1/player/profile` | Atualiza campos editáveis do perfil. |
| `GET /api/v1/players/:id/profile` | Retorna somente o perfil público seguro de outro jogador. |
| `POST /api/v1/player/level-test` | Avalia e persiste o nível inicial. |
| `GET /api/v1/player/bookings/:id` | Detalha uma reserva criada ou participada. |
| `PATCH /api/v1/player/bookings/:id` | Altera visibilidade/faixa ou cancela a reserva. |
| `GET /api/v1/matches/:id` | Detalha uma partida aberta e seus times. |
| `POST /api/v1/matches/:id/join` | Entra em uma posição livre específica. |
| `PATCH /api/v1/matches/:id/teams` | Reorganiza os times; somente o organizador. |
| `GET/POST /api/v1/matches/:id/messages` | Lê ou publica mensagens da partida. |
| `PATCH /api/v1/club/profile` | Atualiza os dados públicos e a capa da arena. |
| `POST /api/v1/club/courts` | Cria uma quadra. |
| `PATCH /api/v1/club/courts/:id` | Edita todos os dados de uma quadra. |
| `GET /api/v1/club/courts/:id/deletion-impact` | Conta reservas futuras afetadas. |
| `DELETE /api/v1/club/courts/:id?confirm=true` | Exclui a quadra e cancela reservas futuras. |
| `GET /api/v1/club/schedule` | Retorna a grade diária ou semanal consolidada. |
| `POST /api/v1/club/courts/:id/recurring-bookings` | Cria uma reserva fixa. |
| `PATCH/DELETE /api/v1/club/recurring-bookings/:id` | Edita ou remove uma reserva fixa. |
| `GET /api/v1/club/finance` | Retorna KPIs, séries e distribuições financeiras. |

## Upload de imagens

`POST /api/v1/uploads/image` recebe JSON com `type`, `resourceId` quando
necessário, `mimeType` e `data` em base64. São aceitos JPEG, PNG e WebP de até
5 MB. O servidor confere a assinatura real do arquivo e a propriedade do recurso
antes de gravar atomicamente em `data/uploads/{players|clubs|courts}`.

Os arquivos públicos são servidos em `/uploads/...`, com ETag. O envio tem limite
de 30 tentativas por hora por usuário. O caminho retornado deve ser persistido
no perfil, clube ou quadra pela rota de atualização correspondente.

## Reservas e partidas

Uma reserva pode começar em até 90 dias. Cada jogador pode manter no máximo oito
reservas futuras confirmadas como criador e fazer até 20 tentativas de criação
por hora.

Partidas abertas possuem quatro posições distribuídas em `team1` e `team2`. O
organizador começa na primeira posição, novos jogadores escolhem uma vaga livre
e somente o organizador pode mover ou trocar participantes. A API valida que
nenhum jogador seja duplicado e mantém `participantIds` sincronizado para
compatibilidade com reservas e chat.

`levelMin` e `levelMax` variam de 0,5 a 7,0. O criador e quem entra precisam ter
nivelamento concluído e estar na faixa. Não é possível entrar após o início.

O cancelamento gratuito exige seis horas de antecedência. Uma reserva paga e
cancelada recebe `refundStatus: "pending"`; nenhum dinheiro é movimentado pelo
protótipo.

## Grade e recorrências

Quadras usam `openTime`, `closeTime` e `slotDuration`; horários terminam em
`:00` ou `:30`, e a duração aceita 60 ou 90 minutos. Os aliases legados
`opensAt`, `closesAt` e `slotDurationMinutes` continuam disponíveis.

A grade consolida reservas avulsas, recorrências e bloqueios. Reservas avulsas e
recorrências compartilham a mesma fila de escrita para impedir dupla ocupação.
A exclusão de recorrência é lógica; a exclusão confirmada de quadra é física e
cancela reservas futuras vinculadas antes de removê-la.

## Financeiro

`GET /api/v1/club/finance` aceita `courtId`, `from`, `to` ou
`period=day|week|month`. Datas personalizadas precisam ser enviadas em par e em
ordem crescente. A receita considera apenas reservas confirmadas e pagas.

Além de resumo, reservas e totais por quadra, a resposta contém:

- `revenueByDay`;
- `occupancyByCourt`;
- `byPaymentMethod`;
- `previousPeriod` para comparação;
- `period` com os intervalos atual e anterior.

## Rate limits

| Operação | Chave | Limite |
| --- | --- | --- |
| Login | IP | 30 a cada 15 minutos |
| Login | conta normalizada | 8 a cada 15 minutos |
| Cadastro | IP | 12 por hora |
| Upload | usuário | 30 por hora |
| Teste de nível | jogador | 6 por hora |
| Criação de reserva | jogador | 20 por hora |
| Leitura do chat | jogador | 240 por minuto |
| Escrita no chat | jogador | 60 por minuto |
| Criação/edição de recorrência | gestor | 120 por hora |

Ao exceder uma janela temporal, a API responde `429 rate_limited` e inclui
`Retry-After`.

## Persistência e produção

Os stores mantêm arquivos JSON separados para usuários, clubes, quadras,
reservas, avaliações, mensagens, recorrências e auditoria. O armazenamento
pressupõe um único processo. Para produção, use HTTPS, banco transacional,
armazenamento de objetos, segredo de sessão apropriado e integração real de
pagamentos.

Respostas com corpo usam `{ "data": ... }`. Erros usam
`{ "error": { "code", "message", "details?", "requestId" } }`. O contrato
completo está em `../docs/openapi.yaml`.
