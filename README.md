# Quadrafy

Plataforma web de padel que conecta jogadores a clubes e oferece reservas,
partidas abertas e gestão de arenas. O projeto combina um frontend multipágina
em HTML, CSS e JavaScript com uma API Node.js e autenticação por sessão.

## Estrutura

```text
.
├── frontend/
│   ├── index.html                 # Landing page
│   ├── login.html                 # Login e cadastro
│   ├── dashboard-player.html      # Painel do jogador
│   ├── dashboard-club.html        # Painel do clube
│   └── assets/
│       ├── css/styles.css
│       └── js/
│           ├── app.js             # Recursos compartilhados
│           ├── charts.js          # Gráficos locais, sem CDN
│           ├── dashboard-player.js
│           └── dashboard-club.js
├── backend/                       # API, autenticação e persistência JSON
└── docs/                          # Arquitetura e contrato OpenAPI
```

Cada tela permanece em um HTML separado. O backend também entrega os arquivos
do frontend e impede o acesso aos dashboards sem uma sessão do papel correto.

## Como executar

É necessário Node.js 20 ou superior. Não há dependências npm de runtime.

```powershell
cd backend
npm start
```

Abra `http://localhost:4173`. Para usar outra porta:

```powershell
$env:PORT=4174
npm start
```

## Funcionalidades

- Cadastro e login reais para jogadores e gestores de clube.
- Perfil do jogador com foto persistida, nivelamento e perfil público seguro.
- Descoberta de clubes, quadras, horários de 60 ou 90 minutos e reservas.
- Partidas abertas com faixa numérica de nível, dois times, posições específicas,
  reorganização pelo organizador e chat persistido.
- Perfil da arena com capa, dados públicos e gestão completa das quadras.
- Criação, edição e exclusão confirmada de quadras, incluindo imagem própria e
  cancelamento das reservas futuras afetadas.
- Grade diária ou semanal, reservas avulsas e recorrências semanais ou mensais.
- Pagamentos mockados, receita, comparativo com período anterior, ocupação e
  gráficos por dia, quadra e forma de pagamento.
- Upload local validado de imagens JPEG, PNG e WebP com limite de 5 MB.
- Trilha de auditoria das operações sensíveis.

## Persistência e segurança

Usuários, clubes, quadras, reservas, mensagens, nivelamentos, recorrências e
auditoria ficam em arquivos JSON separados em `backend/data/`. Imagens ficam em
`backend/data/uploads/`. As senhas usam `scrypt` e nunca são salvas em texto
puro.

A sessão usa o cookie `quadrafy_session` com `HttpOnly` e `SameSite=Lax`; em
produção também recebe `Secure`. Requisições mutáveis validam a origem. O
armazenamento atual é adequado para desenvolvimento com um único processo; uma
implantação de produção deve usar banco transacional e armazenamento de objetos.

## Verificação

```powershell
cd backend
npm test
npm run check
```

O contrato HTTP está em `docs/openapi.yaml`. Configuração e regras de domínio
estão em `backend/README.md`.
