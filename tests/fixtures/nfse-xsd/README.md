# XSDs oficiais da NFS-e (Sistema Nacional)

Cópia verbatim de `Schemas/1.01/` do pack oficial, sem edição:

- Fonte: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/nfse-esquemas_xsd-v1-01-20260209.zip
- Baixado em: 2026-10-05
- sha256 do zip: e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072

Os testes validam a DPS da prévia mensal contra `v1.01/DPS_v1.01.xsd` com o
`xmllint` (libxml2). A `xmldsig-core-schema.xsd` da 1.01 é a genérica do W3C;
a da 1.00 fixava rsa-sha1/sha1/c14n inclusiva e não é usada aqui.
