# NFS-e — checklist de emissão (aperture-besta)

A prévia (aperture-dh1k7) não transmite nada. A emissão real (aperture-wp6j6)
existe só por clique do admin — ver "Emissão real" abaixo.

- Confirmar com contador a base: comissão da plataforma menos cancelamentos, sem adicional do cartão cobrado do pagador. Reconciliar por tomador e verificar notas já emitidas.
- Resolver CPF/nome ausentes, inválidos e divergentes. Por decisão do operador (28/10/2026), usar sempre o último recebedor cadastrado da campanha (criada_em DESC, id DESC para empate), independentemente de is_active ou da competência. Mais de um registro gera a nota de rastreio “recebedor mais recente da campanha (houve troca)”, não pendência. A consulta é atual, não reconstrução histórica; alterações in-place antigas não são detectáveis.
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

## Emissão real (aperture-wp6j6)

Fluxo: /admin/pagamentos/nota-fiscal → mês fechado → "Emitir NFS-e" →
confirmação (ambiente, série, tomadores, total, campos fiscais, caixa
"conferi") → "Confirmar emissão". Nada roda sozinho: não há job nem cron.

- Decisões do contador (26/11/2026), isoladas em `server/nfse/plano-emissao.ts`:
  uma nota por mês por tomador (`agruparPorTomador`); pendências de tomador são
  PULADAS e listadas na confirmação (`pularPendencias`) e podem ser emitidas
  depois na mesma competência; competência = data da taxa; piso absoluto
  2026-11 (outubro/2026 nunca; `NFSE_COMPETENCIA_MINIMA` só sobe o piso).
- Endereço do tomador: o builder já gera `toma/end` (endNac) quando houver
  endereço; a coleta obrigatória no resgate é a aperture-xdylg.
- Idempotência: `nfse_emissoes` tem uma linha por (ambiente, competência, CPF);
  autorizada/cancelada nunca é reenviada. O nDPS é reservado em transação
  (`nfse_numeracao`, por ambiente e série) antes do envio; o Id da DPS é o mesmo
  em todas as tentativas.
- Sem resposta (timeout, conexão, 5xx) a nota fica "incerta"; a próxima
  tentativa (ou "Consultar") faz GET /dps/{Id} antes de reenviar.
- Notas gravadas: cada clique grava as notas que vai enviar (CPF, valor,
  campanhas de origem, nDPS) antes de qualquer envio, sob lock por
  competência. Retries enviam só os valores gravados; pendências resolvidas
  entram como notas novas (CPF novo, campanhas ainda não emitidas). Qualquer
  outra divergência (ex.: recebedor trocado depois da emissão) bloqueia
  (`competencia_divergente`) em vez de gerar outra nota para a mesma receita;
  a nota incerta continua recuperável por "Consultar". Reconciliar essa
  divergência é manual (contador), fora deste fluxo.
- O admin confirma a impressão (sha256) do plano completo: ambiente, série,
  prestador, CPFs, valores, campanhas e campos fiscais. O servidor recalcula
  no clique e recusa (CONFLICT) se for outra.
- Produção exige NFSE_AMBIENTE=1 E NFSE_EMISSAO_PRODUCAO=liberada.
- Cancelamento (evento e101101): motivo oficial (1/2/9), justificativa de 15 a
  255 caracteres e a chave de acesso redigitada. Sem resposta, a nova tentativa
  consulta o evento antes de reenviar.
- Endpoints: homologação `https://sefin.producaorestrita.nfse.gov.br/SefinNacional`
  + `https://adn.producaorestrita.nfse.gov.br`; produção
  `https://sefin.nfse.gov.br/SefinNacional` + `https://adn.nfse.gov.br`.
  Corpo JSON com XML gzip+base64 (`dpsXmlGZipB64`, `pedidoRegistroEventoXmlGZipB64`).
