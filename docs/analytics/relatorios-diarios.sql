-- aperture-ai8vg — relatórios diários (somente leitura).
-- Executar contra o Postgres do eunenem-server com um papel SOMENTE LEITURA.
-- Todos os cortes em America/Sao_Paulo via AT TIME ZONE explícito; nenhuma
-- consulta depende do fuso da sessão. Nenhum número histórico é afirmado
-- fora do que estas linhas retornam. Ver docs/analytics/funil-metricas.md.

-- 1) Cadastros por dia (fato: BetterAuth users.created_at).
--    O método de cadastro NÃO é reportado (não há fato confiável).
SELECT date_trunc('day', u.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       count(*) AS cadastros
FROM users u
GROUP BY 1
ORDER BY 1 DESC;

-- 2) Sessões presentes por dia de criação — NÃO é histórico de logins
--    (linhas apagadas no logout / cascade). Reportar com esse rótulo.
SELECT date_trunc('day', s.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       count(*)                 AS sessoes_presentes,
       count(DISTINCT s.user_id) AS usuarios_com_sessao_presente
FROM sessions s
GROUP BY 1
ORDER BY 1 DESC;

-- 3) Listas criadas por dia. ORIGEM: o banco NÃO guarda proveniência —
--    nenhuma heurística (ordem, proximidade do cadastro) prova origem, então
--    toda linha histórica é 'desconhecida'. A origem 'explicita' só existe no
--    evento campanha_criada (call path provado); a lista padrão do cadastro é
--    parte do fato cadastro (evento conta_criada.id_campanha_padrao).
SELECT date_trunc('day', c.criada_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       'desconhecida'::text AS origem,
       count(*) AS listas
FROM campanhas c
GROUP BY 1
ORDER BY 1 DESC;

-- 4) Indicadores separados de listas (estado atual, não por dia):
--    criadas, com >= 1 item, com nome preenchido. Não somar; não existe
--    "lista publicada".
SELECT
  (SELECT count(*) FROM campanhas) AS listas_criadas,
  (SELECT count(DISTINCT co.campanha_id) FROM contribuicoes co) AS listas_com_item,
  (SELECT count(*) FROM perfil_campanhas pc
     WHERE pc.nome_bebe IS NOT NULL AND btrim(pc.nome_bebe) <> '') AS listas_com_nome;

-- 4b) Listas que ganharam o primeiro item, por dia: MIN(criada_em) por
--     campanha em subconsulta, depois contagem de CAMPANHAS por dia SP.
--     (Verdade do relatório para o passo "lista com item"; no Mixpanel o
--     passo é a primeira ocorrência de lista_item_criado por campanha — não
--     existe evento de "primeiro item".)
SELECT date_trunc('day', p.primeiro_item_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       count(*) AS listas_com_primeiro_item
FROM (
  SELECT co.campanha_id, min(co.criada_em) AS primeiro_item_em
  FROM contribuicoes co
  GROUP BY co.campanha_id
) p
GROUP BY 1
ORDER BY 1 DESC;

-- 4c) Listas cuja personalização foi salva pela primeira vez, por dia.
SELECT date_trunc('day', pc.criado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       count(*) AS listas_personalizadas
FROM perfil_campanhas pc
GROUP BY 1
ORDER BY 1 DESC;

-- 5) Convites criados por dia (primeiro save).
SELECT date_trunc('day', cv.criado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       count(*) AS convites_criados
FROM convites cv
GROUP BY 1
ORDER BY 1 DESC;

-- 6) Convidados e RSVP — estado (linhas sem timestamp; por dia só via evento).
SELECT
  count(*)                                                    AS convidados,
  count(*) FILTER (WHERE presenca = 'enviado')                AS convites_enviados,
  count(*) FILTER (WHERE presenca IN ('sim', 'nao', 'talvez')) AS rsvp_respondidos
FROM convidados;

-- 7) Funil por coorte de cadastro (contas distintas por passo; janela W dias).
--    Base = TODOS os cadastros (users), LEFT JOIN usuarios: quem nunca fez a
--    primeira chamada autenticada (bounce) fica na coorte com os passos
--    seguintes nulos/falsos — o denominador é o mesmo de "cadastros/dia".
--    Cada passo exige o fato DENTRO de [cadastro_em, cadastro_em + W]
--    (limite inferior E superior). Coorte completa só quando dia_cadastro + W
--    já passou (censura explícita). Migrados 1.0 não são identificáveis no
--    banco (classificação vive no evento conta_criada) — este funil reporta o
--    total; a linha de migrados vem do Mixpanel.
WITH coorte AS (
  SELECT u.id AS id_usuario, us.id_conta,
         date_trunc('day', u.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia_cadastro,
         u.created_at AS cadastro_em
  FROM users u
  LEFT JOIN usuarios us ON us.id = u.id
), w AS (SELECT 30 AS dias)
SELECT c.dia_cadastro,
       -- Maturidade pelo ÚLTIMO cadastro da coorte + W (timestamp), não pelo
       -- dia: uma coorte cujo último cadastro foi às 23h só completa às 23h
       -- do dia D+W. 'completa' e 'censurada' são colunas separadas.
       max(c.cadastro_em) + make_interval(days => (SELECT dias FROM w)) <= now() AS coorte_completa,
       max(c.cadastro_em) + make_interval(days => (SELECT dias FROM w)) > now()  AS coorte_censurada,
       count(*) AS cadastros,
       count(us_prov.id_conta) AS provisionados,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM usuarios us WHERE us.id_conta = c.id_conta
           AND us.onboarding_concluido_em IS NOT NULL
           AND us.onboarding_concluido_em >= c.cadastro_em
           AND us.onboarding_concluido_em <= c.cadastro_em + make_interval(days => (SELECT dias FROM w)))) AS onboarding,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM campanha_administradores ca
         JOIN contribuicoes co ON co.campanha_id = ca.campanha_id
         WHERE ca.id_usuario = c.id_conta
           AND co.criada_em >= c.cadastro_em
           AND co.criada_em <= c.cadastro_em + make_interval(days => (SELECT dias FROM w)))) AS lista_com_item,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM campanha_administradores ca
         JOIN perfil_campanhas pc ON pc.id_campanha = ca.campanha_id
         WHERE ca.id_usuario = c.id_conta
           AND pc.criado_em >= c.cadastro_em
           AND pc.criado_em <= c.cadastro_em + make_interval(days => (SELECT dias FROM w)))) AS personalizacao,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM campanha_administradores ca
         JOIN eventos ev ON ev.id_campanha = ca.campanha_id
         JOIN convites cv ON cv.id_evento = ev.id
         WHERE ca.id_usuario = c.id_conta
           AND cv.criado_em >= c.cadastro_em
           AND cv.criado_em <= c.cadastro_em + make_interval(days => (SELECT dias FROM w)))) AS convite_criado,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM campanha_administradores ca
         JOIN pagamentos p ON p.intencao_id_campanha = ca.campanha_id
         WHERE ca.id_usuario = c.id_conta AND p.status = 'aprovado'
           AND p.atualizado_em >= c.cadastro_em
           AND p.atualizado_em <= c.cadastro_em + make_interval(days => (SELECT dias FROM w)))) AS pagamento_aprovado
FROM coorte c
LEFT JOIN usuarios us_prov ON us_prov.id_conta = c.id_conta
GROUP BY 1
ORDER BY 1 DESC;
