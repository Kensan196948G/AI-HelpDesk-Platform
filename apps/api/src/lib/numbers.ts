export async function nextCaseNo(db: any): Promise<string> {
  const rows = await db<{ no: string }[]>`
    SELECT 'TKT-' || to_char(now(), 'YYYY') || '-' ||
      lpad(seq::text, GREATEST(4, length(seq::text)), '0') AS no
    FROM (SELECT nextval('case_no_seq') AS seq) s
  `;
  return rows[0]?.no ?? '';
}

export async function nextIncNo(db: any): Promise<string> {
  const rows = await db<{ no: string }[]>`
    SELECT 'INC-' || to_char(now(), 'YYYY') || '-' ||
      lpad(seq::text, GREATEST(4, length(seq::text)), '0') AS no
    FROM (SELECT nextval('inc_no_seq') AS seq) s
  `;
  return rows[0]?.no ?? '';
}

export async function nextKbNo(db: any): Promise<string> {
  const rows = await db<{ no: string }[]>`
    SELECT 'KB-' || to_char(now(), 'YYYY') || '-' ||
      lpad(seq::text, GREATEST(4, length(seq::text)), '0') AS no
    FROM (SELECT nextval('kb_no_seq') AS seq) s
  `;
  return rows[0]?.no ?? '';
}
