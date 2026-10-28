# NFS-e — checklist de emissão (aperture-besta)

Esta entrega é somente prévia. Não transmite, emite ou cancela notas.

- Confirmar com contador a base: comissão da plataforma menos cancelamentos, sem adicional do cartão cobrado do pagador. Reconciliar por tomador e verificar notas já emitidas.
- Resolver CPF/nome ausentes, inválidos, divergentes e possíveis trocas de titular. Fonte é o titular ATUAL da campanha e a data da consulta, não histórico. Múltiplos recebedores com criação desde o início da competência (inclusive depois do mês) bloqueiam a prévia até revisão. Alterações in-place antigas não são detectáveis pelo esquema atual.
- Fornecer e-CNPJ A1 da EuNeném por canal protegido; senha fora do Git/log. Verificar CNPJ/validade. Assinatura não equivale a emissão.
- Confirmar série própria (ex.00001) e criar numeração persistida sequencial, concorrência/idempotência e recuperação de timeout com consulta antes de retransmitir. Série99999/números da prévia não reservam número fiscal nem servem para emissão.
- tpAmb=1 somente na emissão real autorizada. Prévia mantém ambiente configurado (default2).
- Confirmar cadastro/habilitação BH e IM12306200019 (default informado pelo contador), cTribNac100202/cTribMun003. Competência no último dia do mês; não Simples, sem regime especial, ISS tributável/não retido, alíquota omitida; percentuais11.33/0.00/3.00 e IBSCBS conforme contador.
- Revalidar XSD/regras de negócio e homologação supervisionada. XSD válido não prova aceitação fiscal.
- Implementar emissão separada com autorização, auditoria sem CPF/XML nos logs, armazenamento protegido e tratamento de rejeições. Nenhum envio automático nesta prévia.

## XSD
Fonte oficial produção verificada em28/10/2026:
https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual
Pack v1.01-20260209 preservado verbatim em tests/fixtures/nfse-xsd. O harness existente normaliza apenas numa cópia temporária os anchors incorretos do pattern de série para libxml2; não declarar validação verbatim sem essa ressalva. Homologação tem pack diferente20261020; não trocar silenciosamente o de produção.

Configurar NFSE_CTRIB_NAC diferente de100202 bloqueia a DPS com pendência visível: o municipal003 só foi aprovado para esse código nacional.
