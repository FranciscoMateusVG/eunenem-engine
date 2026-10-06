# Funil de criadores e métricas diárias — contrato (aperture-ai8vg)

Estado: contrato aprovado por root em 2026-09-13 com correções vinculantes;
implementado na PR desta pasta. **Código mergeado ≠ ingestão ≠ dashboard**:
este documento define o que cada número significa e de onde vem; a
disponibilidade de relatórios depende de acesso (ver § Acesso).

Fonte por fato: **banco** quando existe linha + timestamp durável (exato,
imune a replay); **Mixpanel** só onde o banco não vê nada (visitas) ou para
funil passo-a-passo. Todos os cortes diários em `America/Sao_Paulo`
(`date_trunc('day', ts AT TIME ZONE 'America/Sao_Paulo')`; o projeto Mixpanel
precisa estar no mesmo fuso — item de acesso).

## Definições (o que cada linha do relatório significa)

| Métrica | Fonte | Definição | Limites declarados |
|---|---|---|---|
| Cadastros/dia | `users.created_at` (BetterAuth) | primeiro fato durável do cadastro (OAuth e magic link) | `conta_criada` é EMISSÃO lazy (primeira chamada autenticada) — carrega `signup_at`; contas sem visita pós-auth podem faltar no Mixpanel; o banco é o total. **Método de cadastro não é reportado**: não há fato confiável (`accounts.provider_id` não prova o método; ausência não prova magic link) |
| Cadastros de migrados 1.0 | classificação contra o snapshot versionado da lista 1.0 (`legado_snapshot`) | `migrado_1_0 = true` \| `false` \| `'unknown'` (e-mail em branco ou snapshot vazio) | linha SEPARADA, nunca exclusão silenciosa; não é certeza histórica; a lista é um export estático |
| Sessões presentes | `sessions` (BetterAuth) | linhas existentes hoje, por `created_at` | **não** é contagem histórica de logins nem estimador confiável: linhas são apagadas no logout e no cascade do usuário |
| Logins (telemetria) | `login_concluido` (cliente, PR #110) | best-effort, separado das sessões | `is_legacy` da `auth.me`; sem método |
| Pageviews por página | `page_view_custom.rota` | contagem por template canônico | sem slug/id/query/token na `rota` |
| Visitantes únicos por página | `COUNT DISTINCT distinct_id` por `rota` por dia | id de dispositivo anônimo para visitantes/convidados; `idConta` para criadores identificados | um criador visto antes e depois do login só conta uma vez se o ID-merge do Mixpanel ligar os dois; sem fato no banco |
| Listas criadas/dia | `campanhas.criada_em` | contagem por dia; `origem` **só** via evento: `campanha_criada.origem = 'explicita'` (call path provado) e `conta_criada.id_campanha_padrao` (lista padrão do cadastro). No banco toda linha é `desconhecida` — nenhuma heurística (ordem, proximidade do cadastro) prova origem | histórico sem proveniência permanece `desconhecida` |
| Listas com ≥ 1 item | `MIN(contribuicoes.criada_em)` por campanha (SQL §4b) | indicador calculado, separado; por dia = dia do primeiro item | itens apagados somem (hard delete). No Mixpanel: primeiro `lista_item_criado` por campanha (não existe evento de "primeiro item" — decisão de root) |
| Listas com nome preenchido | `perfil_campanhas.nome_bebe` não vazio | indicador calculado, separado | a linha só existe após o primeiro save |
| Convites criados | `convites.criado_em` | primeiro save | compartilhamento **não** é fato durável (só cliente) |
| Convidados | `convidados` (contagem) + `convidado_criado` (evento) | linhas sem timestamp | por dia só via evento |
| RSVP respondidos | `convidados.presenca ∈ (sim, nao, talvez)` + `presenca_confirmada` (servidor) | estado no banco; por dia só via evento | sem timestamp na linha |
| Pagamentos aprovados | `pagamentos.status = 'aprovado'`, `atualizado_em` | referência (financeiro fora deste contrato) | ver EVENT_MAP § Deduplicação |

**Não existe "lista publicada"**: não há flag de publicação e toda lista é
alcançável em `/pagina/:slug` logo após o provisionamento. Prontidão /
publicação como conceito de produto **aguarda decisão**; slug não é
publicação. Os três indicadores acima são reportados separados, não somados.

## Funil (passos ordenados; usuários ≠ sessões ≠ ações)

Coorte = contas com `users.created_at` no dia/semana D (SP). Cada passo conta
**contas distintas** (ou campanhas distintas, onde indicado), nunca sessões
nem ações repetidas. Conversão N→N+1 = distintos com N+1 / distintos com N.

| # | Passo | Fato | Fonte |
|---|---|---|---|
| 1 | visita à home | `page_view_custom rota='/'` (visitantes, não contas) | Mixpanel |
| 2 | entrada | `nav_signin_click` / `cta_*_signup_click` | Mixpanel (UX) |
| 3 | cadastro | `users.created_at` / `conta_criada.signup_at` | banco / Mixpanel |
| 4 | onboarding | `usuarios.onboarding_concluido_em` / `onboarding_concluido` | banco / Mixpanel |
| 5 | lista com item | `MIN(contribuicoes.criada_em)` por campanha / primeiro `lista_item_criado` por campanha | banco (verdade) / Mixpanel (derivado) |
| 6 | personalização | `perfil_campanhas.criado_em` (verdade) / primeiro `perfil_campanha_salvo` por campanha (best-effort; sem `primeira_vez`) | banco / Mixpanel |
| 6b | nome preenchido | `nome_bebe` / `perfil_campanha_salvo.nomeado` | indicador, não gate |
| 7 | convite criado | `convites.criado_em` / `convite_criado` | banco / Mixpanel |
| 7b | compartilhamento | `convite_compartilhado`, `painel_compartilhar_link_click` | Mixpanel (UX, sem fato durável) |
| 8 | convidado adicionado | `convidado_criado` | Mixpanel (linha sem timestamp) |
| 9 | visita de convidado | `page_view_custom rota='/pagina/:slug'` + `id_campanha` (visitantes por campanha) | Mixpanel |
| 10 | RSVP | `presenca_confirmada` (servidor) | Mixpanel / estado no banco |
| 11 | checkout | eventos de Vance (qq74p) | fora deste contrato |
| 12 | pagamento aprovado | `pagamento_aprovado` (servidor) | fora deste contrato |

**Janelas**: conversão em W = 7 e 30 dias após o cadastro; cada passo conta
só se o fato cair em `[cadastro_em, cadastro_em + W]` (limite inferior e
superior). A base da coorte são **todos** os cadastros (`users`), incluindo
quem nunca fez a primeira chamada autenticada (bounce) — esses ficam com os
passos seguintes nulos, e o denominador é o mesmo de "cadastros/dia". Uma
coorte só é **completa** quando D + W já passou; antes disso é **censurada** e
deve ser rotulada como tal (nunca comparada a coortes completas). **Abandono** = contas
com o passo N e sem o passo N+1 dentro de W — sempre calculado, nunca um
evento disparado. Migrados 1.0 aparecem em linha própria (não são excluídos
silenciosamente). Nenhum número é afirmado para períodos anteriores à
instrumentação.

## Deduplicação e identidade

Eventos de servidor do funil sentam em linhas duráveis com id estável:
`$insert_id` derivado do id da linha DURÁVEL (relida após a escrita quando o
objeto retornado pode ser transiente — `perfil_campanhas` sob ON CONFLICT),
`time` = timestamp persistido da linha (ou o clock da escrita quando a linha
não tem timestamp — `convidados`). Fatos "primeira vez" nunca são emitidos (nem de leitura prévia, nem de
derivação pós-escrita): "lista com item" e "personalização pela primeira vez"
são derivados — primeira ocorrência do evento por campanha no Mixpanel,
`MIN(criada_em)` / `criado_em` no banco. Garantia real:
contra replay sequencial; o contrato completo (incl. residual de entregas
concorrentes) está em EVENT_MAP § Deduplicação. `distinct_id` de criadores =
`idConta` (o mesmo `identify` do cliente); convidados = `convidado:<id>`.

## Compatibilidade de propriedades (removidas nesta rodada)

| Evento | Removido | Motivo | Substituto |
|---|---|---|---|
| `page_view_custom` (Pagina, Painel, seções) | `slug` | nome do dono = PII | `rota` + `id_campanha` |
| `convidado_adicionado` | `slug` | idem | `id_campanha` |
| `campanha_criada` | `titulo` | texto livre | `idCampanha` |

Relatórios antigos que filtravam por `slug` migram para `id_campanha`.

## Especificações de relatórios Mixpanel (spec, não dashboard)

1. **Páginas**: Insights, evento `page_view_custom`, métrica *Total* (pageviews)
   e *Unique users* (visitantes), breakdown por `rota`, filtro `publico`,
   período diário, fuso do projeto = America/Sao_Paulo.
2. **Funil de criadores**: Funnels com os eventos `conta_criada` →
   `lista_item_criado` (primeira ocorrência por campanha — o Funnels do Mixpanel
   conta o usuário uma vez por conversão) → `perfil_campanha_salvo`
   (idem: primeira ocorrência por campanha — não existe `primeira_vez`) →
   `convite_criado` → `convidado_criado` →
   `presenca_confirmada` → `pagamento_aprovado`; contagem por *Uniques*;
   janela de conversão 7 e 30 dias; breakdown por `migrado_1_0`.
3. **Abandono**: o drop-off entre passos do funil acima na janela W — não
   existe evento de abandono.
4. **Visitas de convidados por campanha**: Insights `page_view_custom`, filtro
   `rota = '/pagina/:slug'` (ou `/c/:idCampanha`), breakdown `id_campanha`,
   *Unique users*.

## Acesso faltante (nomeado, não assumido)

- Acesso ao projeto Mixpanel para construir os relatórios acima (não existe
  service account nem ferramenta de leitura no Aperture); confirmar o fuso do
  projeto.
- Acesso somente-leitura ao Postgres de produção para executar
  `relatorios-diarios.sql` (não exercido pelo autor desta PR).
- Fuso da sessão do Postgres de produção: não verificado (as consultas usam
  `AT TIME ZONE` explícito e não dependem dele).
