# Contestação PIX (MED) — MVP administrativo

1. Confirme o E2E do aviso do banco (não apenas nome/valor). Abra o pagamento no admin.
2. Em **Contestações PIX · MED**, informe pagamento ou E2E, valor, data do bloqueio,
   ID de caso opcional e notas. O registro nasce `bloqueada`; repetição idêntica retorna
   o registro existente. Outro caso no mesmo pagamento exige revisão, não sobrescreve.
3. O crédito inteiro do pagamento fica indisponível, mesmo se o aviso for parcial.
   Não dividimos lançamentos nem alteramos a idempotência do ledger. Novas solicitações
   excluem esse pagamento; lotes existentes falham aprovação/envio com motivo MED.
   Para pagar os demais créditos, cancele o lote solicitado e solicite novamente.
4. Com desfecho confirmado pelo banco, marque `liberada` (restaura elegibilidade) ou
   `devolvida` (mantém retenção permanente). Datas e atores ficam registrados.
   Se um job aprovado esgotou as tentativas enquanto retido, use **Cancelar lote MED**
   e solicite novamente, inclusive após a liberação. Não re-enfileiramos dinheiro automaticamente.
   Não há reabertura/edição de desfecho no MVP. Não use refund comum para simular MED.
5. Um repasse já iniciado/enviado/pago não pode ser recuperado aqui. O registro mostra
   **exposição financeira**. A reconciliação de dinheiro já enviado continua permitida;
   bloquear a contabilidade não desfaria a transferência. Exige tratamento operacional.

## Concorrência e limites

Registro, resolução, sweep, aprovação e início de transferência usam os locks
transacionais por pagamento já existentes. O início da tentativa é o ponto de
linearização: um MED registrado depois não consegue cancelar um envio em andamento.
O admin mostra essa exposição. Nenhuma chamada bancária é feita pelo cadastro MED.
A receita continua uma estimativa sem ajuste contábil de MED; registro e retenção
não representam baixa contábil, cobrança ao anfitrião ou recuperação automática.

## Inter / automação (verificado em 01/11/2026)

A [documentação pública de APIs Inter](https://developers.inter.co/docs/introducao/nossas-apis)
e [FAQ técnico](https://developers.inter.co/duvidas-frequentes) não permitiram confirmar
um contrato de evento MED da API empresarial. A ausência de confirmação não prova
que o produto não oferece esse recurso. Não inferimos MED de `pix.devolucao`.
O [FAQ MED do Inter](https://ajuda.inter.co/pix/o-que-e-o-pix-med-e-como-abrir-um-relato-de-infracao-do-pix)
descreve acompanhamento no aplicativo e retorno por e-mail. Este MVP usa aviso
verificado manualmente; a pipeline de webhook existente fica intacta. Integração
futura exige contrato oficial, autenticação, identidade do caso e testes de replay.
