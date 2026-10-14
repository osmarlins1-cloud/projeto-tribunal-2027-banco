# Projeto Tribunal 2027 — Banco online

Backend de integração com catálogo externo e cache SQLite. A chave do provedor fica no servidor, nunca no HTML.

## Endpoints
- `GET /health`
- `GET /api/stats`
- `GET /api/questions?subject=Direito%20Administrativo&topic=Atributos%20dos%20Atos%20Administrativos&stage=Aprendizagem&limit=10`

## Provedor
Este adaptador usa Quest API (`https://api.quest.api.br/v2`), que documenta um catálogo amplo de questões. É necessária conta/chave e o uso consome créditos conforme o plano. Consulte https://quest.api.br/docs e https://quest.api.br/docs/consumo.

## Publicação
1. Publique esta pasta em um repositório Git.
2. Crie um serviço web Docker em host compatível, como Render, usando `render.yaml`.
3. Configure `QUEST_API_KEY` como segredo do serviço.
4. Configure disco persistente para `/app/data`, para preservar o cache SQLite.
5. Copie a URL HTTPS publicada. O plano gratuito pode suspender o serviço por inatividade e não preserva o arquivo SQLite após reinicializações; as questões já carregadas também ficam no cache local do navegador. Para cache persistente no servidor, é necessário um plano/disco compatível.
6. No HTML, abra Backup e configurações → Banco de questões online, informe a URL e clique Salvar e testar.
7. No tópico de estudo, clique Buscar 10 questões online deste tópico.

## Regras de integridade
- O backend exige correspondência exata entre disciplina e assunto; não mistura tópicos para preencher lotes.
- Questões sem gabarito e questões anuladas são excluídas.
- Questões externas são marcadas `external`, nunca `official` automaticamente.
- A bateria oficial só pode ser liberada após verificação contra caderno e gabarito definitivo da banca.
- A chave deve permanecer como variável de ambiente do backend, nunca no navegador.
- Este pacote é o código do backend, não um serviço já publicado. Publicação e chave do provedor dependem de uma conta autorizada.
