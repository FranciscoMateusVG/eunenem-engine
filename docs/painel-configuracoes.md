# Painel compacto e Configurações — staging

## Arquitetura reutilizada

`PainelHeaderCard`, `PainelMenu`/`PainelMenuRow`, `PainelLayout` e o registro de `painelRoutes` continuam responsáveis pela navegação e apresentação. Os totais financeiros e contadores ainda são calculados pelos mesmos hooks/use cases; o card mudou somente em CSS. Copiar link usa a URL canônica da campanha; compartilhar usa `navigator.share`, com fallback para cópia e confirmação somente após sucesso.

O menu da conta passa a conter Perfil, Personalizar, Configurações, Dados bancários e Atendimento. A rota antiga `/compartilhar` e seu gerenciamento de membros/permissões permanecem; o acesso pelo menu agora é Configurações → Gerenciar acessos. As permissões padrão existentes continuam excluindo finanças, titularidade e resgates. Não há novo sistema de autenticação ou grants.

## Escopos e persistência

- Privacidade pertence à campanha (`campanha_privacidade`). Usuários com a permissão existente `mensagens:gerenciar` podem alterá-la.
- Aprovação editorial pertence ao recado/pagamento e à campanha (`recado_moderacao`), com ator e data. A leitura pública exige a preferência ativa, aprovação explícita e pagamento aprovado. A aprovação é aplicada antes do limite de 50. Nenhum valor/status de pagamento é modificado.
- **Recados antigos não são aprovados por migração**. Permanecem visíveis no painel e precisam de aprovação individual em Mensagens recebidas para aparecer no mural público. Lido/não lido permanece independente da moderação.
- Preferências de e-mail pertencem ao usuário e à plataforma, reutilizando `lifecycle_email_preferences`: `payment_received`, `new_message`, `presence_confirmed`. Cada toggle grava somente sua própria categoria, com preview otimista e rollback em erro. Mensagens de segurança, login e comprovantes transacionais continuam fora desses toggles.
- Os dois novos avisos usam a fila e o transporte lifecycle existentes, inclusive opt-out revalidado no envio, deduplicação, remetente verificado e controles de rollout. Novos recados são notificados após pagamento aprovado; RSVP notifica a primeira confirmação “sim” por convidado. Não são reenviados recados de pagamentos históricos recuperados. Os avisos novos são destinados ao titular elegível, sem conceder permissões a membros.

## Solicitação de exclusão

A funcionalidade registra uma solicitação em `solicitacoes_exclusao_conta`, nunca apaga ou desativa a conta. Dialog nativo, confirmação explícita e autenticação de até 15 minutos são obrigatórios. O principal da sessão recente precisa coincidir com o usuário autenticado; cookies de identidades diferentes não podem satisfazer a checagem. Sessão antiga exige sair e entrar novamente pelo fluxo existente.

É coletado inventário conservador de todas as campanhas próprias, eventos futuros/sem data, pagamentos, resgates em andamento e registros de saldo. Esse inventário **não é uma autorização automática de exclusão nem um cálculo de saldo líquido**: toda solicitação exige revisão humana, conciliação financeira e análise de retenção. A conta, o acesso e os registros financeiros ficam intactos. Pedidos repetidos mantêm um único protocolo pendente por usuário, exibido também ao recarregar Configurações.

O texto explica a possível exclusão de perfil/fotos/preferências e a necessidade de analisar retenção de registros. A LGPD admite conservação para obrigação legal/regulatória e estabelece exceções à eliminação (arts. 16 e 18), conforme o [texto oficial](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm). Não foram inventados prazos de retenção nem automatizadas decisões jurídicas.

### Operação e dependências

A análise, regularização financeira e eventual execução da exclusão dependem da equipe responsável. Não há worker de exclusão ou exclusão em cascata. O usuário recebe um protocolo e o canal existente de atendimento para acompanhar. A equipe autorizada pode consultar a fila no banco, sem expor essa consulta publicamente:

```sql
SELECT id, usuario_id, estado, criada_em, verificacoes
FROM solicitacoes_exclusao_conta
WHERE estado = 'em_analise'
ORDER BY criada_em;
```

Os envios continuam dependendo do worker SMTP/lifecycle e de seus gates de rollout já existentes (`LIFECYCLE_EMAIL_ENABLED`, launch instant e allowlist quando aplicável). Nenhum envio real a clientes foi acionado durante a validação; SMTP de teste é local.

## Migração e rollback

`20261021_062_painel_configuracoes.ts` adiciona três tabelas e amplia somente os checks de categorias da fila/preferências de e-mail. Não faz backfill de aprovações nem remove dados existentes. Tipos Kysely foram regenerados com PostgreSQL real.

O rollback recusa remover tabelas se já houver preferências, moderação ou solicitações armazenadas. Requer preservação/análise manual. Os checks ampliados de categorias de e-mail são mantidos para não apagar auditoria; desative/drene os avisos novos antes de qualquer rollback operacional.

## Validação

- Typecheck SDK, aplicação e E2E; build e lint.
- 1.332 testes de servidor, incluindo autorização, isolamento de campanha e autenticação recente.
- 49 testes direcionados de integração e permissões com PostgreSQL e SMTP loopback; categorias independentes, opt-out no envio e deduplicação.
- Migração aplicada em PostgreSQL 16 isolado; up/down/up sem dados e bloqueio de rollback com dados verificados.
- E2E com banco e sessão reais: 320, 375, 390, 768 e 1440 px no painel e em Configurações; cópia e compartilhamento nativo/fallback; persistência das quatro preferências; rollback de toggle em falha simulada; aprovação/ocultação e privacidade do mural; confirmação, cancelamento, protocolo e sessão antiga na exclusão; conta preservada.

Destino exclusivo staging. O resultado do CI e os arquivos alterados ficam registrados no PR. Não publicar em produção.
