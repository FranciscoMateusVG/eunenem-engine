import { addDays, addMonthsToMonthStart, localDateInSaoPaulo, startOfIsoWeek, startOfMonth } from './receitaPeriodo.js';

export interface DiaUsuarios { dia: string; novos: number; excluidos: number }
export function agregarEstatisticas(dias: readonly DiaUsuarios[], now: Date) {
  const hoje = localDateInSaoPaulo(now);
  const mes = startOfMonth(hoje);
  const semana = startOfIsoWeek(hoje);
  const contar = (de: string, ate: string) => dias.reduce((n, d) => n + (d.dia >= de && d.dia < ate ? d.novos : 0), 0);
  const meses = Array.from({length:12},(_,i)=>{
    const de=addMonthsToMonthStart(mes,i-11);const ate=addMonthsToMonthStart(de,1);
    return {de,ate,novos:contar(de,ate),parcial:de===mes};
  });
  // Three preceding weeks warm the moving average; zero weeks count too.
  const grade=Array.from({length:15},(_,i)=>{
    const de=addDays(semana,(i-14)*7);return {de,ate:addDays(de,7),novos:contar(de,addDays(de,7))};
  });
  const semanas=grade.slice(3).map((s,i)=>{
    const index=i+3;const previous=grade[index-1]!.novos;
    return {...s,parcial:s.de===semana,
      variacaoPct:previous===0?null:Math.round((s.novos-previous)/previous*10000)/100,
      media4Semanas:grade.slice(index-3,index+1).reduce((n,w)=>n+w.novos,0)/4};
  });
  return {snapshotAt:now.toISOString(),hoje,total:dias.reduce((n,d)=>n+d.novos,0),excluidos:dias.reduce((n,d)=>n+d.excluidos,0),meses,semanas};
}
export type Estatisticas = ReturnType<typeof agregarEstatisticas>;
