import type { Kysely } from 'kysely';
import { sql } from 'kysely';

const CONVITES_MODELO_CHECK = sql`
  modelo IN (
    'scrapbook',
    'varal-de-mimos',
    'balao-de-ar',
    'jardim-romantico',
    'lavanda',
    'floresta-magica',
    'roupinhas-e-coracoes',
    'berco-floral',
    'arco-iris-boho',
    'margaridas',
    'girafinha-bailarina',
    'safari',
    'elefantinho',
    'aviao-nas-nuvens',
    'balao-dourado',
    'baloes-no-ceu',
    'bandeirinhas-ursinho',
    'bichinhos-do-bosque',
    'bola-na-rede',
    'borboleta-encantada',
    'campo-de-futebol',
    'coelhinho-e-bebe',
    'dinossauro-aviador',
    'dinossauro-azul',
    'dormitorio',
    'elefante-no-luar',
    'flor-amarela',
    'florestas-azuis-aquarela',
    'fundo-marinho',
    'futebol-divertido',
    'girafa-estrelada',
    'patinho-laco-azul',
    'patinho-xadrez',
    'quadra-de-futebol',
    'roupinhas-delicada',
    'urso-com-baloes',
    'urso-nas-nuvens',
    'xadrez-azul-suave'
  )
`;

const CONVITES_MODELO_CHECK_PREVIOUS = sql`
  modelo IN (
    'scrapbook',
    'varal-de-mimos',
    'balao-de-ar',
    'jardim-romantico',
    'lavanda',
    'floresta-magica',
    'roupinhas-e-coracoes',
    'berco-floral',
    'arco-iris-boho',
    'margaridas',
    'girafinha-bailarina',
    'safari',
    'elefantinho'
  )
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('convites').dropConstraint('convites_modelo_check').execute();

  await db.schema
    .alterTable('convites')
    .addCheckConstraint('convites_modelo_check', CONVITES_MODELO_CHECK)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('convites').dropConstraint('convites_modelo_check').execute();

  await db.schema
    .alterTable('convites')
    .addCheckConstraint('convites_modelo_check', CONVITES_MODELO_CHECK_PREVIOUS)
    .execute();
}
