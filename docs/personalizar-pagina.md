# Personalizar página — staging

## Arquitetura examinada

- `pages/components/eunenem/painel/PerfilBody.tsx`: formulário de identidade e antiga área de fotos. Usava `PhotoSlot` (recorte com react-easy-crop), URL assinada, PUT e atualização do perfil por campanha.
- `pages/components/eunenem/TweaksPanel.tsx`: antigo editor flutuante da página pública, com presets, seletor nativo, hex e rascunhos no `TweaksContext`. Retirado; a página pública passa a oferecer um atalho.
- `pages/PaginaPage.tsx`: composição real de `Navbar`, `Hero`, `Story`, `Marketplace`, `HowTo`, `Messages`, `Footer` e contextos de carrinho.
- `perfilCampanha.get/atualizar/emitirUrlUploadFoto`: leitura, substituição integral do conteúdo e emissão de upload. Repositório `perfil_campanhas`, chaves de objeto e URLs resolvidas já existentes; cores `corPrimaria`/`corAcento`. Datas/tipo de evento vêm de `eventos`. Nenhum schema, migração ou API nova.

## Implementação e decisões

A seção `personalizar` segue o registro existente de rotas e o layout do painel. O menu “Sua página & Conta” reutiliza `perfil:editar`; regras de autorização no servidor permanecem iguais. O upload usa o mesmo `PhotoSlot`, recorte e presign por campanha. As paletas e a derivação de cores vêm de `tweaksDefaults` e `palette`.

Fotos e cores ficam em rascunho até salvar. Cancelar restaura a configuração persistida. A operação de salvar força uma leitura atual e repassa os campos não editados à API de substituição integral, preservando identidade, história, datas, gênero, cores e chaves não alteradas, inclusive valores nulos legados. A API existente não tem controle de versão para edições simultâneas; não foi criado um protocolo paralelo.

A prévia é a própria rota pública em iframe da mesma origem, com larguras de 1100/390 px e rolagem dentro do cartão. Uma ponte de mensagens aceita apenas a janela pai da mesma origem e campos visuais permitidos; cores são normalizadas. Ela usa `TweaksContext` para atualizar os mesmos componentes públicos. Interações da árvore pública ficam `inert` na prévia, e o page-view explícito da página pública é suprimido. A assinatura, história, lista e mensagens continuam sendo lidas pelos mecanismos existentes. Os atalhos de edição não aparecem na prévia; o atalho público respeita a ocultação durante overlays de compra.

A remoção de uma foto envia chave nula somente ao salvar. `Hero`/`Story` distinguem nulo (remoção explícita) de undefined (sem override). Nenhum objeto antigo é excluído.

**Ponto para revisão operacional:** uploads cancelados ou substituídos podem deixar objetos sem referência no bucket, pois os bytes são enviados antes da confirmação, enquanto a chave só é vinculada ao perfil ao salvar. Isso permite Cancelar de verdade e preserva fotos antigas. Não foi adicionada exclusão automática nem política de retenção sem referência.

## Validação local

- Typecheck do SDK, do aplicativo e dos E2E.
- Build real do aplicativo (esbuild + Tailwind).
- 75 testes em quatro arquivos: perfil por campanha, rotas, permissões e helpers/contratos da edição.
- Chromium/Chrome com componentes reais e API/armazenamento simulados: prévia e alteração temporária, Cancelar, cor inválida, erro de salvar e nova tentativa, preservação dos campos não editados, recarregar, remoção de foto, upload com recorte sem atualização prematura do perfil e cancelamento, alternância mobile e ausência de overflow na página a 390 px. Sem erros de JavaScript.
- E2E com banco real atualizados para a nova navegação, mas não executados localmente: PostgreSQL e object storage não estão disponíveis neste ambiente. O teste do navegador com mocks não comprova a integração com o bucket de staging.

Sem mudanças em regras financeiras, autorização, autenticação ou edição de listas. Destino exclusivo: `staging`; nenhuma publicação em produção.
