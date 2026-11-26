# XSDs oficiais da NFS-e (Sistema Nacional)

Cópia verbatim de `Schemas/1.01/` do pack oficial, sem edição:

- Fonte: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/nfse-esquemas_xsd-v1-01-20260209.zip
- Baixado em: 2026-10-05
- sha256 do zip: e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072

Os testes validam a DPS da prévia mensal contra `v1.01/DPS_v1.01.xsd` com o
`xmllint` (libxml2). A `xmldsig-core-schema.xsd` da 1.01 é a genérica do W3C;
a da 1.00 fixava rsa-sha1/sha1/c14n inclusiva e não é usada aqui.

## Produção restrita (homologação) — `prodrest-20261124/`

Cópia verbatim do pack de produção restrita (leiaute RTC: `finNFSe`/`indDest`
no `infDPS`, `CST`/`cClassTrib` em `IBSCBS/valores/trib`), sem edição:

- Fonte: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita/esquemas-xsd-producao-restrita-20261124.zip
- Baixado em: 2026-11-26 (aperture-wp6j6, smoke de homologação)
- sha256 do zip: 1ca83c1a7929f6d5684c9a17700fe3d3a375e4ea12b7ccb832bfc369768902c0

Este pack já traz o pattern de TSSerieDPS sem `^…$`; o harness valida
contra ele sem normalização. A produção (v1.01-20260209 acima) segue no
leiaute anterior até a Receita migrá-la.
