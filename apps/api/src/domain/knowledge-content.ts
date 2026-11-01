import { createHash } from 'node:crypto';

export interface KnowledgeContent {
  id: string;
  version: number;
  title: string;
  symptom: string;
  cause: string;
  steps: string;
  keywords?: readonly string[] | null;
}

/**
 * 承認者が確認した内容の指紋（docs/64 §10）。ID・版・本文・keywords を束ねる。
 * version は承認のときだけ増え、下書きの編集では変わらないので、版だけでは束縛にならない。
 */
export function knowledgeContentHash(row: KnowledgeContent): string {
  const canonical = JSON.stringify([
    String(row.id),
    Number(row.version),
    row.title,
    row.symptom,
    row.cause,
    row.steps,
    Array.isArray(row.keywords) ? row.keywords : [],
  ]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
