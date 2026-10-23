/**
 * Pendências que impedem desativar uma conta (aperture-851nu), avaliadas em
 * todas as campanhas em que a conta é owner:
 *   - `saldo_a_sacar`        — saldo do recebedor ainda não resgatado.
 *   - `resgate_em_andamento` — repasse solicitado e não concluído.
 */
export type PendenciaDesativacao = 'saldo_a_sacar' | 'resgate_em_andamento';
