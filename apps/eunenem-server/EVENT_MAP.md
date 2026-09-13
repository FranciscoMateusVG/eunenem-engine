# Mapa de eventos GTM/GA + Mixpanel — eunenem-server

Todos os eventos de cliente são enviados via `sendEvent`/`sendPageView` de
[pages/lib/analytics.ts](pages/lib/analytics.ts), que alimenta **dois sinks**
a partir do MESMO ponto de chamada (zero mudança por call-site):

1. **GTM/GA** — chama `window.gtag('event', ...)` quando o gtag já carregou
   (o formato que o GA4 processa) e, SENÃO, faz o push de objeto em
   `window.dataLayer` — um OU outro, nunca ambos. O push de objeto só é
   visível a um container GTM com trigger configurado. GTM/GA carregam
   server-side via `envelope()` em [server.tsx](server.tsx)
   (`GOOGLE_ANALYTICS`/`GOOGLE_TAG_MANAGER` no `.env`).
2. **Mixpanel** (aperture-ppuay) — segundo sink dentro de `sendEvent`; ver a
   seção [## Mixpanel](#mixpanel). Todo evento desta tabela também vai para o
   Mixpanel quando `MIXPANEL_TOKEN` está presente.

Os eventos de **verdade de servidor** saem do backend pelo sink
`ServerAnalytics` (ver [## Eventos de servidor](#eventos-de-servidor)).

> **Fonte da verdade (aperture-4yse9, decisão de root):** a transição no banco
> é a verdade; a entrega analítica é *best-effort* nos dois sinks. Nenhum
> evento aqui é evidência de liquidação financeira. Ver
> [## Deduplicação e semântica](#deduplicação-e-semântica).

## Conversões

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `login_concluido` | Sessão autenticada resolvida no retorno de OAuth (Google/Microsoft) ou magic link — THE sinal de "login concluído" no cliente; dispara logo após `identifyWithUtm` | `is_legacy` (bool, vem de `auth.me`). **Sem** `metodo` nem `conta_nova`: não são deriváveis no cliente sem alterar o callback de auth; omitidos, nunca inferidos | [pages/lib/useOauthReturnRedirect.ts](pages/lib/useOauthReturnRedirect.ts) |
| `onboarding_concluido` | Wizard de onboarding pós-signup concluído (o proxy de "cadastro concluído" no cliente; a criação da conta é verdade de servidor — `conta_criada`) | — | [pages/components/eunenem/auth/OnboardingWizard.tsx](pages/components/eunenem/auth/OnboardingWizard.tsx) — `finish` |
| `compra_concluida` | Confirmação de pagamento **vista pelo comprador** (etapa de UX, best-effort por navegador). A conversão-verdade é `pagamento_aprovado` (servidor) | `transaction_id` (Stripe sessionId em cartão, txid Inter em PIX; **nunca vazio** — sem id o evento não é emitido), `value` (BRL decimal), `currency: 'BRL'`, `valor_centavos` (int), `valor` (legado, = `valor_centavos`), `metodo` (`pix`\|`credit_card`), `gift_name`, `quantidade_itens` (opcional; ausente em /sucesso) | [pages/PaginaSucessoPage.tsx](pages/PaginaSucessoPage.tsx) `ApprovedState`; [GiftCheckoutModal.tsx](pages/components/eunenem/GiftCheckoutModal.tsx) (inline Stripe + PIX QR); [CartDrawer.tsx](pages/components/eunenem/CartDrawer.tsx) (inline Stripe + PIX QR). Dedup ANTES do `sendEvent` em [pages/lib/analytics-conversao.ts](pages/lib/analytics-conversao.ts) por `transaction_id` (localStorage `eunenem:conv:compra:<id>`), aperture-wdis6 |
| `pagamento_falhou` | Página de sucesso em estado de falha (pagamento rejeitado OU erro da query tRPC — ambos caem aqui) | — | pages/PaginaSucessoPage.tsx — `FailedState` |

Removidos do código em PR #50 (contas por senha aposentadas) e por isso
**fora desta tabela**: `signup_concluido`, `login_concluido` em
`AuthModalProvider.onAuthenticated` (o provider não emite mais nada).

## Checkout

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `checkout_iniciado` | Intenção de pagamento criada com sucesso (uma vez por intenção): sessão Stripe (cartão) ou cobrança PIX (Inter) a partir de um presente único | `valor_centavos`, `metodo` | GiftCheckoutModal.tsx — `onConfirmMetodo` / formulário de identidade PIX |
| `checkout_iniciado` | Idem a partir do carrinho (múltiplos itens) | `valor_centavos`, `quantidade_itens`, `metodo` | CartDrawer.tsx — `onFinalizar` / formulário de identidade PIX |
| `pix_qr_regenerado` | Usuário gera um novo QR PIX após expiração/rejeição (aperture-4yse9 T1.5). **Não** re-emite `checkout_iniciado` | `transaction_id` (o NOVO txid), `valor_centavos`, `metodo: 'pix'` | GiftCheckoutModal.tsx e CartDrawer.tsx — próximo `iniciar` após `onPixRetry` |

## Pageviews customizados

Necessários porque o app não tem client-side router (toda navegação é full
page load) e deseja-se saber qual página/seção foi vista, não só a URL.

| Evento | `page_name` | Propriedades extra | Arquivo |
|---|---|---|---|
| `page_view_custom` | `Landing` | — | [pages/LandingPage.tsx](pages/LandingPage.tsx) |
| `page_view_custom` | `FAQ` | — | [pages/FaqPage.tsx](pages/FaqPage.tsx) |
| `page_view_custom` | `Painel` | `slug` | [pages/PainelPage.tsx](pages/PainelPage.tsx) — `PainelPageView` |
| `page_view_custom` | título da seção via `PAINEL_SECTION_META` | `slug`, `section` | [pages/PainelSectionPage.tsx](pages/PainelSectionPage.tsx) |
| `page_view_custom` | `Pagina` | `slug` | [pages/PaginaPage.tsx](pages/PaginaPage.tsx) — página pública de presentes |
| `page_view_custom` | `Sucesso` | — | [pages/PaginaSucessoPage.tsx](pages/PaginaSucessoPage.tsx) |
| `page_view_custom` | `Confirmar Presenca` | — | [pages/ConfirmarPresencaPage.tsx](pages/ConfirmarPresencaPage.tsx) |
| `page_view_custom` | `Campanhas` | — | [pages/CampanhasPage.tsx](pages/CampanhasPage.tsx) (dispara também para anônimos redirecionados a `/`) |
| `page_view_custom` | `Termos de Uso` | — | [pages/TermosDeUsoPage.tsx](pages/TermosDeUsoPage.tsx) |

Sem pageview explícito hoje: `/painel/:slug/convite/preview`, todas as rotas
`/admin*`, 404 e páginas de dev (`/auth-demo`, `/trpc-smoke`).

## Convite

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `convite_modelo_selecionado` | Escolha de um template de convite | `template_id` | [ConviteBody.tsx](pages/components/eunenem/painel/ConviteBody.tsx) — `selectTemplate`; [MobileConviteBody.tsx](pages/components/eunenem/painel/MobileConviteBody.tsx) |
| `convite_editar_click` | Clique em "editar convite" a partir da preview | — | [ConvitePreviewBody.tsx](pages/components/eunenem/painel/ConvitePreviewBody.tsx) |
| `convite_salvo` | Convite salvo com sucesso — dispara TANTO no botão salvar (`onSave`) QUANTO no fluxo de envio (`onSend`); o mesmo nome cobre duas ações (candidato a `origem` em rodada futura) | — | ConviteBody.tsx e MobileConviteBody.tsx |
| `convite_ver_preview_click` | Clique em "ver convite salvo" | — | ConviteBody.tsx e MobileConviteBody.tsx |
| `convite_compartilhado` | Resultado do compartilhamento nativo/cópia de link | `resultado` (`shared`\|`copied`\|`cancelled`) | ConviteBody.tsx e MobileConviteBody.tsx (`onSend`) |

## Área do usuário / Painel

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `painel_compartilhar_link_click` | Clique em "compartilhe o link do evento" / "copiar" | — | [PainelHeaderCard.tsx](pages/components/eunenem/painel/PainelHeaderCard.tsx) — `onCopy`; [PerfilBody.tsx](pages/components/eunenem/painel/PerfilBody.tsx) |
| `painel_suporte_whatsapp_click` | Clique em "fale com a gente" (WhatsApp) no menu do painel | — | [PainelMenuRow.tsx](pages/components/eunenem/painel/PainelMenuRow.tsx) |
| `convidado_adicionado` | Convidado adicionado à lista de convidados | `id_campanha`, `slug` (sem nome/telefone) | [ConvidadosBody.tsx](pages/components/eunenem/painel/ConvidadosBody.tsx) |

## Lista de Presentes

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `lista_item_personalizado_adicionado` | Item personalizado criado e adicionado | `nome_item` (texto livre) | [ListaPresentesBody.tsx](pages/components/eunenem/painel/ListaPresentesBody.tsx) — `addItem` |
| `lista_item_catalogo_adicionado` | Itens do catálogo adicionados em lote | `quantidade_itens` | ListaPresentesBody.tsx — `addCatalogItems` |
| `lista_pronta_visualizada` | Abertura do detalhe de uma "lista pronta" | `preset_id` | ListaPresentesBody.tsx |
| `lista_pronta_itens_adicionados` | Itens de uma "lista pronta" adicionados em lote | `preset_id`, `quantidade_itens` | ListaPresentesBody.tsx — `addPresetItems` |

## Resgate de Valores / Dados Bancários

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `resgate_valores_click` | Clique em "resgatar valores" (header do painel) | — | PainelHeaderCard.tsx |
| `resgate_valores_click` | Clique em "solicitar transferência" (extrato) | `origem: "extrato"` | [PresentesBody.tsx](pages/components/eunenem/painel/PresentesBody.tsx) |
| `dados_bancarios_salvos` | Dados bancários/Pix salvos com sucesso | — | [BancariosBody.tsx](pages/components/eunenem/painel/BancariosBody.tsx) — `salvar.onSuccess` |
| `dados_bancarios_adiados` | Usuário adia o cadastro bancário ("preencher depois") | — | BancariosBody.tsx — `marcarPendente.onSuccess` |

## Navegação (navbar, footer, menu mobile)

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `cta_hero_signup_click` | CTA principal do Hero | — | [landing/Hero.tsx](pages/components/eunenem/landing/Hero.tsx) |
| `cta_final_signup_click` | CTA final da landing | — | [landing/CTAFinal.tsx](pages/components/eunenem/landing/CTAFinal.tsx) |
| `nav_signin_click` | "Entrar" (navbar da landing) | — | [landing/Navbar.tsx](pages/components/eunenem/landing/Navbar.tsx) |
| `nav_signout_click` | "Sair" (navbar da landing; o logout do PainelTopbar não emite evento) | — | landing/Navbar.tsx — `handleSignOut` |
| `nav_link_click` | Item de navegação (desktop, mobile, dropdown "Meu painel") | `link_label`, `href` | landing/Navbar.tsx e [Navbar.tsx](pages/components/eunenem/Navbar.tsx) |
| `mobile_menu_open` | Menu hambúrguer mobile (página pública) | — | pages/components/eunenem/Navbar.tsx |
| `footer_link_click` | Qualquer link do rodapé | `link_label` | [Footer.tsx](pages/components/eunenem/Footer.tsx) |
| `landing_whatsapp_fab_click` | FAB de WhatsApp na landing | — | [landing/WhatsAppFab.tsx](pages/components/eunenem/landing/WhatsAppFab.tsx) |

## FAQ

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `faq_contato_whatsapp_click` | "falar conosco" / "falar com a gente" | `origem` (`topbar`\|`resposta_pendente`\|`cta_final`) | pages/FaqPage.tsx |
| `faq_pergunta_expandida` | Expansão de uma pergunta do acordeão | `pergunta` (texto da pergunta) | pages/FaqPage.tsx |

## Confirmação de Presença (RSVP)

O cliente **não emite mais** `presenca_confirmada` (aperture-4yse9): o
servidor é o único emissor, então um RSVP é uma linha, não duas sob o mesmo
nome. Ver a tabela de servidor.

## Mixpanel

O Mixpanel (aperture-ppuay) é um **segundo sink** dentro de `sendEvent` em
[pages/lib/analytics.ts](pages/lib/analytics.ts). Todo evento das tabelas acima
também é enviado ao Mixpanel — nenhuma mudança por call-site foi necessária.

- **Init**: lazy e idempotente (`mixpanelOn()`), decidido só no cliente. Lê o
  token de `window.__EUNENEM_ENV__.mixpanelToken` (injetado por request pelo
  `serializeRuntimeEnv` em [server.tsx](server.tsx), a partir de
  `process.env.MIXPANEL_TOKEN`). Config atual: `autocapture: true`,
  `record_sessions_percent: 100`, `persistence: 'localStorage'` —
  configuração herdada do projeto original, não uma preferência explícita
  do operador (ver [## Privacidade](#privacidade-e-minimização)).
- **Mounts-dark**: sem token, o sink fica escuro — `track`/`identify`/`people`
  viram no-op e o comportamento é byte-idêntico ao anterior (GA/GTM intactos).
  O token é um write-only ingestion key público, seguro no cliente.
- **Autocapture**: aditivo — clicks/pageviews automáticos POR CIMA dos eventos
  explícitos do EVENT_MAP. Três fluxos de pageview coexistem por navegação:
  `page_view_custom`, `$mp_web_page_view` (autocapture) e o `page_view` do GA4.
- **`$insert_id` no cliente** (aperture-4yse9): em `compra_concluida`, o sink
  Mixpanel recebe `$insert_id` derivado do `transaction_id` (sanitizado para
  `[A-Za-z0-9-]`, ≤36 chars). Só no ramo Mixpanel — o objeto do chamador
  (que também vai ao GA) nunca carrega chaves `$`. É uma dica secundária: a
  dedup primária é o guard por `transaction_id` em `analytics-conversao.ts`.
  Outro dispositivo ou localStorage limpo = outro `distinct_id`; reload =
  outro `time`; nesses casos o Mixpanel **não** colapsa por esta chave.

### Identidade

| Ponto | `distinct_id` | Notas |
|---|---|---|
| Login (OAuth ou magic link, retorno via `/?oauth=1`) | `idConta` | `identifyWithUtm(me.idConta)` em [useOauthReturnRedirect.ts](pages/lib/useOauthReturnRedirect.ts), após `auth.me` resolver; em seguida `login_concluido` |
| Signup (conta nova) | `idConta` | `identifyWithUtm(me.data.idConta)` em [OnboardingWizard.tsx](pages/components/eunenem/auth/OnboardingWizard.tsx) — `finish`, após `onboarding_concluido` (redundante no caminho normal: a conta já foi identificada no retorno) |
| Logout | — | `resetAnalyticsIdentity()` em `useSignOut` ([pages/lib/auth.ts](pages/lib/auth.ts)) — só no `onSuccess` do signOut |

`identifyWithUtm` chama `mixpanel.identify(idConta)` e, em seguida,
`people.set_once({ utm_source })` — o `utm_source` de primeiro toque é capturado
em [LandingPage.tsx](pages/LandingPage.tsx) (`URLSearchParams` → `localStorage`
`eunenem:utm_source`, só em `/`). Só `utm_source` é capturado.

Lacunas conhecidas (não tratadas nesta rodada): sessão por cookie válida com
localStorage limpo nunca re-identifica; falha de `signOut` deixa a identidade
mesclada.

## Eventos de servidor

Os eventos de **verdade de servidor** disparam do backend via o sink
`ServerAnalytics` ([server/analytics/server-analytics.ts](server/analytics/server-analytics.ts)),
injetado em `ServerDeps` e gated real-vs-noop em `MIXPANEL_TOKEN` no
`buildServerDeps` (mesmo padrão mounts-dark do `objectStorage`/`pagamentoProvider`).
Todo evento de servidor carrega `source: 'server'`.

| Evento | `distinct_id` | Propriedades | Origem |
|---|---|---|---|
| `pagamento_aprovado` | `idConta` do dono da campanha (`idsAdministradores[0]`, posicional). Sem dono resolvido → evento **descartado** (nunca um perfil placeholder, nunca a campanha como pessoa) | `id_pagamento`, `id_campanha`, `id_conta_dono`, `metodo` (`pix`\|`credit_card`), `provedor` (`stripe`\|`inter`), `caminho` (`webhook`\|`reconciliacao`), `valor_centavos` (totalPaidCents), `valor_recebedor_centavos`, `quantidade_itens` | Um único helper, [server/analytics/pagamento-aprovado.ts](server/analytics/pagamento-aprovado.ts), chamado por: Stripe `checkout.session.completed` (paid) e `charge.succeeded` em [stripe-webhook.ts](server/webhooks/stripe-webhook.ts); Inter `onChargeConfirmed` em [inter-pix-webhook.ts](server/webhooks/inter-pix-webhook.ts); reconciliação PIX (poll a cada 5 min) via porta `onPagamentoAprovado` ligada em [server/jobs/pix-cobranca-reconciliation.pgboss.ts](server/jobs/pix-cobranca-reconciliation.pgboss.ts). **Só dispara quando a chamada realizou a transição** (`pendente`\|`processing` → `aprovado`); replay é no-op |
| `conta_criada` | `idConta` | `idPlataforma` (sem `metodo`: o principal não expõe o provedor — omitido, não inferido) | self-heal de conta órfã após OAuth/magic link ([session-resolver.ts](server/trpc/session-resolver.ts) `autoProvisionarUsuarioOrfao`) — o único emissor de criação de conta; dispara na primeira chamada tRPC autenticada, não no signup em si |
| `campanha_criada` | `idConta` | `idCampanha`, `titulo` (texto livre — candidato a remoção, ver Privacidade) | [campanhas-router.ts](server/trpc/campanhas-router.ts) `criar` |
| `repasse_solicitado` | `idConta` | `idRepasse`, `idCampanha`, `amountCents`, `numLancamentos` | [recebedor-router.ts](server/trpc/recebedor-router.ts) `transferencia.solicitar` |
| `presenca_confirmada` | `convidado:<idConvidado>` (ator opaco, estável por convidado) | `idCampanha`, `idConvidado`, `idLista`, `presenca`, `presenca_anterior` | [evento-lista-de-convidados-router.ts](server/trpc/evento-lista-de-convidados-router.ts) `confirmarPresenca` — **só quando a resposta muda**; re-envio do mesmo valor não é fato |

Sem evento de servidor hoje (lacunas conhecidas, rodada futura): estorno,
rejeição/expiração, disputa, criação de cobrança PIX, estados do repasse além
de `solicitado`, login/magic link, ponte legado (Clerk), mutations admin.

## Deduplicação e semântica

- **Alvo: um pagamento = um `pagamento_aprovado`.** O que está garantido na
  origem é só contra *replay sequencial*: cada call path lê o status antes de
  finalizar e só emite quando ESSA chamada fez `pendente`\|`processing` →
  `aprovado`; um retry após o commit vê `aprovado` e não emite. O que NÃO
  está garantido: **entregas concorrentes** do Stripe para o mesmo pagamento
  (`checkout.session.completed(paid)` e `charge.succeeded` chegando juntos)
  podem ambas ler `pendente`, ambas finalizar (uma vence o CAS, a outra recebe
  o registro canônico como no-op) e **ambas emitir** — com `event.created`
  distintos, o Mixpanel não colapsa. Residual conhecido e aceito por root nesta
  rodada (sem outbox, sem sinal de "vencedor da transição"); regressão explícita
  em `tests/unit/server/phase3-dispatcher.test.ts`.
  O sink acrescenta, best-effort: `$insert_id` determinístico (hash de
  `evento + id_pagamento`, 36 chars) e `time` = timestamp do fato
  (`event.created` do Stripe; `horario` do Inter — o MESMO valor lido pelo
  webhook e pela reconciliação, então webhook × poll colapsam). Contrato real
  do Mixpanel: duplicatas colapsam só quando (evento, `time`, `distinct_id`,
  `$insert_id`) coincidem em query-time, ou no mesmo dia em uma compactação
  posterior não garantida. Crash entre commit e envio = evento perdido.
- `compra_concluida` (cliente) e `pagamento_aprovado` (servidor) caem em
  perfis diferentes por desenho: o comprador é anônimo no cliente; o dono da
  campanha é o `distinct_id` no servidor. Funis de receita usam
  `pagamento_aprovado` com `source = 'server'`.
- Mesmo nome, dois sinks: só eventos de servidor têm `source`. Um relatório
  pelo nome cru soma os dois — filtre por `source`.
- Ids de ator: `idConta` (contas), `convidado:<id>` (convidados). O literal
  `anon` é **rejeitado pela API do Mixpanel** e não é mais usado.

## Privacidade e minimização

Verificado por Cipher (aperture-bdd59) contra `mixpanel-browser` 2.81.0:

- Defaults do SDK: session replay **mascara texto e inputs** e desliga
  network/canvas/fonts; autocapture **não captura** texto nem inputs. Não há
  prova de exposição de dados de formulário via replay; gravação em `/admin*`
  não é provada (init lazy, sem call-site admin).
- Residuais **provados**: tráfego `/record` em visitas anônimas antes de
  qualquer consentimento (não existe UI de consentimento); gravação de
  console; metadata de URL/referrer/href (`/sucesso` inicializa com
  `sessionId` e `idCampanha` na URL); props explícitas em texto livre
  (`titulo`, `nome_item`, `gift_name`, `pergunta`, `slug`, `href`) — enviadas
  também ao GA/GTM, não só ao Mixpanel.
- Proposta de Cipher (allowlist de rotas públicas para replay/autocapture,
  mask/block explícitos, blacklist de URL/referrer, remoção de texto livre nos
  call-sites) está **pendente de decisão do operador** — não aplicada nesta
  rodada. Sampling e consentimento são decisões de produto/legal.

## Variáveis de ambiente

`MIXPANEL_TOKEN` — token público write-only do projeto; alimenta os dois
sinks. Documentado em [.env.example](.env.example). Vazio = ambos os sinks
escuros.
