import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { PerfilCampanha } from '../../domain/arrecadacao/entities/perfil-campanha.js';
import type { IdCampanha, IdPerfilCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { ConteudoPerfilCriador } from '../../domain/usuario/value-objects/conteudo-perfil-criador.js';
import type { GeneroBebe } from '../../domain/usuario/value-objects/genero-bebe.js';
import type { TipoEventoPerfil } from '../../domain/usuario/value-objects/tipo-evento-perfil.js';
import type { Database } from '../database.js';
import type { PerfilCampanhaRepository } from './perfil-campanha-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'perfil_campanhas',
} as const;

type PerfilCampanhaRow = {
  id: string;
  id_campanha: string;
  nome_bebe: string | null;
  relacao: string | null;
  historia: string | null;
  data_nascimento: Date | null;
  tipo_evento: string | null;
  genero: string | null;
  data_evento: Date | null;
  foto_perfil_key: string | null;
  foto_capa_key: string | null;
  foto_historia_key: string | null;
  criado_em: Date;
  atualizado_em: Date;
};

export class PerfilCampanhaRepositoryPostgres implements PerfilCampanhaRepository {
  constructor(private readonly db: Database) {}

  async save(perfil: PerfilCampanha): Promise<void> {
    return tracer.startActiveSpan('db.perfil_campanhas.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        const c = perfil.conteudo;
        await this.db
          .insertInto('perfil_campanhas')
          .values({
            id: perfil.id,
            id_campanha: perfil.idCampanha,
            nome_bebe: c.nomeBebe,
            relacao: c.relacao,
            historia: c.historia,
            data_nascimento: c.dataNascimento,
            tipo_evento: c.tipoEvento,
            genero: c.genero,
            data_evento: c.dataEvento,
            foto_perfil_key: c.fotoPerfilKey,
            foto_capa_key: c.fotoCapaKey,
            foto_historia_key: c.fotoHistoriaKey,
            criado_em: perfil.criadoEm,
            atualizado_em: perfil.atualizadoEm,
          })
          // 1:1 upsert keyed by id_campanha. The existing row's `id` and
          // `criado_em` are preserved (immutable identity + creation time);
          // every other column plus `atualizado_em` is overwritten. Mirrors
          // PerfilCriadorRepositoryPostgres's id_usuario upsert.
          .onConflict((oc) =>
            oc.column('id_campanha').doUpdateSet({
              nome_bebe: c.nomeBebe,
              relacao: c.relacao,
              historia: c.historia,
              data_nascimento: c.dataNascimento,
              tipo_evento: c.tipoEvento,
              genero: c.genero,
              data_evento: c.dataEvento,
              foto_perfil_key: c.fotoPerfilKey,
              foto_capa_key: c.fotoCapaKey,
              foto_historia_key: c.fotoHistoriaKey,
              atualizado_em: perfil.atualizadoEm,
            }),
          )
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByIdCampanha(idCampanha: IdCampanha): Promise<PerfilCampanha | undefined> {
    return tracer.startActiveSpan('db.perfil_campanhas.findByIdCampanha', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('perfil_campanhas')
          .selectAll()
          .where('id_campanha', '=', idCampanha)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toPerfilCampanha(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

function toPerfilCampanha(row: PerfilCampanhaRow): PerfilCampanha {
  const conteudo: ConteudoPerfilCriador = {
    nomeBebe: row.nome_bebe,
    relacao: row.relacao,
    historia: row.historia,
    dataNascimento: row.data_nascimento,
    tipoEvento: row.tipo_evento as TipoEventoPerfil | null,
    genero: row.genero as GeneroBebe | null,
    dataEvento: row.data_evento,
    fotoPerfilKey: row.foto_perfil_key,
    fotoCapaKey: row.foto_capa_key,
    fotoHistoriaKey: row.foto_historia_key,
  };

  return {
    id: row.id as IdPerfilCampanha,
    idCampanha: row.id_campanha as IdCampanha,
    conteudo,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}
