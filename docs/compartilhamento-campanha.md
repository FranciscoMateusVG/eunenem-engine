# Compartilhamento de campanha

- Proprietário: painel da campanha → **Compartilhar** → e-mail → **Convidar**.
- O convite dura sete dias. A pessoa deve entrar com **aquele e-mail** usando Google ou link de acesso. O envio do link e a criação de uma conta não concedem acesso.
- A sessão autenticada passa pelo resolver central; somente depois ele verifica `users.email_verified`, plataforma e conta de domínio e consome convites pendentes. A aceitação é idempotente e transacional.
- Convites revogados/expirados nunca são consumidos. Convites repetidos ainda pendentes não criam uma segunda linha nem prorrogam o prazo.
- Remover acesso usa exclusivamente `campanhaMembros.remover`, revogando convites pendentes do e-mail na mesma transação. Um login posterior não restaura esse acesso.
- Os caminhos sem ID explícito (inclusive o endereço público pelo slug da pessoa) continuam usando a campanha mais antiga **da qual ela é proprietária**. Campanhas compartilhadas aparecem na lista e exigem seu ID explícito.

- Novos membros podem gerenciar presentes, perfil, mensagens e convite, e visualizar convidados. Link público, extrato, recebedor, saques e gestão de membros permanecem restritos; o proprietário pode ajustar permissões.
- Pessoas verificadas com convite aceito entram direto na campanha compartilhada, sem concluir o onboarding próprio. **Criar minha própria lista** abre esse onboarding opcional; sem acesso compartilhado, ele continua obrigatório.

## Suporte: cliente sem acesso ao Gmail antigo

1. Entrar como operador permitido em `ADMIN_ALLOWED_EMAILS`.
2. Abrir `/admin/campanha/<id>` e conferir a campanha correta.
3. Em **Adicionar acesso por e-mail**, informar o novo endereço e confirmar que a operação concede somente acesso.
4. A pessoa entra com o novo e-mail verificado. O novo acesso é de **membro**, nunca proprietário.

A ação registra ator, campanha, e-mail e horário em `campanha_compartilhamento_audit`. Não altera recebedor, dados bancários, titularidade financeira nem proprietário. Qualquer transferência de propriedade exige um procedimento separado; não é implementada por esta tela.

## Limites de segurança e operação

- Normalização de e-mail: trim + lowercase (sem equivalência de pontos/aliases do Gmail).
- Convite a e-mail que já tem acesso é recusado; permissões são alteradas no membro existente.
- Convites, remoções e permissões serializam no bloqueio `FOR UPDATE` da campanha.
- `CampanhaRepository.save` só inicializa administradores/proprietários na criação; salvar um agregado antigo não apaga grants nem ressuscita membros removidos.
- Credenciais e sessões antigas continuam sujeitas aos hooks anti-pre-hijack de `criar-auth.ts`, que não foram modificados.
- Envio usa o transporte SMTP existente; ambiente sem SMTP usa o sink/no-op existente. Se SMTP falhar após o commit, o convite permanece e uma tentativa posterior pode reenviar sem duplicar a linha.

## Verificação

```sh
pnpm exec vitest run tests/integration/campanha-compartilhamento.postgres.test.ts tests/integration/campanha-sharing-router.postgres.test.ts tests/integration/campanha-membership-save.postgres.test.ts
pnpm exec playwright test e2e/campanha-compartilhar.spec.ts --project=chromium
```

O E2E de compartilhamento é restrito a localhost e requer banco de teste migrado; não executar mutações em produção. A integração usa Postgres real, BetterAuth real e um sink de e-mail; apenas a troca de token com Google é substituída no teste OAuth.
