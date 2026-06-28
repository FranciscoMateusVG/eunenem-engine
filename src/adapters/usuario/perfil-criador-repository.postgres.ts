import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { PerfilCriador } from '../../domain/usuario/entities/perfil-criador.js';
import type { ConteudoPerfilCriador } from '../../domain/usuario/value-objects/conteudo-perfil-criador.js';
import type { GeneroBebe } from '../../domain/usuario/value-objects/genero-bebe.js';
import type { IdPerfilCriador, IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { TipoEventoPerfil } from '../../domain/usuario/value-objects/tipo-evento-perfil.js';
import type { Database } from '../database.js';
import type { PerfilCriadorRepository } from './perfil-criador-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'perfil_criadores',
} as const;

type PerfilCriadorRow = {
  id: string;
  id_usuario: string;
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

export class PerfilCriadorRepositoryPostgres implements PerfilCriadorRepository {
  constructor(private readonly db: Database) {}

  async save(perfil: PerfilCriador): Promise<void> {
    return tracer.startActiveSpan('db.perfil_criadores.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        const c = perfil.conteudo;
        await this.db
          .insertInto('perfil_criadores')
          .values({
            id: perfil.id,
            id_usuario: perfil.idUsuario,
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
          // 1:1 upsert keyed by id_usuario. The existing row's `id` and
          // `criado_em` are preserved (immutable identity + creation time);
          // every other column plus `atualizado_em` is overwritten.
          .onConflict((oc) =>
            oc.column('id_usuario').doUpdateSet({
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

  async findByUsuarioId(idUsuario: IdUsuario): Promise<PerfilCriador | undefined> {
    return tracer.startActiveSpan('db.perfil_criadores.findByUsuarioId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('perfil_criadores')
          .selectAll()
          .where('id_usuario', '=', idUsuario)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toPerfilCriador(row) : undefined;
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

function toPerfilCriador(row: PerfilCriadorRow): PerfilCriador {
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
    id: row.id as IdPerfilCriador,
    idUsuario: row.id_usuario as IdUsuario,
    conteudo,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}
