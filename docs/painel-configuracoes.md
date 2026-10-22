# Painel e Configurações — somente interface

Esta versão mantém o painel compacto, compartilhamento nativo com fallback para cópia, resumo financeiro apenas visual, menu reorganizado e página Configurações. Reutiliza os componentes, estilos, rotas, permissões e gerenciamento de acessos existentes.

Não há APIs novas, novas categorias de e-mail, alteração de mural público ou dependência de novas tabelas. Privacidade e novos avisos aparecem como indisponíveis, sem estado salvo simulado. Notificações e mensagens públicas mantêm o comportamento anterior. O modal de exclusão explica a análise e oferece o canal existente de atendimento após confirmação; não registra protocolo, apaga ou desativa contas.

Nenhuma mudança de esquema é necessária. O identificador histórico 062 foi mantido com `up` e `down` vazios para compatibilidade com o histórico de staging. Não é preciso aplicar alteração de banco para usar esta interface. Caso a versão anterior já tenha criado tabelas, elas ficam intactas e sem uso; não há limpeza ou rollback destrutivo.

Validação: build, tipagem, suíte de servidor/integração e E2E. O teste de interface cobre 320, 375, 390, 768 e 1440 px, cópia, compartilhamento, navegação para acessos, controles indisponíveis e modal de atendimento. Destino exclusivo staging, sem produção.
