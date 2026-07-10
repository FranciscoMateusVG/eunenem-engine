# Mapa de eventos GTM/GA — eunenem-server

Todos os eventos são enviados via `sendEvent`/`sendPageView` de
[pages/lib/analytics.ts](pages/lib/analytics.ts), que chama `window.gtag('event', ...)`
diretamente (o formato que o GA4 realmente processa), com fallback para um
push de objeto em `window.dataLayer` quando `gtag` ainda não carregou — esse
fallback só é visível a um container GTM, não ao GA4, a menos que uma tag
seja configurada lá para reencaminhá-lo. GTM/GA carregam server-side via
`envelope()` em [server.tsx](server.tsx) (ver `GOOGLE_ANALYTICS`/
`GOOGLE_TAG_MANAGER` no `.env`).

## Conversões

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `signup_concluido` | Cadastro concluído (conta nova) | — | [pages/components/eunenem/auth/AuthModalProvider.tsx](pages/components/eunenem/auth/AuthModalProvider.tsx) — `onAuthenticated` |
| `login_concluido` | Login concluído (conta existente) | — | [pages/components/eunenem/auth/AuthModalProvider.tsx](pages/components/eunenem/auth/AuthModalProvider.tsx) — `onAuthenticated` |
| `onboarding_concluido` | Wizard de onboarding pós-signup concluído | — | [pages/components/eunenem/auth/OnboardingWizard.tsx](pages/components/eunenem/auth/OnboardingWizard.tsx) — `finish` |
| `compra_concluida` | Pagamento de um presente confirmado (conversão principal) | `valor`, `gift_name` | [pages/PaginaSucessoPage.tsx](pages/PaginaSucessoPage.tsx) — `ApprovedState` |
| `pagamento_falhou` | Pagamento rejeitado/não concluído | — | [pages/PaginaSucessoPage.tsx](pages/PaginaSucessoPage.tsx) — `FailedState` |

## Checkout

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `checkout_iniciado` | Sessão Stripe criada a partir de um presente único | `valor_centavos`, `metodo` | [pages/components/eunenem/GiftCheckoutModal.tsx](pages/components/eunenem/GiftCheckoutModal.tsx) — `onConfirmMetodo` |
| `checkout_iniciado` | Sessão Stripe criada a partir do carrinho (múltiplos itens) | `valor_centavos`, `quantidade_itens`, `metodo` | [pages/components/eunenem/CartDrawer.tsx](pages/components/eunenem/CartDrawer.tsx) — `onFinalizar` |

## Pageviews customizados

Necessários porque o app não tem client-side router (toda navegação é full
page load) e deseja-se saber qual página/seção foi vista, não só a URL.

| Evento | `page_name` | Propriedades extra | Arquivo |
|---|---|---|---|
| `page_view_custom` | `Landing` | — | [pages/LandingPage.tsx](pages/LandingPage.tsx) |
| `page_view_custom` | `FAQ` | — | [pages/FaqPage.tsx](pages/FaqPage.tsx) |
| `page_view_custom` | `Painel` | `slug` | [pages/PainelPage.tsx](pages/PainelPage.tsx) — `PainelPageView` |
| `page_view_custom` | título da seção (ex: "minha lista de presentes", "dados bancários") via `PAINEL_SECTION_META` | `slug`, `section` | [pages/PainelSectionPage.tsx](pages/PainelSectionPage.tsx) |

## Convite

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `convite_modelo_selecionado` | Escolha de um template de convite | `template_id` | [pages/components/eunenem/painel/ConviteBody.tsx](pages/components/eunenem/painel/ConviteBody.tsx) — `selectTemplate`; [pages/components/eunenem/painel/MobileConviteBody.tsx](pages/components/eunenem/painel/MobileConviteBody.tsx) |
| `convite_editar_click` | Clique em "editar convite" a partir da preview | — | [pages/components/eunenem/painel/ConvitePreviewBody.tsx](pages/components/eunenem/painel/ConvitePreviewBody.tsx) |
| `convite_salvo` | Convite salvo com sucesso | — | ConviteBody.tsx (`onSave`, `onSend`) e MobileConviteBody.tsx (`onSave`, `onSend`) |
| `convite_ver_preview_click` | Clique em "ver convite salvo" | — | ConviteBody.tsx e MobileConviteBody.tsx (link/topbar) |
| `convite_compartilhado` | Resultado do compartilhamento nativo/cópia de link | `resultado` (`shared`\|`copied`\|`cancelled`) | ConviteBody.tsx e MobileConviteBody.tsx (`onSend`, via `shareConvitePreview`) |

