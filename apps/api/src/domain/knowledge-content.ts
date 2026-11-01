import { createHash } from 'node:crypto';
import { knowledgeTagsFromText } from '../support-session/case-facts.js';

export interface KnowledgeContent {
  id: string;
  version: number;
  title: string;
  symptom: string;
  cause: string;
  steps: string;
  keywords?: readonly string[] | null;
  /** 列の値（035）。NULL または 035 の前の行は未算出で、本文から求めたタグを使う。 */
  symptom_tags?: readonly string[] | null;
}

/** 公開で有効になる固定症状タグ。列にあればその値、未算出なら本文から求める（読む側と同じ規則）。 */
export function effectiveSymptomTags(
  row: Pick<KnowledgeContent, 'title' | 'symptom' | 'symptom_tags'>,
): string[] {
  return [...(row.symptom_tags ?? knowledgeTagsFromText(row.title, row.symptom))];
}

/** 列のタグが本文から求めた値と一致するか。承認の前の行で違うのは、手で書き換えられたときだけ。 */
export function symptomTagsMatchContent(
  row: Pick<KnowledgeContent, 'title' | 'symptom' | 'symptom_tags'>,
): boolean {
  if (row.symptom_tags == null) return true;
  const derived = knowledgeTagsFromText(row.title, row.symptom);
  return (
    row.symptom_tags.length === derived.length &&
    derived.every((tag) => row.symptom_tags?.includes(tag))
  );
}

/**
 * 承認者が確認した内容の指紋（docs/64 §10、§11）。ID・版・本文・keywords・固定症状タグを束ねる。
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
    // 未算出と本文から求めた値を同じにする。承認で列へ書いても、記録の指紋を再計算できる。
    effectiveSymptomTags(row).sort(),
  ]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
