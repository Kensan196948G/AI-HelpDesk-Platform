import { describe, expect, it } from 'vitest';
import { filterStaff, pickUniqueEmployee } from './mirai-info.js';

describe('filterStaff', () => {
  it('DX推進部の社員だけを返す', () => {
    const rows = [
      { employeeNo: 'MK0001', name: 'A', division: '管理本部', section: 'DX推進部' },
      { employeeNo: 'MK0002', name: 'B', division: '管理本部', section: '総務部' },
      { employeeNo: 'MK0003', name: 'C', division: '東京支店', section: '工事部' },
    ];
    expect(filterStaff(rows).map((row) => row.employeeNo)).toEqual(['MK0001']);
  });

  it('DX推進部がなければ空', () => {
    expect(filterStaff([{ employeeNo: 'MK0002', name: 'B', section: '総務部' }])).toEqual([]);
  });
});

describe('pickUniqueEmployee', () => {
  const row = { employeeNo: 'MK0001', name: 'A' };

  it('1件だけなら返す', () => {
    expect(pickUniqueEmployee([row])?.employeeNo).toBe('MK0001');
  });

  it('0件なら null', () => {
    expect(pickUniqueEmployee([])).toBeNull();
  });

  it('2件以上（重複メール）は安全側で null', () => {
    expect(pickUniqueEmployee([row, { employeeNo: 'MK0002', name: 'B' }])).toBeNull();
  });
});