## Área do usuário / Painel

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `painel_compartilhar_link_click` | Clique em "compartilhe o link do evento" / "copiar" | — | [pages/components/eunenem/painel/PainelHeaderCard.tsx](pages/components/eunenem/painel/PainelHeaderCard.tsx) — `onCopy`; [pages/components/eunenem/painel/PerfilBody.tsx](pages/components/eunenem/painel/PerfilBody.tsx) |
| `painel_suporte_whatsapp_click` | Clique em "fale com a gente" (WhatsApp) no menu do painel | — | [pages/components/eunenem/painel/PainelMenuRow.tsx](pages/components/eunenem/painel/PainelMenuRow.tsx) |

## Lista de Presentes

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `lista_item_personalizado_adicionado` | Item personalizado criado e adicionado | `nome_item` | [pages/components/eunenem/painel/ListaPresentesBody.tsx](pages/components/eunenem/painel/ListaPresentesBody.tsx) — `addItem` |
| `lista_item_catalogo_adicionado` | Itens do catálogo adicionados em lote | `quantidade_itens` | ListaPresentesBody.tsx — `addCatalogItems` |
| `lista_pronta_visualizada` | Abertura do detalhe de uma "lista pronta" | `preset_id` | ListaPresentesBody.tsx (card "VER LISTA →") |
| `lista_pronta_itens_adicionados` | Itens de uma "lista pronta" adicionados em lote | `preset_id`, `quantidade_itens` | ListaPresentesBody.tsx — `addPresetItems` |

## Resgate de Valores / Dados Bancários

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `resgate_valores_click` | Clique em "resgatar valores" (header do painel) | — | [pages/components/eunenem/painel/PainelHeaderCard.tsx](pages/components/eunenem/painel/PainelHeaderCard.tsx) |
| `resgate_valores_click` | Clique em "solicitar transferência" (extrato) | `origem: "extrato"` | [pages/components/eunenem/painel/PresentesBody.tsx](pages/components/eunenem/painel/PresentesBody.tsx) |
| `dados_bancarios_salvos` | Dados bancários/Pix salvos com sucesso | — | [pages/components/eunenem/painel/BancariosBody.tsx](pages/components/eunenem/painel/BancariosBody.tsx) — `salvar.onSuccess` |
| `dados_bancarios_adiados` | Usuário adia o cadastro bancário ("preencher depois") | — | BancariosBody.tsx — `marcarPendente.onSuccess` |

## Navegação (navbar, footer, menu mobile)

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `cta_hero_signup_click` | Clique no CTA principal do Hero ("criar minha lista grátis") | — | [pages/components/eunenem/landing/Hero.tsx](pages/components/eunenem/landing/Hero.tsx) |
| `cta_final_signup_click` | Clique no CTA final da landing ("criar minha lista agora") | — | [pages/components/eunenem/landing/CTAFinal.tsx](pages/components/eunenem/landing/CTAFinal.tsx) |
| `nav_signin_click` | Clique em "Entrar" (navbar da landing) | — | [pages/components/eunenem/landing/Navbar.tsx](pages/components/eunenem/landing/Navbar.tsx) |
| `nav_signout_click` | Clique em "Sair" (navbar da landing) | — | Navbar.tsx (landing) — `handleSignOut` |
| `nav_link_click` | Clique em item de navegação (desktop, mobile, dropdown "Meu painel") | `link_label`, `href` | Navbar.tsx (landing) e [pages/components/eunenem/Navbar.tsx](pages/components/eunenem/Navbar.tsx) (página pública) |
| `mobile_menu_open` | Abertura do menu hambúrguer mobile (página pública) | — | pages/components/eunenem/Navbar.tsx |
| `footer_link_click` | Clique em qualquer link do rodapé (FAQ, termos, blog, redes sociais) | `link_label` | [pages/components/eunenem/Footer.tsx](pages/components/eunenem/Footer.tsx) |

## FAQ

| Evento | Ação | Propriedades | Arquivo |
|---|---|---|---|
| `page_view_custom` | Visualização da página de FAQ | `page_name: "FAQ"` | [pages/FaqPage.tsx](pages/FaqPage.tsx) |
| `faq_contato_whatsapp_click` | Clique em "falar conosco" / "falar com a gente" | `origem` (`topbar`\|`resposta_pendente`\|`cta_final`) | pages/FaqPage.tsx |
| `faq_pergunta_expandida` | Expansão de uma pergunta do acordeão | `pergunta` | pages/FaqPage.tsx |
